# Stackflow Node Server Design

## Purpose

The stackflow-node server protects users from stale channel closures by:

1. Accepting and persisting the latest valid signed state for watched users.
2. Listening to Stackflow `print` events from a Stacks node observer (`POST /new_block`).
3. Submitting `dispute-closure-for` when a fresher state is available.

## Architecture

- `src/index.ts`
  - HTTP API, built-in UI static file serving, and dependency wiring.
- `src/stackflow-node.ts`
  - Core decision engine and state transitions.
- `src/observer-parser.ts`
  - Normalizes observer payloads into Stackflow events.
- `src/signature-verifier.ts`
  - Read-only on-chain signature validation.
- `src/dispute-executor.ts`
  - Broadcasts disputes on-chain.
- `src/state-store.ts`
  - SQLite persistence layer.

## Persistence (SQLite)

State is persisted in SQLite:

- Default: `server/data/stackflow-node-state.db`
- Config: `STACKFLOW_NODE_DB_FILE`

### SQLite settings

On startup the store configures:

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA foreign_keys = ON`

### Schema

- `meta(key PRIMARY KEY, value)`
  - `version`
  - `updated_at`
- `closures(pipe_id PRIMARY KEY, ...)`
- `signature_states(state_id PRIMARY KEY, ...)`
  - Index: `(contract_id, pipe_id)`
- `dispute_attempts(attempt_id PRIMARY KEY, ...)`
  - Index: `created_at DESC`
- `recent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_json, observed_at)`

### Logical keys

- `pipeId = "<token-or-stx>|<principal-1>|<principal-2>"`
- `stateId = "<contractId>|<pipeId>|<forPrincipal>"`
- `attemptId = "<triggerTxid-or-fallback>|<forPrincipal>"`

### Data lifecycle

- Every write updates `meta.updated_at`.
- `recent_events` is capped by `STACKFLOW_NODE_MAX_RECENT_EVENTS` (default `500`).
- `recent_events` is pruned after each insert.

## API

### Write endpoints

- `POST /new_block`
  - Observer payload ingestion.
- `POST /new_burn_block`
- `POST /new_mempool_tx`
- `POST /drop_mempool_tx`
- `POST /new_microblocks`
  - Stacks-node observer compatibility endpoints. They are accepted and ignored.
- `POST /signature-states`
  - Off-chain state submission.
- `POST /counterparty/transfer`
  - Counterparty-mode transfer signing (`action=1`).
- `POST /counterparty/signature-request`
  - Counterparty-mode close/deposit/withdraw signing (`action=0|2|3`).
  - For `action=2|3`, request payload must include `amount`.

Counterparty-mode endpoints apply local policy before signing:

- Reject if requested nonce is not strictly higher than latest known nonce.
- Reject if counterparty balance would decrease.
- For transfer requests (`action=1`), require counterparty balance to strictly increase
  and preserve total channel balance.
- Counterparty signatures are validated via on-chain read-only
  `verify-signature-request`, including action-aware amount checks.

### Read endpoints

- `GET /health`
- `GET /closures`
- `GET /signature-states?limit=100`
- `GET /dispute-attempts?limit=100`
- `GET /events?limit=100`
- `GET /app`
  - Browser UI for wallet connect, watched-pipe view, signature generation, and contract actions.

### Status semantics

`POST /signature-states`:

- `200`: accepted
- `401`: signature validation failed
- `403`: `forPrincipal` not in watch allowlist
- `400`: malformed input

## Ingestion and Decision Flow

1. Receive observer payload on `POST /new_block`.
2. Parse only Stackflow `print` events.
3. Apply contract filter:
   - explicit `STACKFLOW_CONTRACTS`, or
   - default `*.stackflow*` matcher.
4. Apply principal scope filter (`STACKFLOW_NODE_PRINCIPALS`) if configured.
5. Record event in `recent_events`.
6. Update closure state:
   - open: `force-close`, `force-cancel`
   - terminal: `close-pipe`, `dispute-closure`, `finalize`
7. On open closure, attempt dispute if enabled and eligible.

## Signature State Acceptance

For `POST /signature-states`:

1. Parse and validate all fields (principal/uint/hex sizes).
2. Enforce watched principal allowlist on `forPrincipal`.
3. Validate signatures via contract read-only `verify-signatures`.
4. Canonicalize pipe key principal ordering.
5. Upsert only if incoming nonce is not lower than existing nonce.

## Dispute Eligibility

Candidate state must satisfy:

- Same `(contractId, pipeId)`.
- `state.forPrincipal !== closer`.
- `state.nonce > closure.nonce`.
- `state.validAfter <= blockHeight` if `validAfter` exists.
- If beneficial policy is active:
  - `state.myBalance > closure-side-balance`.

Deduping:

- A successful `attemptId` is not re-submitted.

## Config

- `STACKFLOW_NODE_HOST`, `STACKFLOW_NODE_PORT`
- `STACKFLOW_NODE_DB_FILE`
- `STACKFLOW_NODE_MAX_RECENT_EVENTS`
- `STACKFLOW_CONTRACTS`
- `STACKFLOW_NODE_PRINCIPALS` (CSV allowlist, max 100)
- `STACKS_NETWORK`
- `STACKS_API_URL`
- `STACKFLOW_NODE_DISPUTE_SIGNER_KEY`
- `STACKFLOW_NODE_COUNTERPARTY_KEY`
- `STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL`
- `STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE` (`local-key|kms`)
- `STACKFLOW_NODE_COUNTERPARTY_KMS_KEY_ID`
- `STACKFLOW_NODE_COUNTERPARTY_KMS_REGION`
- `STACKFLOW_NODE_COUNTERPARTY_KMS_ENDPOINT`
- `STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION`
- `STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE` (`readonly|accept-all|reject-all`)
- `STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE` (`auto|noop|mock`)
- `STACKFLOW_NODE_DISPUTE_ONLY_BENEFICIAL`

## Production Notes

- SQLite provides transactional durability and better recovery than JSON file snapshots.
- WAL mode improves write reliability and read concurrency for status endpoints.
- This implementation uses `node:sqlite`; on current Node versions it may emit an experimental warning.
- For HA/multi-instance operation, run a single active dispute writer or add leader coordination.
