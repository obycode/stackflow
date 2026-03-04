# @stackflow/x402-client (scaffold)

Minimal SDK scaffold for API callers interacting with the Stackflow x402
gateway.

This package currently provides:

1. `X402Client`: fetch wrapper with challenge/retry flow for `402`
2. `SqliteX402StateStore`: local SQLite store for pipe state, proof replay, and
   per-pipe locks
3. `StackflowNodePipeStateSource`: fetches authoritative pipe state from
   stackflow-node (`GET /pipes`) and can sync it into SQLite

## Runtime

Uses Node built-in `node:sqlite`, so run on a Node version that includes it.

## Quick Start

```js
import {
  StackflowNodePipeStateSource,
  X402Client,
  SqliteX402StateStore,
  buildPipeStateKey,
} from "./src/index.js";

const store = new SqliteX402StateStore({
  dbFile: "./tmp/x402-client.db",
});

const proofProvider = {
  async createProof(ctx) {
    // Optional: fetch canonical pipe status from stackflow-node on demand.
    // const status = await ctx.pipeStateSource.getPipeStatus({
    //   principal: "ST_CLIENT...",
    //   counterpartyPrincipal: "ST_SERVER...",
    //   contractId: "ST...stackflow",
    // });

    // Replace this with your real proof flow:
    // 1) read/update per-pipe nonce under store.withPipeLock(...)
    // 2) build Stackflow structured payload
    // 3) sign payload
    // 4) return direct or indirect proof object
    return {
      mode: "direct",
      contractId: "ST...stackflow",
      forPrincipal: "ST_SERVER...",
      withPrincipal: "ST_CLIENT...",
      token: null,
      amount: "10",
      myBalance: "1010",
      theirBalance: "90",
      theirSignature: "0x...",
      nonce: "1",
      action: "1",
      actor: "ST_CLIENT...",
      hashedSecret: null,
      validAfter: null,
      beneficialOnly: false,
    };
  },
};

const pipeStateSource = new StackflowNodePipeStateSource({
  stackflowNodeBaseUrl: "http://127.0.0.1:8787",
});

const client = new X402Client({
  gatewayBaseUrl: "http://127.0.0.1:8790",
  proofProvider,
  stateStore: store,
  pipeStateSource,
  proactivePayment: true,
});

const response = await client.request("/paid-content", {
  method: "GET",
});
console.log(response.status);
```

## Pipe Lock Example

Use per-pipe lock to avoid nonce races across concurrent requests:

```js
const pipeKey = buildPipeStateKey({
  contractId: "ST...stackflow",
  forPrincipal: "ST_SERVER...",
  withPrincipal: "ST_CLIENT...",
  token: null,
});

await store.withPipeLock(pipeKey, async () => {
  const existing = store.getPipeState(pipeKey);
  const nextNonce = existing ? (BigInt(existing.nonce) + 1n).toString(10) : "1";
  store.setPipeState({
    pipeKey,
    contractId: "ST...stackflow",
    forPrincipal: "ST_SERVER...",
    withPrincipal: "ST_CLIENT...",
    token: null,
    nonce: nextNonce,
    myBalance: "100",
    theirBalance: "0",
  });
});
```

## Notes

1. SQLite store is local client coordination/cache, not source of truth.
2. For latest channel state, use `StackflowNodePipeStateSource`.
3. This scaffold does not include an opinionated direct-proof signer yet.
4. For retries, request bodies must be replayable (not one-shot streams).
