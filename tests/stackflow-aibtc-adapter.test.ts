// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AibtcWalletAdapter } from "../packages/stackflow-agent/src/aibtc-adapter.js";

describe("AibtcWalletAdapter.sip018Sign", () => {
  it("uses domain shape by default for modern MCP providers", async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const adapter = new AibtcWalletAdapter({
      invokeTool: async (name, args) => {
        calls.push({ name, args });
        return { signature: "abcd" };
      },
    });

    const sig = await adapter.sip018Sign({
      contract: "SP1ABC.stackflow-sbtc-0-6-0",
      message: { hello: "world" },
    });

    expect(sig).toBe("abcd");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("sip018_sign");
    expect(calls[0].args.domain).toEqual({
      name: "stackflow-sbtc-0-6-0",
      version: "0.6.0",
    });
    expect(calls[0].args.contract).toBeUndefined();
  });

  it("falls back to legacy contract shape when domain shape is rejected", async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const adapter = new AibtcWalletAdapter({
      invokeTool: async (name, args) => {
        calls.push({ name, args });
        if (calls.length === 1) {
          throw new Error("Invalid arguments: unknown field domain");
        }
        return { signature: "ef01" };
      },
    });

    const sig = await adapter.sip018Sign({
      contract: "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0",
      message: { hello: "world" },
    });

    expect(sig).toBe("ef01");
    expect(calls).toHaveLength(2);
    expect(calls[0].args.domain).toEqual({
      name: "stackflow-sbtc-0-6-0",
      version: "0.6.0",
    });
    expect(calls[1].args.contract).toBe(
      "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0",
    );
  });
});
