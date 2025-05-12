import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType, ResponseOkCV } from "@stacks/transactions";
import {
  deployer,
  address1,
  address1PK,
  address2PK,
  reservoirContract,
  StackflowError,
  generateDepositSignature,
  ReservoirError,
  stackflowContract,
  deployerPK,
  MAX_HEIGHT,
  CONFIRMATION_DEPTH,
} from "./utils";

describe("reservoir", () => {
  beforeEach(() => {
    // Initialize stackflow contract for STX before each test
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Authorize the deployer as an agent for the reservoir contract
    simnet.callPublicFn(
      "reservoir",
      "init",
      [Cl.principal(stackflowContract), Cl.none(), Cl.uint(0)],
      deployer
    );
  });

  describe("borrow rate", () => {
    it("operator can set borrow rate", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)], // 10%
        deployer
      );
      expect(result).toBeOk(Cl.bool(true));
    });

    it("non-operator cannot set borrow rate", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });

    it("calculates correct borrow fee", () => {
      // Set rate to 10%
      simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        deployer
      );

      // Calculate fee for 1000 tokens
      const { result } = simnet.callReadOnlyFn(
        "reservoir",
        "get-borrow-fee",
        [Cl.uint(1000)],
        deployer
      );
      expect(result).toBeUint(100); // 10% of 1000 = 100
    });

    it("rejects borrow with incorrect fee", () => {
      // Set rate to 10%
      simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        deployer
      );

      // Fund initial tap
      simnet.callPublicFn(
        "reservoir",
        "fund-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(),
          Cl.uint(1000000),
          Cl.uint(0),
        ],
        address1
      );

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        1000,
        1000000,
        1,
        address1
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        1000000,
        1000,
        1,
        address1
      );

      const { result } = simnet.callPublicFn(
        "reservoir",
        "borrow-liquidity",
        [
          Cl.principal(stackflowContract),
          Cl.uint(1000), // amount
          Cl.uint(50), // incorrect fee (should be 100)
          Cl.none(), // token
          Cl.uint(1000), // my balance
          Cl.uint(1000000), // reservoir balance
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(1), // nonce
        ],
        address1
      );
      expect(result).toBeErr(Cl.uint(StackflowError.InvalidFee));
    });
  });

  describe("liquidity management", () => {
    it("operator can add STX liquidity", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000)],
        deployer
      );
      expect(result).toBeOk(Cl.bool(true));

      // Verify reservoir balance
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000n);
    });

    it("operator can remove STX liquidity", () => {
      // First add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000)],
        deployer
      );

      // Then remove some
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity",
        [Cl.none(), Cl.uint(500000)],
        deployer
      );
      expect(result).toBeOk(Cl.bool(true));

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(500000n);
    });

    it("non-operator cannot add liquidity", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });

    it("non-operator cannot remove liquidity", () => {
      // First add liquidity as operator
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000)],
        deployer
      );

      // Try to remove as non-operator
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity",
        [Cl.none(), Cl.uint(500000)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });
  });

  describe("tap management", () => {
    it("can fund new tap", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "fund-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(),
          Cl.uint(1000000),
          Cl.uint(0),
        ],
        address1
      );
      expect(result).toBeOk(
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(reservoirContract),
        })
      );

      // Verify tap balance
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n);
    });

    it("can borrow liquidity with correct fee", () => {
      // Set rate to 10%
      simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        deployer
      );

      // Add liquidity to reservoir
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000)],
        deployer
      );

      // Fund initial tap
      const { result } = simnet.callPublicFn(
        "reservoir",
        "fund-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(),
          Cl.uint(1000000),
          Cl.uint(0),
        ],
        address1
      );
      expect(result.type).toBe(ClarityType.ResponseOk);
      const pipeKey = (result as ResponseOkCV).value;

      const amount = 1000000;
      const fee = amount * 0.1; // 10% of amount

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        1000000,
        1000000,
        1,
        reservoirContract
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        1000000,
        1000000,
        1,
        reservoirContract
      );

      const borrow = simnet.callPublicFn(
        "reservoir",
        "borrow-liquidity",
        [
          Cl.principal(stackflowContract),
          Cl.uint(amount),
          Cl.uint(fee),
          Cl.none(),
          Cl.uint(1000000),
          Cl.uint(1000000),
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(1),
        ],
        address1
      );
      expect(borrow.result).toBeOk(
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(reservoirContract),
        })
      );

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000n + BigInt(fee));
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(2000000n);

      // Verify the pipe
      const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
      expect(pipe).toBeSome(
        Cl.tuple({
          "balance-1": Cl.uint(0),
          "balance-2": Cl.uint(0),
          "expires-at": Cl.uint(MAX_HEIGHT),
          nonce: Cl.uint(1),
          closer: Cl.none(),
          "pending-1": Cl.some(
            Cl.tuple({
              amount: Cl.uint(1000000),
              "burn-height": Cl.uint(
                simnet.burnBlockHeight + CONFIRMATION_DEPTH
              ),
            })
          ),
          "pending-2": Cl.some(
            Cl.tuple({
              amount: Cl.uint(1000000),
              "burn-height": Cl.uint(
                simnet.burnBlockHeight + CONFIRMATION_DEPTH
              ),
            })
          ),
        })
      );
    });

    it("cannot borrow with insufficient reservoir liquidity", () => {
      // Set rate to 10%
      simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        deployer
      );

      // Add small amount of liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(100000)],
        deployer
      );

      // Fund initial tap
      simnet.callPublicFn(
        "reservoir",
        "fund-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(),
          Cl.uint(50000),
          Cl.uint(0),
        ],
        address1
      );

      // Try to borrow more than available
      const amount = 1000000;
      const fee = 100000;

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        50000,
        1000000,
        1,
        address1
      );

      const reservoirSignature = generateDepositSignature(
        address2PK,
        null,
        reservoirContract,
        address1,
        1000000,
        50000,
        1,
        address1
      );

      const { result } = simnet.callPublicFn(
        "reservoir",
        "borrow-liquidity",
        [
          Cl.principal(stackflowContract),
          Cl.uint(amount),
          Cl.uint(fee),
          Cl.none(),
          Cl.uint(50000),
          Cl.uint(1000000),
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(1),
        ],
        address1
      );
      expect(result).toBeErr(Cl.uint(StackflowError.DepositFailed));
    });
  });
});
