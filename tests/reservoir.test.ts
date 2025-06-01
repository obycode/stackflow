import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType, ResponseOkCV, UIntCV } from "@stacks/transactions";
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

    // Set minimum liquidity amount to a lower value for testing
    simnet.callPublicFn(
      "reservoir",
      "set-min-liquidity-amount",
      [Cl.uint(100000)],
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
        "create-tap",
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
    it("provider can add STX liquidity", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );
      expect(result).toBeOk(Cl.bool(true));

      // Verify reservoir balance
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n);
    });

    it("provider can remove their own STX liquidity", () => {
      // First add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );

      // Then remove some (leaving more than the minimum)
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(800000)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(800000));

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(999200000n);
    });

    it("multiple providers can add liquidity", () => {
      // Add liquidity from deployer
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Add liquidity from address1
      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        address1
      );
      expect(result).toBeOk(Cl.bool(true));

      // Verify reservoir balance (should be sum of both)
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(3000000000n);
    });

    it("provider cannot remove more than they provided", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );

      // Try to remove more than provided
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });

    it("provider cannot remove below min-liquidity-amount", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(150000)],
        deployer
      );

      // Try to leave less than min-liquidity-amount
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(100000)],
        deployer
      );
      // Should return the full remaining balance
      expect(result).toBeOk(Cl.uint(150000));

      // Verify reservoir balance
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(0n);

      // Verify provider is removed
      const providers = simnet.getDataVar(reservoirContract, "providers");
      expect(providers).toBeList([]);

      // Verify liquidity entry is removed
      const liquidity = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(deployer)
      );
      expect(liquidity).toBeNone();
    });

    it("provider is removed when they withdraw all liquidity", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(200000)],
        deployer
      );

      // Add more liquidity from another provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(500000)],
        address1
      );

      // First provider removes all their liquidity
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(200000)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(200000));

      // Verify provider is removed
      const providers = simnet.getDataVar(reservoirContract, "providers");
      expect(providers).toBeList([Cl.principal(address1)]);

      // Verify liquidity entry is removed
      const liquidity = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(deployer)
      );
      expect(liquidity).toBeNone();

      // Second provider should now be the only one
      // Try a second provider to remove more than they have - should fail
      const result2 = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(600000)],
        address1
      );
      expect(result2.result).toBeErr(Cl.uint(ReservoirError.Unauthorized));

      // But they should be able to remove part of what they put in, leaving the minimum
      const result3 = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(400000)],
        address1
      );
      expect(result3.result).toBeOk(Cl.uint(400000));
    });

    it("non-provider cannot remove liquidity", () => {
      // First add liquidity as deployer
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Try to remove as non-provider
      const { result } = simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(500000)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });

    it("calculates total liquidity correctly", () => {
      // Add liquidity from first provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(200000)],
        deployer
      );

      // Check total liquidity
      let { result: result1 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-total-liquidity",
        [],
        deployer
      );
      expect(result1).toBeUint(200000);

      // Add liquidity from second provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(150000)],
        address1
      );

      // Check updated total liquidity
      const { result: result2 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-total-liquidity",
        [],
        deployer
      );
      expect(result2).toBeUint(350000);

      // Remove some liquidity
      simnet.callPublicFn(
        "reservoir",
        "remove-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(50000)],
        deployer
      );

      // Check updated total liquidity after removal
      const { result: result3 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-total-liquidity",
        [],
        deployer
      );
      expect(result3).toBeUint(300000);
    });
  });

  describe("tap management", () => {
    it("can fund new tap", () => {
      const { result } = simnet.callPublicFn(
        "reservoir",
        "create-tap",
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
        [Cl.none(), Cl.uint(500000)],
        deployer
      );

      // Fund initial tap
      const { result } = simnet.callPublicFn(
        "reservoir",
        "create-tap",
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

      const amount = 50000;
      const fee = 5000; // 10% of amount

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        1000000,
        50000,
        1,
        reservoirContract
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        50000,
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
          Cl.uint(50000),
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
      // 500000 - 50000 (borrowed) + 5000 (fee)
      expect(reservoirBalance).toBe(455000n);
      const tapBalance = stxBalances.get(stackflowContract);
      // 1000000 (initial) + 50000 (borrowed)
      expect(tapBalance).toBe(1050000n);

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
              amount: Cl.uint(50000),
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
        "create-tap",
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

  describe("adding funds to tap", () => {
    beforeEach(() => {
      // Create initial tap with some funds
      simnet.callPublicFn(
        "reservoir",
        "create-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(),
          Cl.uint(1000000), // Initial balance
          Cl.uint(0),
        ],
        address1
      );

      // Wait for the fund to confirm
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);
    });

    it("can add funds to existing tap", () => {
      const additionalAmount = 500000;
      const nonce = 1;
      const currentBalance = 1000000;

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        currentBalance + additionalAmount,
        0,
        nonce,
        address1
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        0,
        currentBalance + additionalAmount,
        nonce,
        address1
      );

      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-funds",
        [
          Cl.principal(stackflowContract),
          Cl.uint(additionalAmount),
          Cl.none(),
          Cl.uint(currentBalance + additionalAmount),
          Cl.uint(0),
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(nonce),
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

      // Verify the updated balance in the tap
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1500000n); // Initial 1000000 + additional 500000
    });

    it("fails with invalid signatures", () => {
      const additionalAmount = 500000;
      const nonce = 1;
      const currentBalance = 1000000;

      // Generate invalid signature by using wrong nonce
      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        currentBalance + additionalAmount,
        0,
        nonce + 1, // Wrong nonce
        address1
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        0,
        currentBalance + additionalAmount,
        nonce,
        address1
      );

      const { result } = simnet.callPublicFn(
        "reservoir",
        "add-funds",
        [
          Cl.principal(stackflowContract),
          Cl.uint(additionalAmount),
          Cl.none(),
          Cl.uint(currentBalance + additionalAmount),
          Cl.uint(0),
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(nonce),
        ],
        address1
      );

      expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));
    });
  });
});
