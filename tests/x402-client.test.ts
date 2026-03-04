// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  StackflowNodePipeStateSource,
  SqliteX402StateStore,
  X402Client,
  buildPipeStateKey,
} from "../packages/x402-client/src/index.js";

function createTempDbFile(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stackflow-${label}-`));
  return path.join(dir, "state.db");
}

function buildChallengeResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "payment required",
      reason: "payment-header-missing",
      details: "x-x402-payment header is required",
      payment: {
        scheme: "x402-stackflow-v1",
        header: "x-x402-payment",
        amount: "10",
        asset: "STX",
        protectedPath: "/paid-content",
        modes: {
          direct: {
            action: "1",
            requiredFields: [],
          },
        },
      },
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

describe("x402 client scaffold", () => {
  it("retries after 402 challenge with proof header", async () => {
    let proofCalls = 0;
    let fetchCalls = 0;

    const client = new X402Client({
      gatewayBaseUrl: "http://127.0.0.1:8790",
      proactivePayment: false,
      proofProvider: {
        async createProof() {
          proofCalls += 1;
          return {
            mode: "direct",
            contractId: "ST1.contract",
            forPrincipal: "ST1SERVER",
            withPrincipal: "ST1CLIENT",
            token: null,
            amount: "10",
            myBalance: "90",
            theirBalance: "10",
            theirSignature: "0x" + "11".repeat(65),
            nonce: "1",
            action: "1",
            actor: "ST1CLIENT",
            hashedSecret: null,
            validAfter: null,
            beneficialOnly: false,
          };
        },
      },
      fetchFn: async (_url: string, init?: RequestInit) => {
        fetchCalls += 1;
        const headerValue = new Headers(init?.headers).get("x-x402-payment");
        if (!headerValue) {
          return buildChallengeResponse();
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await client.request("/paid-content", { method: "GET" });
    expect(response.status).toBe(200);
    expect(fetchCalls).toBe(2);
    expect(proofCalls).toBe(1);
  });

  it("supports proactive payment on first request", async () => {
    let proofCalls = 0;
    let fetchCalls = 0;

    const client = new X402Client({
      gatewayBaseUrl: "http://127.0.0.1:8790",
      proactivePayment: true,
      proofProvider: {
        async createProof() {
          proofCalls += 1;
          return {
            mode: "direct",
            contractId: "ST1.contract",
            forPrincipal: "ST1SERVER",
            withPrincipal: "ST1CLIENT",
            token: null,
            amount: "10",
            myBalance: "90",
            theirBalance: "10",
            theirSignature: "0x" + "11".repeat(65),
            nonce: "2",
            action: "1",
            actor: "ST1CLIENT",
          };
        },
      },
      fetchFn: async (_url: string, init?: RequestInit) => {
        fetchCalls += 1;
        const headerValue = new Headers(init?.headers).get("x-x402-payment");
        if (!headerValue) {
          return buildChallengeResponse();
        }
        return new Response("ok", { status: 200 });
      },
    });

    const response = await client.request("/paid-content", { method: "GET" });
    expect(response.status).toBe(200);
    expect(fetchCalls).toBe(1);
    expect(proofCalls).toBe(1);
  });

  it("stores proof replay and serializes per-pipe lock", async () => {
    const dbFile = createTempDbFile("x402-client");
    const store = new SqliteX402StateStore({ dbFile });

    const proofHash = "abc123";
    store.markConsumedProof(proofHash, Date.now() + 10_000);
    expect(store.isProofConsumed(proofHash)).toBe(true);
    const purge = store.purgeExpired(Date.now() + 20_000);
    expect(purge.consumedDeleted).toBeGreaterThanOrEqual(1);
    expect(store.isProofConsumed(proofHash)).toBe(false);

    const pipeKey = buildPipeStateKey({
      contractId: "ST1.contract",
      forPrincipal: "ST1SERVER",
      withPrincipal: "ST1CLIENT",
      token: null,
    });
    let active = 0;
    let maxActive = 0;

    await Promise.all([
      store.withPipeLock(pipeKey, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 80));
        active -= 1;
      }),
      store.withPipeLock(pipeKey, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      }),
    ]);

    expect(maxActive).toBe(1);
    store.close();
  });

  it("can fetch pipe status from stackflow-node and sync into sqlite", async () => {
    const dbFile = createTempDbFile("x402-client-source");
    const store = new SqliteX402StateStore({ dbFile });

    const source = new StackflowNodePipeStateSource({
      stackflowNodeBaseUrl: "http://127.0.0.1:8787",
      fetchFn: async (url: string) => {
        const parsed = new URL(url);
        expect(parsed.pathname).toBe("/pipes");
        expect(parsed.searchParams.get("principal")).toBe("ST1CLIENT");
        return new Response(
          JSON.stringify({
            ok: true,
            pipes: [
              {
                contractId: "ST1.contract",
                pipeKey: {
                  "principal-1": "ST1CLIENT",
                  "principal-2": "ST1SERVER",
                  token: null,
                },
                balance1: "50",
                balance2: "25",
                pending1Amount: "0",
                pending2Amount: "0",
                nonce: "1",
                source: "onchain",
                event: "fund-pipe",
                updatedAt: "2026-03-03T00:00:00.000Z",
              },
              {
                contractId: "ST1.contract",
                pipeKey: {
                  "principal-1": "ST1CLIENT",
                  "principal-2": "ST1SERVER",
                  token: null,
                },
                balance1: "80",
                balance2: "20",
                pending1Amount: "0",
                pending2Amount: "0",
                nonce: "2",
                source: "signature-state",
                event: "signature-state",
                updatedAt: "2026-03-03T00:00:01.000Z",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const status = await source.syncPipeState({
      principal: "ST1CLIENT",
      counterpartyPrincipal: "ST1SERVER",
      contractId: "ST1.contract",
      stateStore: store,
    });

    expect(status.hasPipe).toBe(true);
    expect(status.nonce).toBe("2");
    expect(status.myConfirmed).toBe("80");
    expect(status.theirConfirmed).toBe("20");

    const pipeKey = buildPipeStateKey({
      contractId: "ST1.contract",
      forPrincipal: "ST1CLIENT",
      withPrincipal: "ST1SERVER",
      token: null,
    });
    const persisted = store.getPipeState(pipeKey);
    expect(persisted?.nonce).toBe("2");
    expect(persisted?.myBalance).toBe("80");
    expect(persisted?.theirBalance).toBe("20");
    store.close();
  });
});
