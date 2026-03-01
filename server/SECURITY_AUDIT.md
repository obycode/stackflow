# Stackflow Server Security Audit Tracker

Last updated: 2026-03-01

This file tracks server-side security findings, agreed requirements, and remediation status.

## Agreed Requirement (2026-03-01)

- `SFSEC-001` observer ingress restriction:
  `POST /new_block` and `POST /new_burn_block` must only accept traffic from a trusted source IP set (or optionally localhost-only mode). The expected deployment is one trusted Stacks node, often on the same machine.

## Findings

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| SFSEC-001 | Critical | In Progress | Unauthenticated observer endpoints (`/new_block`, `/new_burn_block`) can be abused to poison state and trigger dispute submissions. |
| SFSEC-002 | Critical | In Progress | SSRF risk in forwarding flow (user-controlled next-hop/upstream URLs) with downstream body reflection. |
| SFSEC-003 | High | In Progress | Unauthenticated read endpoints leak sensitive data (`/signature-states`, `/forwarding/payments`, including revealed secrets/signatures). |
| SFSEC-004 | High | In Progress | Rate limiting trusts `x-forwarded-for`, allowing spoof-based bypass and memory pressure. |
| SFSEC-005 | Medium | In Progress | Unbounded growth in persisted idempotency/payment records enables storage DoS. |
| SFSEC-006 | Medium | In Progress | Default bind to `0.0.0.0` + no built-in transport/auth hardening increases exposure risk. |
| SFSEC-007 | Low | In Progress | Dev/private key material and mnemonics are committed in repo dev files/scripts. |

## Remediation Notes

### SFSEC-001 (observer ingress restriction)

Proposed controls:

1. Add source restriction for observer routes:
   - allowlist env var for source IPs/CIDRs, and/or
   - explicit localhost-only mode.
2. Reject non-allowlisted sources before payload parsing.
3. Ensure `x-forwarded-for` is only honored when explicitly behind trusted proxy mode.
4. Add integration tests for:
   - allowed local source
   - denied non-allowlisted source
   - localhost-only mode behavior

Acceptance criteria:

- Requests to `/new_block` and `/new_burn_block` from non-allowed sources return `403`.
- Default production-safe behavior is documented.
- Tests cover positive and negative path source filtering.

Current progress (2026-03-01):

- Added observer source filtering with localhost-only default and explicit IP allowlist support.
- Added integration coverage for deny behavior and `x-forwarded-for` spoof resistance.

### SFSEC-002 (SSRF and response reflection)

Proposed controls:

1. Enforce mandatory allowlist for outgoing next-hop and upstream reveal URLs in forwarding mode.
2. Block private/link-local/loopback destinations unless explicitly allowed.
3. Stop reflecting arbitrary downstream/upstream response bodies in error payloads.

Current progress (2026-03-01):

- Enforced fixed forwarding endpoint paths (`/counterparty/transfer`, `/forwarding/reveal`).
- Added strict transfer-payload shape validation before forwarding.
- Added destination hardening that blocks non-public/private egress by default, with explicit override for local/dev.
- Removed downstream/upstream response body reflection from forwarding errors.

### SFSEC-003 (sensitive read endpoints)

Proposed controls:

1. Require auth for inspection endpoints or bind these endpoints to admin interface only.
2. Redact signatures and revealed secrets in default responses.

Current progress (2026-03-01):

- Added admin-read controls for `GET /signature-states` and `GET /forwarding/payments`:
  - optional token auth (`Authorization: Bearer` or `x-stackflow-admin-token`)
  - localhost-only access when token is unset (default enabled)
- Added default sensitive-field redaction for tokenless reads (signatures/secrets).
- Added integration coverage for token-required and redaction behavior.

### SFSEC-004 (rate limit spoofing)

Proposed controls:

1. Do not trust `x-forwarded-for` unless trusted-proxy mode is enabled.
2. Otherwise use socket source address only.

Current progress (2026-03-01):

- Rate limiting now uses socket source address by default.
- Added explicit trusted-proxy mode (`STACKFLOW_NODE_TRUST_PROXY`) to opt in to
  `x-forwarded-for` parsing only when intentionally deployed behind a trusted proxy.
- Added integration coverage for spoof-resistance when trusted-proxy mode is disabled.

### SFSEC-005 (storage DoS)

Proposed controls:

1. Add TTL and/or row caps for `idempotent_responses` and `forwarding_payments`.
2. Add periodic pruning job and metrics/logging for table growth.

Current progress (2026-03-01):

- Added idempotency retention pruning (TTL + max-row cap).
- Added forwarding retention policy to keep only the latest nonce record per
  `(contract_id, pipe_id)` in `forwarding_payments`.
- Added `revealed_secrets` table to preserve `hashed_secret -> revealed_secret`
  resolution after forwarding payment pruning.

### SFSEC-006 (network exposure defaults)

Proposed controls:

1. Use safer default bind (localhost) for local deployments.
2. Document TLS and auth requirements at ingress for non-local deployments.

Current progress (2026-03-01):

- Changed default bind host to `127.0.0.1`.
- Added startup warnings when binding to a public host without strict ingress controls.
- Added explicit public-deployment hardening guidance (TLS/auth/IP controls) in docs.

### SFSEC-007 (credential hygiene)

Proposed controls:

1. Keep fixture-only credentials clearly marked non-production.
2. Move runnable scripts to read keys from environment for non-test usage.
3. Add secret-scanning policy in CI.

Current progress (2026-03-01):

- Removed embedded runnable private keys from helper scripts; scripts now require env-provided keys.
- Marked Clarinet devnet mnemonic/key material as fixture-only and non-production.
- Added CI secret scanning workflow and repository policy configuration.
