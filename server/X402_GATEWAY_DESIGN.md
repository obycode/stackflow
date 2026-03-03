# Stackflow x402 Gateway Design

## Purpose

The x402 gateway is an HTTP layer in front of an application server that:

1. challenges unpaid requests with HTTP `402 Payment Required`
2. verifies payment using Stackflow APIs
3. forwards the request upstream only after payment verification succeeds

The gateway currently supports two payment modes:

1. `direct`: immediate verification from the requestor proof
2. `indirect`: wait for a forwarded payment record and validate a reveal secret

## Scope and Status

Implementation entrypoint: `server/src/x402-gateway.ts`

Current scaffold scope:

1. one protected path (`STACKFLOW_X402_PROTECTED_PATH`)
2. one in-memory replay set keyed by `(method, path+query, proof payload hash)`
3. direct verification using `POST /counterparty/transfer`
4. indirect verification using:
   - `GET /forwarding/payments?paymentId=<id>`
   - `POST /forwarding/reveal`

## Architecture

Runtime components:

1. client (payer)
2. x402 gateway (public ingress)
3. stackflow-node (private/internal service)
4. upstream application server (private/internal service)
5. optional next-hop stackflow-node(s) for routed payments

Data/control flow:

1. client requests protected resource
2. gateway checks `x-x402-payment`
3. gateway verifies payment with stackflow-node
4. gateway marks proof as consumed (TTL window)
5. gateway proxies request to upstream app with verification headers

## Request Protocol

Protected route: request path must equal `STACKFLOW_X402_PROTECTED_PATH`.

Payment proof transport:

1. header: `x-x402-payment`
2. format: JSON string or base64url-encoded JSON

On missing/invalid proof, gateway returns:

1. status `402`
2. `WWW-Authenticate: X402 ...`
3. machine-readable JSON payload describing accepted modes and fields

## Verification Modes

### Direct Mode

Accepted proof shape:

1. `mode: "direct"` (optional; if omitted, payload is treated as direct)
2. direct transfer proof fields (`action = 1`) compatible with
   `POST /counterparty/transfer`

Verification steps:

1. parse and validate fields (`amount`, balances, nonce, signatures, etc.)
2. enforce `amount >= STACKFLOW_X402_PRICE_AMOUNT`
3. call `POST /counterparty/transfer` on stackflow-node with peer headers
4. require stackflow response `2xx` and `ok: true`
5. proxy upstream if accepted

### Indirect Mode

Accepted proof shape:

1. `mode: "indirect"`
2. `paymentId`
3. `secret` (32-byte hex preimage)
4. `expectedFromPrincipal`

Verification steps:

1. poll `GET /forwarding/payments?paymentId=...` until timeout
2. require payment exists and `status = completed`
3. require forwarding metadata indicates payer principal matches `expectedFromPrincipal`
4. require payment includes `hashedSecret`
5. call `POST /forwarding/reveal` with `{ paymentId, secret }`
6. require reveal response `2xx` and `ok: true`
7. proxy upstream if accepted

## Upstream Proxy Behavior

For verified requests, gateway forwards all non-hop-by-hop headers and adds:

1. `x-stackflow-x402-verified: true`
2. `x-stackflow-x402-proof-hash: <sha256>`

For unprotected routes, gateway proxies without requiring payment.

## Replay Handling

Replay defense is currently in-memory and process-local:

1. replay key = hash of method + path/query + normalized proof payload
2. consumed key retained for `STACKFLOW_X402_PROOF_REPLAY_TTL_MS`
3. a replayed key returns `402` with `payment-proof-already-used`

Implications:

1. restart clears consumed proof memory
2. multi-instance deployments do not share replay state by default

## Configuration

Core:

1. `STACKFLOW_X402_GATEWAY_HOST` (default `127.0.0.1`)
2. `STACKFLOW_X402_GATEWAY_PORT` (default `8790`)
3. `STACKFLOW_X402_UPSTREAM_BASE_URL` (default `http://127.0.0.1:3000`)
4. `STACKFLOW_X402_STACKFLOW_NODE_BASE_URL` (default `http://127.0.0.1:8787`)
5. `STACKFLOW_X402_PROTECTED_PATH` (default `/paid-content`)
6. `STACKFLOW_X402_PRICE_AMOUNT` (default `1000`)
7. `STACKFLOW_X402_PRICE_ASSET` (default `STX`)

Timeouts and polling:

1. `STACKFLOW_X402_STACKFLOW_TIMEOUT_MS` (default `10000`)
2. `STACKFLOW_X402_UPSTREAM_TIMEOUT_MS` (default `10000`)
3. `STACKFLOW_X402_PROOF_REPLAY_TTL_MS` (default `86400000`)
4. `STACKFLOW_X402_INDIRECT_WAIT_TIMEOUT_MS` (default `30000`)
5. `STACKFLOW_X402_INDIRECT_POLL_INTERVAL_MS` (default `1000`)

Indirect read auth:

1. `STACKFLOW_X402_STACKFLOW_ADMIN_READ_TOKEN` (optional)
2. fallback: `STACKFLOW_NODE_ADMIN_READ_TOKEN`

## Production Deployment Guidance

### Network Topology

Recommended:

1. expose only the gateway publicly
2. keep stackflow-node on private network or localhost-only bind
3. keep upstream app private behind gateway
4. keep observer endpoints restricted to trusted sources/localhost

### TLS and Ingress

1. terminate TLS at ingress or run end-to-end TLS/mTLS
2. apply standard edge protections: WAF, rate limits, request size limits
3. if behind trusted proxy chain, configure stackflow-node proxy trust carefully

### Auth and Access Separation

1. payment callers interact with gateway only
2. do not expose stackflow-node admin/sensitive endpoints directly
3. when indirect mode is used and admin-read token is set, pass token only from
   gateway to stackflow-node over trusted internal network

### Single-Instance vs Multi-Instance

Single instance is simplest and currently recommended.

For multi-instance gateway:

1. move replay state from memory to shared durable store (Redis/DB)
2. use deterministic idempotency keys across replicas
3. ensure consistent route pricing policy across replicas

### Failure Handling Policy

Define explicit external behavior for:

1. stackflow-node timeout/unavailable -> return `402` with reason
2. indirect payment wait timeout -> return `402` with timeout reason
3. upstream timeout/unavailable after payment accept -> return retriable `5xx`

## Security Considerations

1. Treat all payment proof inputs as untrusted.
2. Validate mode-specific schema before any downstream call.
3. Keep stackflow-node forwarding restrictions enabled (allowed base URLs, private-destination policy).
4. Do not log raw secrets or signatures in plaintext in production logs.
5. Bound request body size and header size at ingress.
6. Run gateway and stackflow-node with least-privilege OS/container permissions.

## Observability and Operations

Recommended telemetry:

1. counters:
   - `x402_challenge_total`
   - `x402_direct_accept_total`
   - `x402_indirect_accept_total`
   - `x402_reject_total{reason=...}`
2. latency histograms:
   - direct verification latency
   - indirect wait duration
   - upstream proxy latency
3. gauges:
   - in-memory replay set size

Recommended structured log fields:

1. `request_id`
2. `mode` (`direct|indirect`)
3. `proof_hash`
4. `payment_id` (indirect)
5. `decision` (`challenged|accepted|rejected`)
6. `reason`

## Known Limitations and Next Steps

Current limitations:

1. one protected path instead of route policy table
2. no persistent/shared replay store
3. no dynamic pricing policy per route/method/tenant
4. no settlement finality policy layer beyond stackflow-node acceptance

Planned improvements:

1. route policy config map (`method+path -> price/asset/mode policy`)
2. shared replay/idempotency backend for HA
3. richer indirect payer attestation model beyond principal equality
4. metrics and structured logging integration
5. integration tests for gateway-specific negative cases and chaos scenarios
