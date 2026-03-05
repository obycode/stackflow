# @stackflow/agent (scaffold)

Simple Stackflow agent runtime for AI agents that do **not** run `stacks-node`
or `stackflow-node`.

Current model:

1. SQLite local state for tracked pipes and latest signatures
2. signer + contract call adapter backed by AIBTC MCP wallet tools
3. hourly chain watcher to detect force-close/force-cancel and dispute

## Runtime Components

1. `AgentStateStore`: SQLite persistence
2. `StackflowAgentService`: pipe tracking + signature state + dispute logic
3. `AibtcWalletAdapter`: wrapper around AIBTC MCP tools
4. `HourlyClosureWatcher`: periodic closure scan (default every hour)

## Example Wiring

```js
import {
  AgentStateStore,
  AibtcPipeStateSource,
  AibtcWalletAdapter,
  HourlyClosureWatcher,
  StackflowAgentService,
} from "./src/index.js";

const stateStore = new AgentStateStore({
  dbFile: "./tmp/stackflow-agent.db",
});

// You provide invokeTool using your MCP client runtime.
const wallet = new AibtcWalletAdapter({
  invokeTool: async (toolName, args) => {
    // Example:
    // return mcpClient.callTool({ name: toolName, arguments: args });
    throw new Error("implement invokeTool");
  },
});

const agent = new StackflowAgentService({
  stateStore,
  signer: wallet,
  network: "devnet",
  disputeOnlyBeneficial: true,
});

const pipeSource = new AibtcPipeStateSource({
  walletAdapter: wallet,
  contractId: "ST...stackflow",
  network: "devnet",
});

const watcher = new HourlyClosureWatcher({
  agentService: agent,
  // Simpler mode: poll each tracked pipe via read-only `get-pipe`.
  getPipeState: (args) => pipeSource.getPipeState(args),
  intervalMs: 60 * 60 * 1000, // 1 hour
});

watcher.start();
```

## Core Operations

1. `trackPipe(...)`
2. `recordSignedState(...)`
3. `openPipe(...)` (via wallet `call_contract`)
4. `buildOutgoingTransfer(...)`
5. `validateIncomingTransfer(...)`
6. `acceptIncomingTransfer(...)` (validate + sign + persist)
7. `evaluateClosureForDispute(...)`
8. `disputeClosure(...)`
9. `watcher.runOnce()` or `watcher.start()` for hourly checks

## Quick workflow (setup pipe + send + receive)

1. Track pipe locally:

```js
const tracked = agent.trackPipe({
  contractId: "ST...stackflow-0-6-0",
  pipeKey: { "principal-1": "SP...ME", "principal-2": "SP...THEM", token: null },
  localPrincipal: "SP...ME",
  counterpartyPrincipal: "SP...THEM",
});
```

2. Open/fund the pipe on-chain:

```js
await agent.openPipe({
  contractId: tracked.contractId,
  token: null,
  amount: "1000",
  counterpartyPrincipal: tracked.counterpartyPrincipal,
  nonce: "0",
});
```

3. Build an outgoing state update to send to counterparty:

```js
const outgoing = agent.buildOutgoingTransfer({
  pipeId: tracked.pipeId,
  amount: "25",
  actor: tracked.localPrincipal,
});
```

4. Validate + accept incoming counterparty update:

```js
const result = await agent.acceptIncomingTransfer({
  pipeId: tracked.pipeId,
  payload: {
    ...outgoing,
    actor: tracked.counterpartyPrincipal,
    theirSignature: "0x...",
  },
});
```

5. Persisted local latest state is now available via `getPipeLatestState(...)`.

## Notes

1. This scaffold intentionally avoids observer endpoints and local chain node.
2. The watcher interval defaults to one hour; dispute window is still 144 BTC blocks.
3. `HourlyClosureWatcher` supports two sources:
   - `getPipeState` (recommended): per-pipe read-only polling (`get-pipe`)
   - `listClosureEvents`: event scan mode
4. Watcher retries are idempotent for already-disputed closures (same closure txid is skipped on later polls).
5. Read-only polling isolates per-pipe failures (`getPipeState` errors on one pipe do not stop others).
6. Event scan mode intentionally holds the cursor when any dispute submission errors occur, so failed disputes are retried on next run.
7. Incoming transfer validation enforces tracked contract/pipe/principals/token consistency; mismatched `pipeId`, `pipeKey`, or token payloads are rejected.
8. For production hardening, add alerting, signer balance checks, and idempotency audit logs.
