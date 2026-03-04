# Stackflow x402 Client SDK Design

## Purpose

Define a practical client-side SDK for API callers consuming endpoints behind
the Stackflow x402 gateway.

This document focuses on:

1. request/response behavior for API clients (not browser UI)
2. TypeScript interfaces for an SDK package
3. operational requirements for nonce safety and retries
4. recommended server capabilities that improve client UX

## Scope

Current gateway behavior is defined by `server/src/x402-gateway.ts`:

1. protected routes require header `x-x402-payment`
2. missing/invalid payment returns HTTP `402` with machine-readable challenge
3. direct mode is verified via stackflow-node `/counterparty/transfer`
4. indirect mode is verified via forwarding payment lookup + reveal
5. proof replay is denied within TTL window

The SDK must work with this behavior first.

## Client Architecture

Runtime components in the caller:

1. `X402HttpClient`: wraps `fetch` and handles challenge/retry flow
2. `ProofProvider`: builds direct or indirect proofs
3. `NonceCoordinator`: prevents nonce collisions across concurrent requests
4. `StateStore`: persists latest known pipe nonce/balances and replay metadata
5. `SignerAdapter`: signs Stackflow structured message payloads
6. `PipeStateSource`: optional remote source (`stackflow-node /pipes`) for
   authoritative pipe state refresh

## Request Lifecycle

### Path A: Proactive Payment (preferred for API clients)

1. build direct proof before first request
2. send request with `x-x402-payment`
3. if `2xx`, update local state and return
4. if `402 payment-proof-already-used` or nonce mismatch, refresh state and
   retry with a new proof once

### Path B: Challenge-Response

1. send request without payment
2. parse `402` challenge (`payment.scheme`, required fields, amount/asset)
3. build payment proof
4. retry request once with `x-x402-payment`

## Data Types

```ts
export type X402PaymentMode = "direct" | "indirect";

export interface X402DirectProof {
  mode?: "direct";
  contractId: string;
  forPrincipal: string;
  withPrincipal: string;
  token: string | null;
  amount: string;
  myBalance: string;
  theirBalance: string;
  theirSignature: string;
  nonce: string;
  action: "1";
  actor: string;
  hashedSecret?: string | null;
  validAfter?: string | null;
  beneficialOnly?: boolean;
}

export interface X402IndirectProof {
  mode: "indirect";
  paymentId: string;
  secret: string;
  expectedFromPrincipal: string;
}

export type X402PaymentProof = X402DirectProof | X402IndirectProof;

export interface X402Challenge {
  ok: false;
  error: "payment required";
  reason: string;
  details: string;
  payment: {
    scheme: "x402-stackflow-v1";
    header: "x-x402-payment";
    amount: string;
    asset: string;
    protectedPath: string;
    modes: Record<string, unknown>;
  };
}

export interface X402ClientOptions {
  gatewayBaseUrl: string;
  proactivePayment?: boolean;
  maxPaymentAttempts?: number; // default 2
  paymentHeaderName?: string; // default "x-x402-payment"
  requestTimeoutMs?: number;
}
```

## Core SDK Interfaces

```ts
export interface ProofContext {
  method: string;
  path: string;
  query: string;
  challenge?: X402Challenge;
}

export interface ProofProvider {
  createProof(ctx: ProofContext): Promise<X402PaymentProof>;
}

export interface StateStore {
  getPipeState(key: string): Promise<PipeState | null>;
  setPipeState(key: string, next: PipeState): Promise<void>;
  markConsumedProof(proofHash: string, expiresAtMs: number): Promise<void>;
}

export interface NonceCoordinator {
  withPipeLock<T>(pipeKey: string, fn: () => Promise<T>): Promise<T>;
}

export interface SignerAdapter {
  signStructuredMessage(input: {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  }): Promise<string>;
}
```

## Reference Client Flow

```ts
async function requestWithX402(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 402) return first;

  const challenge = (await first.json()) as X402Challenge;
  const proof = await proofProvider.createProof({
    method: (init?.method || "GET").toUpperCase(),
    path: new URL(typeof input === "string" ? input : input.url).pathname,
    query: new URL(typeof input === "string" ? input : input.url).search,
    challenge,
  });

  const encoded = Buffer.from(JSON.stringify(proof)).toString("base64url");
  const retryHeaders = new Headers(init?.headers || {});
  retryHeaders.set("x-x402-payment", encoded);

  return fetch(input, { ...init, headers: retryHeaders });
}
```

## Nonce and Concurrency Rules

Direct proofs must use strictly increasing per-pipe nonce. SDK should:

1. use per-pipe lock around "read latest state -> build proof -> submit"
2. commit local nonce only after successful paid response
3. on reject (`nonce-too-low`, `payment-rejected`), refresh from source of truth
4. retry once with newer nonce

Without lock + refresh, concurrent requests will frequently collide.

## Error Model

SDK should normalize gateway outcomes:

1. `challenge_required`: 402 with valid challenge payload
2. `invalid_payment_proof`: malformed proof or schema mismatch
3. `payment_rejected`: stackflow-node rejected transfer/reveal
4. `payment_proof_replayed`: proof hash already consumed by gateway
5. `indirect_timeout`: forwarding payment not observed in time
6. `upstream_error`: payment accepted but upstream failed (`5xx`)

## Helpful Tooling for API Clients

Useful deliverables beyond the core SDK:

1. CLI: `x402-call <url> --principal ... --mode direct`
2. Local signer adapters:
   - raw private key signer (server-to-server)
   - wallet-bridge signer (interactive dev)
   - KMS/HSM signer adapter
3. Redis-backed `StateStore` + distributed lock implementation
4. metrics hooks (attempts, challenge count, payment latency, rejects by reason)

## Recommended Gateway Enhancements for Better Client UX

Current gateway works without these, but SDK simplicity improves if server adds:

1. `POST /x402/payment-intent`: return exact direct payload to sign for current
   route/method and payer principal
2. stable machine-readable error `reason` values and optional retry hints
3. optional response header exposing gateway replay TTL remaining for proof hash
4. optional quote endpoint for dynamic route pricing (`method+path+tenant`)

## Security Notes for SDK Consumers

1. treat all remote challenge fields as untrusted input
2. bind proofs to exact method/path/query requested
3. never log raw signatures/secrets in plaintext
4. persist minimal payment state; encrypt keys at rest
5. use idempotency keys on mutating API methods regardless of x402

## Implementation Plan

1. implement `packages/x402-client` with interfaces above
2. ship `fetch` middleware + in-memory state store for local dev
3. add Redis store and lock adapter for multi-instance callers
4. add integration tests against `scripts/demo-x402-e2e.js` services
