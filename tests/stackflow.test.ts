import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;

describe("get-channel-key", () => {
  it("ensures the channel key is built correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-channel-key",
      [Cl.principal(address1), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
  });

  it("ensures the channel key is ordered correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-channel-key",
      [Cl.principal(address2), Cl.principal(address1)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
  });
});

describe("increase-balance", () => {
  it("increases the balance of principal-1", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "increase-balance",
      [
        Cl.tuple({
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({ "balance-1": Cl.uint(100), "balance-2": Cl.uint(0) }),
        Cl.principal(address1),
        Cl.uint(123),
      ],
      address1
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(223),
      "balance-2": Cl.uint(0),
    });
  });

  it("increases the balance of principal-2", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "increase-balance",
      [
        Cl.tuple({
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({ "balance-1": Cl.uint(100), "balance-2": Cl.uint(0) }),
        Cl.principal(address2),
        Cl.uint(123),
      ],
      address1
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(100),
      "balance-2": Cl.uint(123),
    });
  });
});

describe("decrease-balance", () => {
  it("decreases the balance of principal-1", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "decrease-balance",
      [
        Cl.tuple({
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({ "balance-1": Cl.uint(987), "balance-2": Cl.uint(654) }),
        Cl.principal(address1),
        Cl.uint(321),
      ],
      address1
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(666),
      "balance-2": Cl.uint(654),
    });
  });

  it("decreases the balance of principal-2", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "decrease-balance",
      [
        Cl.tuple({
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({ "balance-1": Cl.uint(987), "balance-2": Cl.uint(654) }),
        Cl.principal(address2),
        Cl.uint(321),
      ],
      address1
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(987),
      "balance-2": Cl.uint(333),
    });
  });
});
