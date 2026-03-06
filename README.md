Stackflow is a payment channel network built on Stacks that enables off-chain,
non-custodial, high-speed payments between users and is designed to be simple,
secure, and efficient. It supports payments in STX or SIP-010 fungible tokens.

> [!NOTE]
> The Stackflow trait is published by `stackflow.btc` on mainnet at
> `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-token-0-5-0` and on testnet at
> `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-token-0-5-0`.

> [!NOTE]
> The official Stackflow contract for STX is published by `stackflow.btc` on
> mainnet at `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-0-6-0` and
> on testnet at `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0`.
> Contracts for other tokens should copy this contract exactly to ensure that
> all Stackflow frontends will support it.

> [!NOTE]
> The official Stackflow contract for sBTC is published by `stackflow.btc` on
> mainnet at `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0`
> and on testnet at
> `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-sbtc-0-6-0`.

A Stacks address can open a Pipe with any other Stacks address or open a Tap to
the Reservoir by calling the Stackflow contract. In a Pipe, tokens are sent into
escrow and locked in the contract, and can only be withdrawn by the Pipe
participants. Alternatively, by opening a Tap, a user deposits tokens directly
into the contract where their balance is tracked on a shared ledger (the
Reservoir). Users can then send payments off-chain using either direct Pipes or
via the Reservoir.

In both cases, off-chain signed messages are exchanged to update balances. These
messages include a nonce to track their ordering.
[SIP-018 structured data](https://github.com/stacksgov/sips/blob/main/sips/sip-018/sip-018-signed-structured-data.md)
indicating the agreed upon balances of each participant. These signed messages
can be exchanged off-chain and only need to be submitted on-chain when closing
the Pipe, depositing additional funds to, or withdrawing funds from the Pipe.
The messages include a nonce to track their ordering. The SIP-018 domain is
bound to the specific StackFlow contract principal, so signatures are not
reusable across different StackFlow contract instances.

A Pipe can be closed cooperatively at any time, with both parties agreeing on
the final balances and signing off on the closure. If either party becomes
uncooperative or unresponsive, the Pipe can also be forcefully closed by the
other party. One party can initiate a waiting period to cancel the Pipe and
refund the latest balances recorded in the contract, or they can submit
signatures verifying an agreed upon balance. In either case, the counterparty
has 144 Bitcoin blocks (~1 day) to rebut the submitted balances by providing a
newer set of signed messages. If the closure is successfully disputed with valid
signatures, those balances are immediately paid out and the Pipe is closed. If
the deadline passes with no dispute, a final contract call triggers the payout
to both parties.

Pipes can be chained together to enable payments between users who do not have a
direct Pipe open between them. This is done by routing the payment through
intermediaries who have Pipes open with both the sender and receiver. Off-chain,
tools can find the most efficient path to route the payment. Intermediary nodes
can charge a fee for routing payments. In the case of chained Pipes, the signed
messages passed around include a requirement for a secret to unlock the funds.
This ensures that if any hop in the chain fails to send the tokens as promised,
the whole transaction can be reverted, allowing the sender and receiver to be
sure that the payment goes through completely or they get their tokens back,
even with untrusted intermediaries.

Example:

1. Alice opens a Pipe with Bob.
2. Bob opens a Pipe with Charlie.
3. Alice wants to send 10 STX to Charlie.
4. Alice sends a signed message to Bob indicating that she wants to send 10 STX
   to Charlie and is willing to pay Bob 0.1 STX for routing the payment. Alice's
   signature transferring 10.1 STX to Bob is invalid unless Bob can provide the
   secret, for which a hash was included in the structured data signed by Alice.
5. Bob sends a signed message to Charlie indicating that he wants to send him 10
   STX. Charlie is able to decrypt the secret and sends it back to Bob and the
   chain is complete.

In the above scenario, Bob cannot obtain the secret unless he sends the payment
to Charlie, so he is unable to keep the payment from Alice without sending the
payment to Charlie. Details of how this works are discussed below.

# Details

## Transfers

### Simple Transfers

To send tokens between two parties with an active Pipe open in the contract,
they simply send signatures back and forth off-chain. The signatures are signing
over structured data with the details of the Pipe:

```clarity
{
   ;; The token for which the Pipe is open
   token: (optional principal),
   ;; The first principal, ordered by the principals' consensus serialization
   principal-1: principal,
   ;; The second principal, ordered by the principals' consensus serialization
   principal-2: principal,
   ;; The balance of principal-1
   balance-1: uint,
   ;; The balance of principal-2
   balance-2: uint,
   ;; A monotonically increasing identifier for this action
   nonce: uint,
   ;; The type of action (u0 = close, u1 = transfer, u2 = deposit, u3 = withdraw)
   action: uint,
   ;; The principal initiating the action, `none` for close
   actor: (optional principal),
   ;; An optional sha256 hash of a secret, used for multi-hop transfers or
   ;; other advanced functionality
   hashed-secret: (optional (buff 32))
   ;; An optional Bitcoin block height at which this transfer becomes valid. If
   ;; set, this transfer cannot be used in `force-close` or `dispute-closure`
   ;; to validate balances until the specified block height has passed.
   valid-after: (optional uint)
}
```

In this direct transfer scenario, the `hashed-secret` is not needed, and can be
set to `none`.

When **A** wants to send to **B**, **A** builds this data structure with the
adjusted balances and the appropriate nonce, signs over it, and then sends these
in a message to **B**. **B** validates the signature, and verifies that the new
balances match an incoming transfer. If everything is correct, then **B**
responds to **A** with a signature of its own. Both parties (or a representative
thereof) should record these new signatures and balances. Future transactions
should build from these balances, and the signatures may be needed to dispute if
something goes wrong later.

### Multi-Hop Transfers

When principal **A** wants to send tokens to principal **D** using StackFlow,
first, a path from **A** to **D** is identified using existing open Pipes with
sufficient balances, for example using Dijkstra's algorithm. If a path is not
possible, then a new Pipe must be opened. Once a path is defined, **A** builds
the transfer message as described above, with the addition of a secret.

The next part of the transfer message describes what the receiver must do in
order to get the Pipe balance confirmed. For the final hop in the chain, the
target receiver of the payment will have no next hop, since at that point, the
payment is complete. For all other hops in the chain, the receiver of the
message uses the next hop to determine how to build its transfer message,
defining which principal to send to, `receiver`, how much to send, `amount`, how
much should be leftover to keep for itself as a fee, `fee`, an encrypted secret,
`secret`.

```ts
type Hop = {
  receiver: string;
  amount: bigint;
  fee: bigint;
  secret: Uint8Array;
  nextHop: Number;
};
```

The initial sender constructs an array of 8 of these `Hop` objects, encrypting
each with the public key of the intended target. If less than 8 hops are needed,
then random data is filled into the remaining slots. The sender then sends this
array, along with its signature to the first hop in the chain, along with the
index for that hop. That first hop decrypts the value at the specified hop and
uses the information within to send a signature and the array to the next hop,
along with the index for that next hop.

For the final hop in the chain, **D** in our example, the `receiver` is set to
**D** itself and the amount is set to `0`. This is the signal to **D** that it
is the final destination for this payment, so it can reply back to the previous
hop with the decrypted secret. Each hop validates, then passes this decrypted
secret back to its predecessor, eventually reaching the source and validating
the completed payment.

## Closing a Pipe

There are two ways to close a Pipe, cooperatively or forcefully. In the normal
scenario, both parties agree to close the Pipe and authorize the closure by
signing a message agreeing upon the final balances. One party calls
`close-pipe`, passing in these balances and signatures, and then the contract
pays out both parties and the Pipe is closed.

In the unfortunate scenario where one party becomes uncooperative or
unresponsive, the other party needs a way to retrieve their funds from the Pipe
unilaterally. This user has two options:

1. `force-cancel` allows the user to close the Pipe and refund the initial
   balances to both parties. This option requires no signatures, but it does
   require a waiting period, allowing the other party to dispute the closure by
   submitting signatures validating a transfer on this Pipe.
2. `force-close` allows the user to close the Pipe and return the balances
   recorded in the latest transfer on this Pipe. Arguments to this function
   include signatures from the latest transfer, along with the agreed upon
   balances at that transfer. This function also requires a waiting period,
   allowing the other party to dispute the closure by submitting a later pair of
   signatures, indicating a more recent balance agreement (one with a higher
   nonce).

During the waiting period for both of these closures, the other party may call
`dispute-closure`, passing in balances and signatures from the latest transfer.
If the signatures are confirmed, and the nonce is higher in the case of a
`force-close`, then the Pipe is immediately closed, transferring with the
balances specified to both parties.

If the closure is not disputed by the time the waiting period is over, the user
may call `finalize` to complete the closure and transfer the appropriate
balances to both parties.

# Built-in Stackflow Node Server (Event Observer)

This repo now includes a minimal stackflow-node service at `server/src/index.ts`. It
is designed to run as a Stacks-node event observer, ingest `print` events from
Stackflow contracts, store latest signed states, and auto-submit
`dispute-closure-for` when a `force-close` or `force-cancel` is observed.

Run it with:

```bash
npm run stackflow-node
```

Optional environment variables:

```bash
STACKFLOW_NODE_HOST=127.0.0.1
STACKFLOW_NODE_PORT=8787
STACKFLOW_NODE_DB_FILE=server/data/stackflow-node-state.db
STACKFLOW_NODE_MAX_RECENT_EVENTS=500
STACKFLOW_NODE_LOG_RAW_EVENTS=false
STACKFLOW_CONTRACTS=ST....stackflow-0-6-0,ST....stackflow-sbtc-0-6-0
STACKFLOW_NODE_PRINCIPALS=ST...,ST...
STACKS_NETWORK=devnet
STACKS_API_URL=http://localhost:20443
STACKFLOW_NODE_DISPUTE_SIGNER_KEY=<private-key-used-to-submit-disputes>
STACKFLOW_NODE_COUNTERPARTY_KEY=<private-key-used-to-sign-off-chain-states>
STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL=<optional principal to sign for, e.g. ST... or ST....contract>
STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE=local-key
STACKFLOW_NODE_COUNTERPARTY_KMS_KEY_ID=<aws-kms-key-id-or-arn>
STACKFLOW_NODE_COUNTERPARTY_KMS_REGION=<aws-region>
STACKFLOW_NODE_COUNTERPARTY_KMS_ENDPOINT=<optional custom endpoint, e.g. localstack>
STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION=0.6.0
STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE=readonly
STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE=auto
STACKFLOW_NODE_DISPUTE_ONLY_BENEFICIAL=false
STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE=120
STACKFLOW_NODE_TRUST_PROXY=false
STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY=true
STACKFLOW_NODE_OBSERVER_ALLOWED_IPS=127.0.0.1,192.0.2.10
STACKFLOW_NODE_ADMIN_READ_TOKEN=<optional bearer/admin token for sensitive reads>
STACKFLOW_NODE_ADMIN_READ_LOCALHOST_ONLY=true
STACKFLOW_NODE_REDACT_SENSITIVE_READ_DATA=true
STACKFLOW_NODE_FORWARDING_ENABLED=false
STACKFLOW_NODE_FORWARDING_MIN_FEE=0
STACKFLOW_NODE_FORWARDING_TIMEOUT_MS=10000
STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS=false
STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS=https://node-b.example.com,http://127.0.0.1:9797
STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_INTERVAL_MS=15000
STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS=20
```

If `STACKFLOW_CONTRACTS` is omitted, the stackflow-node automatically monitors any
contract identifier matching `*.stackflow*`.
When set, `STACKFLOW_CONTRACTS` entries are trimmed and matched case-insensitively.
The current implementation uses Node's `node:sqlite` module for persistence.
`STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE` supports `readonly` (default),
`accept-all`, and `reject-all`. Non-`readonly` modes are intended for testing.
`STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE` supports `auto` (default), `noop`, and
`mock`. `mock` is intended for local integration testing.
`STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE` supports `local-key` (default) and `kms`.
For `kms`, set `STACKFLOW_NODE_COUNTERPARTY_KMS_KEY_ID`; the server derives the signer
address from the KMS public key at startup.
KMS mode requires the AWS KMS SDK package: `npm install @aws-sdk/client-kms`.
Set `STACKFLOW_NODE_LOG_RAW_EVENTS=true` to print raw stackflow `print` event
objects received via `/new_block` for payload inspection/debugging.
`STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE` applies per-IP write limits to
`POST /signature-states`, `POST /counterparty/transfer`, and
`POST /counterparty/signature-request` (`0` disables rate limiting).
`STACKFLOW_NODE_TRUST_PROXY` defaults to `false`; when enabled, the server uses
`x-forwarded-for` for client IP extraction (rate limiting and localhost checks).
`STACKFLOW_NODE_HOST` defaults to `127.0.0.1` to reduce accidental network
exposure. Use a public bind only with hardened ingress controls.
`STACKFLOW_NODE_PORT` must be a valid TCP port (`1-65535`) and fails fast on
invalid values.
`STACKFLOW_NODE_MAX_RECENT_EVENTS` is clamped to at least `1` so event pruning
cannot be disabled accidentally via negative values.
Boolean env vars accept `true/false`, `1/0`, `yes/no`, and `on/off`
(case-insensitive); invalid boolean text now fails fast to prevent silent
misconfiguration.
Integer env vars must be plain integer text (for example `10000`, not `10s`
or `12.5`); malformed numeric values fail fast instead of being silently
coerced.
Observer ingress controls:

- `STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY` defaults to `true` and restricts
  `POST /new_block` and `POST /new_burn_block` to loopback sources.
- `STACKFLOW_NODE_OBSERVER_ALLOWED_IPS` (optional CSV) restricts observer
  routes to explicit source IPs. When set, this allowlist takes precedence
  over localhost-only mode.
Sensitive read controls:

- `STACKFLOW_NODE_ADMIN_READ_TOKEN` (optional) requires this token (via
  `Authorization: Bearer ...` or `x-stackflow-admin-token`) for
  `GET /signature-states` and `GET /forwarding/payments`.
- `STACKFLOW_NODE_ADMIN_READ_LOCALHOST_ONLY` defaults to `true`; when no
  admin token is configured, sensitive reads are limited to localhost sources.
- `STACKFLOW_NODE_REDACT_SENSITIVE_READ_DATA` defaults to `true`; without an
  admin token, signatures and revealed secrets are redacted in response bodies.
`STACKFLOW_NODE_FORWARDING_ENABLED` enables routed transfer forwarding support.
`STACKFLOW_NODE_FORWARDING_MIN_FEE` sets the minimum forwarding spread:
`incomingAmount - outgoingAmount`.
`STACKFLOW_NODE_FORWARDING_TIMEOUT_MS` controls timeout for next-hop signing calls.
`STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS` defaults to `false`; when
`false`, forwarding destinations resolving to loopback/private/link-local/non-public
IP ranges are rejected.
`STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS` (optional) restricts allowed next-hop
base URLs for forwarding.
`STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_INTERVAL_MS` controls how often pending
upstream reveal propagation retries are attempted.
`STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS` sets the maximum reveal
propagation attempts before a payment is marked `failed`.
If `STACKFLOW_NODE_PRINCIPALS` is set, the stackflow-node only:

1. accepts `POST /signature-states` for `forPrincipal` values in that list
2. processes closure events for pipes that include at least one listed principal

When `STACKFLOW_NODE_PRINCIPALS` is omitted:

1. if counterparty signing is configured (`STACKFLOW_NODE_COUNTERPARTY_KEY` or KMS), it
   watches only the derived counterparty principal
2. otherwise, it accepts any principal

Health and inspection endpoints:

1. `GET /health`
2. `GET /closures`
3. `GET /pipes?limit=100&principal=ST...`
4. `GET /signature-states?limit=100`
5. `GET /dispute-attempts?limit=100`
6. `GET /events?limit=100`
7. `GET /app` (built-in browser UI)
8. `GET /forwarding/payments?limit=100`
9. `GET /forwarding/payments?paymentId=<id>`

Sensitive inspection endpoints (`/signature-states`, `/forwarding/payments`)
return `401` when an admin token is configured but missing/invalid, and return
`403` for non-local access when tokenless localhost-only mode is active.

Public deployment hardening checklist:

1. terminate TLS at ingress (or run end-to-end TLS/mTLS)
2. require authn/authz for external callers at ingress
3. restrict observer ingress (`STACKFLOW_NODE_OBSERVER_ALLOWED_IPS` and/or localhost-only)
4. set `STACKFLOW_NODE_ADMIN_READ_TOKEN` for sensitive read endpoints
5. keep `STACKFLOW_NODE_TRUST_PROXY=false` unless behind a trusted proxy chain

Counterparty signing endpoints:

1. `POST /counterparty/transfer`
2. `POST /counterparty/signature-request`

`/counterparty/transfer` signs transfer states (`action = 1`).
`/counterparty/signature-request` signs close/deposit/withdraw states
(`action = 0|2|3`).
For `action = 2|3` (deposit/withdraw), include `amount` in the request body.
Both endpoints:

1. require peer-protocol headers:
   - `x-stackflow-protocol-version: 1`
   - `x-stackflow-request-id: <8-128 chars [a-zA-Z0-9._:-]>`
   - `idempotency-key: <8-128 chars [a-zA-Z0-9._:-]>`
2. enforce idempotency per endpoint:
   - same `idempotency-key` + same payload replays the original response
   - same `idempotency-key` + different payload returns `409` (`idempotency-key-reused`)
   - idempotency records are retention-pruned (24h TTL and capped history)
3. check local signing policy against stored state:
   - reject if nonce is not strictly higher than latest known nonce
   - reject if counterparty balance would decrease
   - for transfer (`action = 1`), require counterparty balance to strictly increase
4. verify the counterparty signature (`verify-signature-request`)
5. generate the counterparty signature
6. store the full signature pair via the existing signature-state pipeline

Responses from counterparty endpoints include:

- `protocolVersion`
- `requestId` (echoed from request header)
- `idempotencyKey` (echoed from request header)
- `processedAt` (server timestamp)

If the per-IP write limit is exceeded, these endpoints return `429` with
`reason = "rate-limit-exceeded"` and a `Retry-After` header.

Forwarding endpoint:

1. `POST /forwarding/transfer`
2. `POST /forwarding/reveal`

`/forwarding/transfer` coordinates a routed transfer by:

1. requesting a downstream signature from the configured next hop (`outgoing`)
2. signing the upstream state locally (`incoming`)
3. enforcing `incomingAmount - outgoingAmount >= STACKFLOW_NODE_FORWARDING_MIN_FEE`
4. requiring a 32-byte `hashedSecret` for lock/reveal tracking
5. persisting forwarding payment outcomes in SQLite
6. retaining only the latest nonce record per `(contractId, pipeId)` in forwarding history

Request body shape:

```json
{
  "paymentId": "pay-2026-02-28-0001",
  "incomingAmount": "1000",
  "outgoingAmount": "950",
  "hashedSecret": "0x...",
  "upstream": {
    "baseUrl": "http://127.0.0.1:8787",
    "paymentId": "upstream-pay-0001",
    "revealEndpoint": "/forwarding/reveal"
  },
  "incoming": { "...": "same payload as /counterparty/transfer" },
  "outgoing": {
    "baseUrl": "http://127.0.0.1:9797",
    "endpoint": "/counterparty/transfer",
    "payload": { "...": "payload sent to next hop counterparty endpoint" }
  }
}
```

`POST /forwarding/transfer` requires the same peer protocol headers as
counterparty endpoints.
For SSRF hardening, only these forwarding API paths are supported:

- downstream next-hop endpoint: `/counterparty/transfer`
- upstream reveal endpoint: `/forwarding/reveal`

Custom endpoint paths are rejected.

`POST /forwarding/reveal` request body:

```json
{
  "paymentId": "pay-2026-02-28-0001",
  "secret": "0x...32-byte-preimage"
}
```

The server checks `sha256(secret) == hashedSecret` for that payment and stores
the revealed secret for later dispute/finality workflows.
If an `upstream` route is stored on that payment, the server immediately tries
to propagate the reveal upstream and persists retry state in SQLite:

1. `revealPropagationStatus = pending|propagated|failed|not-applicable`
2. `revealPropagationAttempts` increments on each upstream attempt
3. `revealNextRetryAt` schedules the next retry timestamp for pending records
4. background retries resume automatically on process restart

Forwarding retention notes:

1. forwarding payment history keeps only the latest nonce entry per pipe
2. older nonce entries are pruned once newer nonce data is stored for that pipe
3. revealed-secret resolution is retained separately for dispute/recovery lookups

Counterparty signature verification uses `verify-signature` for transfer actions
and `verify-signature-request` for close/deposit/withdraw actions, preserving
on-chain validation semantics for each action type.

Signature state ingestion endpoint:

1. `POST /signature-states`

Example payload:

```json
{
  "contractId": "ST....stackflow-0-6-0",
  "forPrincipal": "ST...",
  "withPrincipal": "ST...",
  "token": null,
  "myBalance": "900000",
  "theirBalance": "100000",
  "mySignature": "0x...",
  "theirSignature": "0x...",
  "nonce": "42",
  "action": "1",
  "actor": "ST...",
  "secret": null,
  "validAfter": null,
  "beneficialOnly": false
}
```

The stackflow-node stores one latest state per `(contract, pipe, forPrincipal)`,
replacing only when the incoming nonce is strictly greater.
Before storing, the stackflow-node verifies signatures by calling the Stackflow
contract read-only function `verify-signatures`. If validation fails, the
request returns `401` and nothing is stored.
If the incoming nonce is not strictly higher than the stored nonce for that
`(contract, pipe, forPrincipal)`, the request returns `409`.
If `forPrincipal` is not in the effective watchlist, the request returns `403`.
If the per-IP write limit is exceeded, the request returns `429`.

On-chain pipe tracking:

1. `POST /new_block` print events update a persistent `pipes` view
2. events such as `fund-pipe`, `deposit`, `withdraw`, `force-cancel`, and
   `force-close` upsert current pipe balances
3. terminal events (`close-pipe`, `dispute-closure`, `finalize`) reset tracked
   balances to `0` and clear pending values
4. `POST /new_burn_block` advances pending deposits into confirmed balances
   once pending `burn-height` is reached
5. `GET /pipes` merges this on-chain view with stored signature states and
   returns the authoritative state per pipe by highest nonce (ties prefer
   newer timestamps, then on-chain source)

Event observer ingestion endpoint:

1. `POST /new_block`
2. `POST /new_burn_block`

When Clarinet/stacks-node observer config uses `events_keys = ["*"]`, stacks-node
can also call additional observer endpoints. The stackflow-node responds `200` (no-op)
for compatibility on:

1. `POST /new_mempool_tx`
2. `POST /drop_mempool_tx`
3. `POST /new_microblocks`

For Clarinet devnet, set the observer in `settings/Devnet.toml`:

```toml
[devnet]
stacks_node_events_observers = ["host.docker.internal:8787"]
```

Devnet contracts and initialization plan:

1. deployment plan: `deployments/default.devnet-plan.yaml` (publishes `stackflow` and `stackflow-sbtc`)
2. the same devnet plan also runs post-deploy `init` contract calls:
   - `stackflow` with `none` token (STX mode)
   - `stackflow-sbtc` with `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token`
3. optional/manual fallback: `./init-stackflow.sh`
4. full plan details: `deployments/DEVNET_STACKFLOW_SBTC_PLAN.md`

Open the built-in UI in your browser:

```text
http://localhost:8787/app
```

The UI lets you:

1. connect a Stacks wallet
2. load watched pipes from on-chain observer state (`GET /pipes`)
3. generate SIP-018 structured signatures for Stackflow state
4. submit signature states to `POST /signature-states`
5. call Stackflow contract methods (`fund-pipe`, `deposit`, `withdraw`,
   `force-cancel`, `force-close`, `close-pipe`, `finalize`) via wallet popup

## x402 Gateway Scaffold

This repo includes a starter x402-style gateway at
`server/src/x402-gateway.ts`. It sits in front of your app server and:

1. protects one route (`STACKFLOW_X402_PROTECTED_PATH`, default `/paid-content`)
2. returns `402` when no payment proof is provided
3. supports two payment modes:
   - `direct`: verifies payment immediately via `POST /counterparty/transfer`
   - `indirect`: waits for forwarded payment arrival, checks who paid, then
     verifies the provided secret via `POST /forwarding/reveal`
4. proxies the request to your upstream app only after verification succeeds

Detailed technical design and production guidance:

- `server/X402_GATEWAY_DESIGN.md`
- `server/X402_CLIENT_SDK_DESIGN.md`
- `packages/x402-client/` (SDK scaffold with SQLite-backed client state store)
- `server/STACKFLOW_AGENT_DESIGN.md` (simple agent runtime without local node)

Run it with:

```bash
npm run x402-gateway
```

Run a full local end-to-end demo (unpaid + direct + indirect):

```bash
npm run demo:x402-e2e
```

The demo script starts:

1. stackflow-node (`accept-all` verifier, forwarding enabled)
2. x402 gateway
3. mock upstream app
4. mock forwarding next-hop

Then it automatically exercises:

1. unpaid request -> `402`
2. direct payment proof -> payload delivered
3. indirect payment signal (wait for forwarding payment + reveal) -> payload delivered

Run an interactive browser demo (click link -> `402` -> sign -> unlock):

```bash
npm run demo:x402-browser
```

## Pipe Console (GitHub Pages)

This repo now includes a static pipe interaction page at `docs/`:

- `docs/index.html`
- `docs/app.js`
- `docs/styles.css`

It includes forms/buttons for:

1. wallet connect
2. read-only `get-pipe`
3. `fund-pipe` (open pipe)
4. `force-cancel`
5. structured transfer message signing + payload JSON builder
6. principal resolution for `.btc` names (for example `brice.btc`) via BNSv2 API
7. network-aware preset Stackflow contract selection with token auto-fill:
   - devnet: `ST1...stackflow` and `ST1...stackflow-sbtc`
   - mainnet: official `stackflow-0-6-0` and `stackflow-sbtc-0-6-0`

To publish with GitHub Pages (no build step):

1. go to repository Settings -> Pages
2. Source: GitHub Actions
3. push changes to `docs/` on `main` (or run `Deploy Pipe Console` manually)
4. wait for the `Deploy Pipe Console` workflow to publish

Browser demo flow:

1. open the printed local URL (gateway front door)
2. click `Read premium story`
3. gateway returns `402 Payment Required`
4. demo queries `stackflow-node /pipes` for pipe status:
   - if no open pipe, prompt `Open Pipe` (wallet `fund-pipe`) first
   - if pipe is observer-confirmed and spendable, prompt `Sign and Pay` (`stx_signStructuredMessage`)
5. browser retries with `x-x402-payment`
6. gateway verifies payment with stackflow-node and returns paywalled content

Notes about the browser demo:

1. Network/contract selection is loaded from `demo/x402-browser/config.json`
   (or `DEMO_X402_CONFIG_FILE`) rather than editable in the browser UI.
2. The demo starts stackflow-node in `accept-all` signature verification mode
   for local UX walkthrough.
3. Pipe readiness checks are routed through stackflow-node (`GET /pipes`) via
   demo endpoints (`/demo/pipe-status`).
4. `Open Pipe` does not fake state. It waits for real observer updates from
   stacks-node into stackflow-node.
5. If the connected wallet is the same principal as the server counterparty,
   the demo returns a clear `409` and asks you to switch accounts.
6. Browser-demo network/contract/node settings are defined in
   `demo/x402-browser/config.json`. Predefine your stacks-node observer using:
   `stacks_node_events_observers = ["host:port"]` matching
   `stacksNodeEventsObserver` in that file.
7. Browser-demo starts stackflow-node with `STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE=auto`.
   It uses `DEMO_X402_DISPUTE_SIGNER_KEY` if provided.
   On `devnet`, if unset, it defaults to Clarinet `wallet_1` fixture key.
   On other networks, if unset, it reuses `DEMO_X402_COUNTERPARTY_KEY`.
8. Child process logs are streamed by default (`DEMO_X402_SHOW_CHILD_LOGS=true`).
   Set `DEMO_X402_SHOW_CHILD_LOGS=false` to silence stackflow-node/gateway logs.

Example browser demo config:

```json
{
  "stacksNetwork": "devnet",
  "stacksApiUrl": "http://127.0.0.1:20443",
  "contractId": "ST1...stackflow",
  "priceAmount": "10",
  "priceAsset": "STX",
  "openPipeAmount": "1000",
  "stackflowNodeHost": "127.0.0.1",
  "stackflowNodePort": 8787,
  "stacksNodeEventsObserver": "host.docker.internal:8787",
  "observerLocalhostOnly": false,
  "observerAllowedIps": []
}
```

Gateway environment variables:

```bash
STACKFLOW_X402_GATEWAY_HOST=127.0.0.1
STACKFLOW_X402_GATEWAY_PORT=8790
STACKFLOW_X402_UPSTREAM_BASE_URL=http://127.0.0.1:3000
STACKFLOW_X402_STACKFLOW_NODE_BASE_URL=http://127.0.0.1:8787
STACKFLOW_X402_PROTECTED_PATH=/paid-content
STACKFLOW_X402_PRICE_AMOUNT=1000
STACKFLOW_X402_PRICE_ASSET=STX
STACKFLOW_X402_STACKFLOW_TIMEOUT_MS=10000
STACKFLOW_X402_UPSTREAM_TIMEOUT_MS=10000
STACKFLOW_X402_PROOF_REPLAY_TTL_MS=86400000
STACKFLOW_X402_INDIRECT_WAIT_TIMEOUT_MS=30000
STACKFLOW_X402_INDIRECT_POLL_INTERVAL_MS=1000
STACKFLOW_X402_STACKFLOW_ADMIN_READ_TOKEN=<optional token for GET /forwarding/payments>
```

The client supplies `x-x402-payment` containing JSON (or base64url-encoded JSON)
for one of these modes:

1. `direct` payment proof (`action = 1`) including:

- `contractId`
- `forPrincipal`
- `withPrincipal`
- `amount` (must be `>= STACKFLOW_X402_PRICE_AMOUNT`)
- `myBalance`
- `theirBalance`
- `theirSignature`
- `nonce`
- `actor`

2. `indirect` payment signal including:

- `mode: "indirect"`
- `paymentId` (forwarding payment id to wait for)
- `secret` (32-byte hex preimage)
- `expectedFromPrincipal` (immediate payer principal expected by receiver)

Example flow (direct):

```bash
# 1) Unpaid request gets 402 challenge
curl -i http://127.0.0.1:8790/paid-content

# 2) Build proof header from a local JSON file
PAYMENT_PROOF=$(node -e "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync('proof.json','utf8'));process.stdout.write(Buffer.from(JSON.stringify(v)).toString('base64url'));")

# 3) Paid request is verified by stackflow-node then proxied upstream
curl -i \
  -H "x-x402-payment: ${PAYMENT_PROOF}" \
  http://127.0.0.1:8790/paid-content
```

Example flow (indirect):

```bash
INDIRECT_PROOF=$(node -e "const v={mode:'indirect',paymentId:'pay-2026-03-01-0001',secret:'0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',expectedFromPrincipal:'ST2...'};process.stdout.write(Buffer.from(JSON.stringify(v)).toString('base64url'));")

curl -i \
  -H "x-x402-payment: ${INDIRECT_PROOF}" \
  http://127.0.0.1:8790/paid-content
```

Current scaffold scope:

1. supports direct and indirect receive-side verification
2. one-time proof consumption per method/path within replay TTL
3. single protected route configuration (expand to route policy map as next step)

## Agent Scaffold

This repo includes an agent-first Stackflow scaffold at
`packages/stackflow-agent/` for deployments that do not run local
`stacks-node`/`stackflow-node`.

It provides:

1. SQLite persistence for tracked pipes and latest signatures
2. AIBTC MCP wallet adapter hooks for `sip018_sign`, `call_contract`, and
   read-only `get-pipe`
3. hourly closure watcher (default `60 * 60 * 1000`) that polls tracked pipes
   via read-only `get-pipe` and can auto-submit
   disputes when a newer beneficial local signature state exists

See:

1. `packages/stackflow-agent/README.md`
2. `server/STACKFLOW_AGENT_DESIGN.md`

## Testing commands

Use these commands depending on what changed:

1. Full project checks (Clarity + Node suites):

```bash
npm test
```

2. Clarity contract tests only:

```bash
npm run test:clarity
```

3. Node/agent/x402 suites only:

```bash
npm run test:node
```

Integration tests for the HTTP server are opt-in (they spawn a real process and
bind a local port):

```bash
npm run test:stackflow-node:http
```

# Reference Server Implementation

As discussed in the details, users of Stackflow should run a server to keep
track of balances and signatures for its open Pipes, and to receive messages
from its counterparts in those Pipes. A reference implementation of this server
is provided in https://github.com/obycode/stackflow-server. This server consists
of the backend for managing these details, as well as a frontend to provide a
simple interface for opening Pipes and interacting with existing Pipes.
