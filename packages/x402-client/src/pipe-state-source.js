import { buildPipeStateKey } from "./sqlite-state-store.js";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertPrincipal(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty principal`);
  }
  return text;
}

function assertContractId(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text || !text.includes(".")) {
    throw new Error(`${fieldName} must be a contract id`);
  }
  return text;
}

function normalizeBaseUrl(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  const parsed = new URL(text);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function parsePositiveInt(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseUnsignedBigInt(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function selectBestPipeFromNode({
  pipes,
  principal,
  counterpartyPrincipal,
  contractId,
}) {
  if (!Array.isArray(pipes)) {
    return null;
  }

  let best = null;
  let bestNonce = -1n;
  let bestUpdatedAt = "";

  for (const candidate of pipes) {
    if (!isRecord(candidate) || candidate.contractId !== contractId) {
      continue;
    }
    const pipeKey = isRecord(candidate.pipeKey) ? candidate.pipeKey : null;
    if (!pipeKey) {
      continue;
    }
    const principal1 =
      typeof pipeKey["principal-1"] === "string" ? pipeKey["principal-1"] : null;
    const principal2 =
      typeof pipeKey["principal-2"] === "string" ? pipeKey["principal-2"] : null;
    if (!principal1 || !principal2) {
      continue;
    }
    const samePair =
      (principal1 === principal && principal2 === counterpartyPrincipal) ||
      (principal1 === counterpartyPrincipal && principal2 === principal);
    if (!samePair) {
      continue;
    }

    const nonce =
      parseUnsignedBigInt(
        typeof candidate.nonce === "string" ? candidate.nonce : "0",
      ) ?? 0n;
    const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : "";
    if (!best || nonce > bestNonce || (nonce === bestNonce && updatedAt > bestUpdatedAt)) {
      best = candidate;
      bestNonce = nonce;
      bestUpdatedAt = updatedAt;
    }
  }

  return best;
}

export function toPipeStatusFromObservedPipe({
  pipe,
  principal,
}) {
  if (!isRecord(pipe)) {
    return {
      hasPipe: false,
      canPay: false,
      myConfirmed: "0",
      myPending: "0",
      theirConfirmed: "0",
      theirPending: "0",
      nonce: "0",
      source: null,
      event: null,
      updatedAt: null,
      contractId: null,
      token: null,
      forPrincipal: null,
      withPrincipal: null,
      pipeKey: null,
    };
  }

  const pipeKey = isRecord(pipe.pipeKey) ? pipe.pipeKey : null;
  const principal1 = pipeKey && typeof pipeKey["principal-1"] === "string"
    ? pipeKey["principal-1"]
    : null;
  const principal2 = pipeKey && typeof pipeKey["principal-2"] === "string"
    ? pipeKey["principal-2"]
    : null;
  const token = pipeKey && typeof pipeKey.token === "string" ? pipeKey.token : null;
  const useBalance1 = principal1 === principal;

  const balance1 = parseUnsignedBigInt(String(pipe.balance1 ?? "0")) ?? 0n;
  const balance2 = parseUnsignedBigInt(String(pipe.balance2 ?? "0")) ?? 0n;
  const pending1 = parseUnsignedBigInt(String(pipe.pending1Amount ?? "0")) ?? 0n;
  const pending2 = parseUnsignedBigInt(String(pipe.pending2Amount ?? "0")) ?? 0n;
  const myConfirmed = useBalance1 ? balance1 : balance2;
  const myPending = useBalance1 ? pending1 : pending2;
  const theirConfirmed = useBalance1 ? balance2 : balance1;
  const theirPending = useBalance1 ? pending2 : pending1;
  const forPrincipal = principal;
  const withPrincipal = principal1 === principal ? principal2 : principal1;

  return {
    hasPipe: Boolean(principal1 && principal2),
    canPay: myConfirmed > 0n,
    myConfirmed: myConfirmed.toString(10),
    myPending: myPending.toString(10),
    theirConfirmed: theirConfirmed.toString(10),
    theirPending: theirPending.toString(10),
    nonce: (parseUnsignedBigInt(String(pipe.nonce ?? "0")) ?? 0n).toString(10),
    source: typeof pipe.source === "string" ? pipe.source : null,
    event: typeof pipe.event === "string" ? pipe.event : null,
    updatedAt: typeof pipe.updatedAt === "string" ? pipe.updatedAt : null,
    contractId: typeof pipe.contractId === "string" ? pipe.contractId : null,
    token,
    forPrincipal: forPrincipal || null,
    withPrincipal: withPrincipal || null,
    pipeKey: pipeKey || null,
  };
}

export class StackflowNodePipeStateSource {
  constructor({
    stackflowNodeBaseUrl,
    fetchFn = globalThis.fetch?.bind(globalThis),
    timeoutMs = 10_000,
    pipesLimit = 200,
  }) {
    this.stackflowNodeBaseUrl = normalizeBaseUrl(
      stackflowNodeBaseUrl,
      "stackflowNodeBaseUrl",
    );
    this.fetchFn = fetchFn;
    this.timeoutMs = parsePositiveInt(timeoutMs, 10_000, "timeoutMs");
    this.pipesLimit = parsePositiveInt(pipesLimit, 200, "pipesLimit");
    if (typeof this.fetchFn !== "function") {
      throw new Error("fetchFn is required");
    }
  }

  async getPipeStatus({
    principal,
    counterpartyPrincipal,
    contractId,
  }) {
    const normalizedPrincipal = assertPrincipal(principal, "principal");
    const normalizedCounterparty = assertPrincipal(
      counterpartyPrincipal,
      "counterpartyPrincipal",
    );
    const normalizedContract = assertContractId(contractId, "contractId");
    const query = new URLSearchParams({
      principal: normalizedPrincipal,
      limit: String(this.pipesLimit),
    });

    const response = await this.fetchFn(
      `${this.stackflowNodeBaseUrl}/pipes?${query.toString()}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    let body = null;
    try {
      body = await response.json();
    } catch {
      throw new Error(`stackflow-node /pipes returned non-JSON (status=${response.status})`);
    }

    if (!response.ok || !isRecord(body)) {
      throw new Error(`stackflow-node /pipes request failed (status=${response.status})`);
    }
    const selectedPipe = selectBestPipeFromNode({
      pipes: body.pipes,
      principal: normalizedPrincipal,
      counterpartyPrincipal: normalizedCounterparty,
      contractId: normalizedContract,
    });
    return toPipeStatusFromObservedPipe({
      pipe: selectedPipe,
      principal: normalizedPrincipal,
    });
  }

  async syncPipeState({
    principal,
    counterpartyPrincipal,
    contractId,
    stateStore,
  }) {
    const status = await this.getPipeStatus({
      principal,
      counterpartyPrincipal,
      contractId,
    });

    if (!status.hasPipe || !stateStore || typeof stateStore.setPipeState !== "function") {
      return status;
    }
    const pipeKey = buildPipeStateKey({
      contractId: status.contractId,
      forPrincipal: status.forPrincipal,
      withPrincipal: status.withPrincipal,
      token: status.token,
    });
    stateStore.setPipeState({
      pipeKey,
      contractId: status.contractId,
      forPrincipal: status.forPrincipal,
      withPrincipal: status.withPrincipal,
      token: status.token,
      nonce: status.nonce,
      myBalance: status.myConfirmed,
      theirBalance: status.theirConfirmed,
    });
    return status;
  }
}
