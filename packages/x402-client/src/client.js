import { computeProofHash } from "./sqlite-state-store.js";

const DEFAULT_PAYMENT_HEADER = "x-x402-payment";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("gatewayBaseUrl is required");
  }
  const parsed = new URL(text);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeInt(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function resolveRequestUrl(input, gatewayBaseUrl) {
  if (input instanceof URL) {
    return input;
  }
  return new URL(String(input), gatewayBaseUrl);
}

function encodeProofHeader(proof) {
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}

function cloneHeaders(headersLike) {
  return new Headers(headersLike || {});
}

function ensureRetryableBody(init) {
  const body = init?.body;
  if (!body) {
    return;
  }
  if (typeof body === "string" || body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return;
  }
  if (body instanceof URLSearchParams || body instanceof FormData || body instanceof Blob) {
    return;
  }
  if (typeof body === "object" && typeof body.getReader === "function") {
    throw new Error(
      "request body is a stream and cannot be retried automatically; pass a replayable body",
    );
  }
}

export async function parseX402Challenge(response) {
  if (!(response instanceof Response) || response.status !== 402) {
    return null;
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.payment)) {
    return null;
  }
  if (body.error !== "payment required") {
    return null;
  }
  return body;
}

export class X402Client {
  constructor({
    gatewayBaseUrl,
    proofProvider,
    stateStore = null,
    pipeStateSource = null,
    fetchFn = globalThis.fetch?.bind(globalThis),
    proactivePayment = false,
    maxPaymentAttempts = 2,
    paymentHeaderName = DEFAULT_PAYMENT_HEADER,
    localReplayTtlMs = 60_000,
    onEvent = null,
  }) {
    this.gatewayBaseUrl = normalizeBaseUrl(gatewayBaseUrl);
    this.proofProvider = proofProvider ?? null;
    this.stateStore = stateStore;
    this.pipeStateSource = pipeStateSource;
    this.fetchFn = fetchFn;
    this.proactivePayment = Boolean(proactivePayment);
    this.maxPaymentAttempts = normalizeInt(
      maxPaymentAttempts,
      2,
      "maxPaymentAttempts",
    );
    this.paymentHeaderName = String(paymentHeaderName || DEFAULT_PAYMENT_HEADER).trim();
    if (!this.paymentHeaderName) {
      throw new Error("paymentHeaderName must not be empty");
    }
    this.localReplayTtlMs = normalizeInt(localReplayTtlMs, 60_000, "localReplayTtlMs");
    this.onEvent = typeof onEvent === "function" ? onEvent : null;

    if (typeof this.fetchFn !== "function") {
      throw new Error("fetchFn is required");
    }
  }

  emitEvent(event) {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event);
    } catch {
      // Event hooks must never break request flow.
    }
  }

  async request(input, init = {}) {
    ensureRetryableBody(init);
    const url = resolveRequestUrl(input, this.gatewayBaseUrl);
    const method = String(init.method || "GET").toUpperCase();
    const pathQuery = `${url.pathname}${url.search}`;

    let challenge = null;
    let paymentAttempts = 0;
    let attemptedWithoutPayment = false;

    while (true) {
      const shouldAttachProof =
        challenge !== null ||
        (this.proactivePayment && paymentAttempts < this.maxPaymentAttempts);

      let proof = null;
      let proofHash = null;
      const headers = cloneHeaders(init.headers);

      if (shouldAttachProof) {
        if (!this.proofProvider || typeof this.proofProvider.createProof !== "function") {
          throw new Error("proofProvider.createProof is required for paid requests");
        }

        proof = await this.proofProvider.createProof({
          method,
          url,
          path: url.pathname,
          query: url.search,
          challenge,
          paymentAttempt: paymentAttempts + 1,
          paymentHeaderName: this.paymentHeaderName,
          stateStore: this.stateStore,
          pipeStateSource: this.pipeStateSource,
        });
        paymentAttempts += 1;

        proofHash = computeProofHash({ method, pathQuery, proof });
        if (this.stateStore?.isProofConsumed?.(proofHash)) {
          this.emitEvent({
            type: "proof-skip-local-replay",
            proofHash,
            method,
            pathQuery,
          });
          continue;
        }

        headers.set(this.paymentHeaderName, encodeProofHeader(proof));
      } else {
        attemptedWithoutPayment = true;
      }

      const response = await this.fetchFn(url.toString(), {
        ...init,
        headers,
      });

      if (response.status !== 402) {
        if (
          proofHash &&
          this.stateStore?.markConsumedProof &&
          response.status >= 200 &&
          response.status < 300
        ) {
          this.stateStore.markConsumedProof(
            proofHash,
            Date.now() + this.localReplayTtlMs,
          );
        }
        this.emitEvent({
          type: "request-complete",
          status: response.status,
          method,
          pathQuery,
          paid: Boolean(proof),
        });
        return response;
      }

      const parsedChallenge = await parseX402Challenge(response.clone());
      if (!parsedChallenge) {
        this.emitEvent({
          type: "challenge-unparseable",
          status: response.status,
          method,
          pathQuery,
        });
        return response;
      }
      challenge = parsedChallenge;
      this.emitEvent({
        type: "challenge-received",
        reason: challenge.reason,
        method,
        pathQuery,
      });

      const hasProvider = Boolean(
        this.proofProvider && typeof this.proofProvider.createProof === "function",
      );
      if (!hasProvider) {
        return response;
      }
      if (paymentAttempts >= this.maxPaymentAttempts) {
        return response;
      }
      if (!attemptedWithoutPayment && !this.proactivePayment) {
        attemptedWithoutPayment = true;
      }
    }
  }
}
