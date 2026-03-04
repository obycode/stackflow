// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentStateStore,
  HourlyClosureWatcher,
  StackflowAgentService,
  buildPipeId,
  isDisputeBeneficial,
} from "../packages/stackflow-agent/src/index.js";

function tempDbFile(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stackflow-${label}-`));
  return path.join(dir, "agent.db");
}

describe("stackflow agent", () => {
  it("evaluates beneficial dispute by nonce and balance policy", () => {
    const should = isDisputeBeneficial({
      closureEvent: {
        contractId: "ST1.contract",
        pipeId: "pipe",
        eventName: "force-close",
        nonce: "5",
        closer: "ST1OTHER",
        closureMyBalance: "10",
      },
      signatureState: {
        forPrincipal: "ST1LOCAL",
        nonce: "6",
        myBalance: "50",
        beneficialOnly: false,
      },
      onlyBeneficial: true,
    });
    expect(should).toBe(true);
  });

  it("runs hourly watcher loop and submits disputes for eligible closures", async () => {
    const dbFile = tempDbFile("agent");
    const store = new AgentStateStore({ dbFile });

    const contractId = "ST1TESTABC.contract";
    const pipeKey = {
      "principal-1": "ST1LOCAL",
      "principal-2": "ST1OTHER",
      token: null,
    };
    const pipeId = buildPipeId({ contractId, pipeKey });
    store.upsertTrackedPipe({
      pipeId,
      contractId,
      pipeKey,
      localPrincipal: "ST1LOCAL",
      counterpartyPrincipal: "ST1OTHER",
      token: null,
    });
    store.upsertSignatureState({
      contractId,
      pipeKey,
      forPrincipal: "ST1LOCAL",
      withPrincipal: "ST1OTHER",
      token: null,
      myBalance: "90",
      theirBalance: "10",
      nonce: "8",
      action: "1",
      actor: "ST1LOCAL",
      mySignature: "0x" + "11".repeat(65),
      theirSignature: "0x" + "22".repeat(65),
      secret: null,
      validAfter: null,
      beneficialOnly: false,
    });

    let disputeCalls = 0;
    const signer = {
      async submitDispute() {
        disputeCalls += 1;
        return { txid: "0xdispute1" };
      },
      async sip018Sign() {
        return "0x" + "33".repeat(65);
      },
      async callContract() {
        return { ok: true };
      },
    };

    const agent = new StackflowAgentService({
      stateStore: store,
      signer,
      network: "devnet",
      disputeOnlyBeneficial: true,
    });

    const watcher = new HourlyClosureWatcher({
      agentService: agent,
      listClosureEvents: async () => [
        {
          contractId,
          pipeKey,
          eventName: "force-close",
          nonce: "5",
          closer: "ST1OTHER",
          txid: "0xtx1",
          blockHeight: "123",
          expiresAt: "200",
          closureMyBalance: "20",
        },
      ],
    });

    const result = await watcher.runOnce();
    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.disputesSubmitted).toBe(1);
    expect(disputeCalls).toBe(1);
    expect(store.getWatcherCursor()).toBe("123");

    watcher.stop();
    store.close();
  });

  it("can poll get-pipe readonly state for tracked pipes and dispute", async () => {
    const dbFile = tempDbFile("agent-readonly");
    const store = new AgentStateStore({ dbFile });

    const contractId = "ST1TESTABC.contract";
    const pipeKey = {
      "principal-1": "ST1LOCAL",
      "principal-2": "ST1OTHER",
      token: null,
    };
    const pipeId = buildPipeId({ contractId, pipeKey });
    store.upsertTrackedPipe({
      pipeId,
      contractId,
      pipeKey,
      localPrincipal: "ST1LOCAL",
      counterpartyPrincipal: "ST1OTHER",
      token: null,
    });
    store.upsertSignatureState({
      contractId,
      pipeKey,
      forPrincipal: "ST1LOCAL",
      withPrincipal: "ST1OTHER",
      token: null,
      myBalance: "90",
      theirBalance: "10",
      nonce: "8",
      action: "1",
      actor: "ST1LOCAL",
      mySignature: "0x" + "11".repeat(65),
      theirSignature: "0x" + "22".repeat(65),
      secret: null,
      validAfter: null,
      beneficialOnly: false,
    });

    let disputeCalls = 0;
    const signer = {
      async submitDispute() {
        disputeCalls += 1;
        return { txid: "0xdispute-readonly" };
      },
      async sip018Sign() {
        return "0x" + "33".repeat(65);
      },
      async callContract() {
        return { ok: true };
      },
    };

    const agent = new StackflowAgentService({
      stateStore: store,
      signer,
      network: "devnet",
      disputeOnlyBeneficial: true,
    });

    const watcher = new HourlyClosureWatcher({
      agentService: agent,
      getPipeState: async () => ({
        "balance-1": "20",
        "balance-2": "80",
        "expires-at": "200",
        nonce: "5",
        closer: "ST1OTHER",
      }),
    });

    const result = await watcher.runOnce();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("readonly-pipe");
    expect(result.pipesScanned).toBe(1);
    expect(result.closuresFound).toBe(1);
    expect(result.disputesSubmitted).toBe(1);
    expect(disputeCalls).toBe(1);

    watcher.stop();
    store.close();
  });

  it("validates and signs incoming transfer requests", async () => {
    const dbFile = tempDbFile("agent-sign");
    const store = new AgentStateStore({ dbFile });
    const contractId = "ST1TESTABC.contract";
    const pipeKey = {
      "principal-1": "ST1LOCAL",
      "principal-2": "ST1OTHER",
      token: null,
    };
    const pipeId = buildPipeId({ contractId, pipeKey });
    store.upsertTrackedPipe({
      pipeId,
      contractId,
      pipeKey,
      localPrincipal: "ST1LOCAL",
      counterpartyPrincipal: "ST1OTHER",
      token: null,
    });

    const agent = new StackflowAgentService({
      stateStore: store,
      signer: {
        async sip018Sign() {
          return "0x" + "44".repeat(65);
        },
        async submitDispute() {
          return { txid: "0x1" };
        },
        async callContract() {
          return { ok: true };
        },
      },
      network: "devnet",
    });

    const result = await agent.acceptIncomingTransfer({
      pipeId,
      payload: {
        contractId,
        forPrincipal: "ST1LOCAL",
        withPrincipal: "ST1OTHER",
        token: null,
        myBalance: "90",
        theirBalance: "10",
        nonce: "1",
        action: "1",
        actor: "ST1OTHER",
        theirSignature: "0x" + "22".repeat(65),
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.mySignature).toMatch(/^0x[0-9a-f]+$/);
    const latest = store.getLatestSignatureState(pipeId, "ST1LOCAL");
    expect(latest?.nonce).toBe("1");
    store.close();
  });

  it("defaults watcher interval to one hour", () => {
    const dbFile = tempDbFile("agent-interval");
    const store = new AgentStateStore({ dbFile });
    const agent = new StackflowAgentService({
      stateStore: store,
      signer: {
        async submitDispute() {
          return { txid: "0x1" };
        },
        async callContract() {
          return { ok: true };
        },
      },
    });

    const watcher = new HourlyClosureWatcher({
      agentService: agent,
      listClosureEvents: async () => [],
    });
    expect(watcher.intervalMs).toBe(60 * 60 * 1000);
    watcher.stop();
    store.close();
  });
});
