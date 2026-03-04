# Stackflow Agent Design

## Goal

Provide a minimal agent-friendly Stackflow runtime that does not require local
`stacks-node` or `stackflow-node`.

Current constraints:

1. local SQLite state only
2. AIBTC wallet-based transaction signing
3. periodic chain watcher every hour
4. auto-dispute closures when local signatures are newer and beneficial

## Required Capabilities

Agent runtime should implement:

1. open a new pipe
2. generate/validate transfer messages
3. sign transfer messages with policy checks
4. persist per-pipe state:
   - nonce
   - balances
   - latest signatures
5. poll chain and dispute `force-cancel`/`force-close` when eligible

Concrete service operations in scaffold:

1. `trackPipe`
2. `recordSignedState`
3. `buildOutgoingTransfer`
4. `validateIncomingTransfer`
5. `acceptIncomingTransfer`
6. `disputeClosure`

## Missing-but-Important Items

Include:

1. per-pipe mutex/lock when generating outgoing nonces
2. idempotency for inbound/outbound transfer requests
3. signer fee-balance checks and alerting
4. watcher cursor persistence and crash-safe resume
5. audit log of sign/reject/dispute decisions

## Architecture

1. `AgentStateStore` (SQLite)
2. `StackflowAgentService` (business logic)
3. `AibtcWalletAdapter` (MCP tool bridge)
4. `AibtcPipeStateSource` (read-only `get-pipe` polling)
5. `HourlyClosureWatcher` (default interval: 1 hour)

## Data Model (SQLite)

1. `tracked_pipes`
2. `signature_states`
3. `closures`
4. `watcher_cursor`

## Watcher Policy

1. schedule every hour (`60 * 60 * 1000`)
2. list tracked pipes from local SQLite
3. for each tracked pipe, call Stackflow read-only `get-pipe`
4. if `closer` is set, treat pipe as in forced closure and evaluate dispute
5. for each candidate closure:
   - compare closure nonce vs stored signed nonce
   - if stored nonce is newer and beneficial, call `dispute-closure-for`
6. store dispute txid

Note:

1. Stackflow dispute window is 144 Bitcoin blocks.
2. Hourly polling is acceptable for now but should still emit stale-watcher
   alerts if a run fails repeatedly.

## AIBTC Wallet Integration

Use AIBTC MCP wallet tools through an injected `invokeTool(name, args)`:

1. `sip018_sign` for off-chain transfer signatures
2. `call_contract` for on-chain actions (`fund-pipe`, `dispute-closure-for`)
3. a read-only call tool for `get-pipe` (tool name is MCP-runtime specific)

## Setup Checklist

1. configure contract id and network
2. initialize SQLite file path
3. wire MCP tool invoker for AIBTC wallet
4. track each opened pipe in `tracked_pipes`
5. persist every successful signature state update
6. start hourly watcher
7. monitor alerts:
   - watcher failures
   - dispute call failures
   - signer low-fee balance
