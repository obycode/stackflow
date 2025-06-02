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
  address2,
  accounts,
  generateWithdrawSignature,
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

  describe("get-min-liquidity", () => {
    it("returns correct floor minimum liquidity amount", () => {
      const { result } = simnet.callReadOnlyFn(
        "reservoir",
        "get-min-liquidity",
        [],
        deployer
      );
      expect(result).toBeUint(1000000000n);
    });

    it("increases as liquidity is added", () => {
      // Add some liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(512000000000n)],
        deployer
      );

      // Check new minimum liquidity
      const { result } = simnet.callReadOnlyFn(
        "reservoir",
        "get-min-liquidity",
        [],
        deployer
      );
      expect(result).toBeUint(4000000000n);

      // Add more liquidity (2 providers)
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(4000000000n)],
        address1
      );
      const { result: result2 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-min-liquidity",
        [],
        deployer
      );
      expect(result2).toBeUint(4031250000n);

      // Add more liquidity (3 providers)
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(4031250000n)],
        address2
      );
      const { result: result3 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-min-liquidity",
        [],
        deployer
      );
      expect(result3).toBeUint(6094116210n);

      // Add more liquidity (7 providers)
      let prev_min = 6094116210n;
      for (let i = 3; i < 8; i++) {
        const address = accounts.get(`wallet_${i}`)!;
        const { result } = simnet.callPublicFn(
          "reservoir",
          "add-liquidity",
          [Cl.none(), Cl.uint(prev_min)],
          address
        );
        expect(result).toBeOk(Cl.bool(true));

        const amount = (
          simnet.callReadOnlyFn("reservoir", "get-min-liquidity", [], deployer)
            .result as UIntCV
        ).value as bigint;
        expect(amount).toBeGreaterThan(prev_min);
        prev_min = amount;
      }
      const { result: result7 } = simnet.callReadOnlyFn(
        "reservoir",
        "get-min-liquidity",
        [],
        deployer
      );
      expect(result7).toBeUint(8646135668n);
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

      // Verify provider is added
      const providers = simnet.getDataVar(reservoirContract, "providers");
      expect(providers).toBeList([Cl.principal(deployer)]);

      // Verify liquidity entry is created
      const liquidity = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(deployer)
      );
      expect(liquidity).toBeSome(Cl.uint(1000000000));

      // Verify total-liquidity
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(1000000000n);
    });

    it("provider can remove their own STX liquidity", () => {
      // First add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(10000000000)],
        deployer
      );

      // Then remove some (leaving more than the minimum)
      const { result } = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(800000)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(800000));

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(9999200000n);

      // Verify total-liquidity
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(9999200000n);
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

      // Verify providers
      const providers = simnet.getDataVar(reservoirContract, "providers");
      expect(providers).toBeList([
        Cl.principal(deployer),
        Cl.principal(address1),
      ]);

      // Verify liquidity entries
      const liquidityDeployer = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(deployer)
      );
      expect(liquidityDeployer).toBeSome(Cl.uint(2000000000));
      const liquidityAddress1 = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(address1)
      );
      expect(liquidityAddress1).toBeSome(Cl.uint(1000000000));

      // Verify total-liquidity
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(3000000000n);
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
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));

      // Verify reservoir balance remains unchanged
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n);

      // Verify provider is still listed
      const providers = simnet.getDataVar(reservoirContract, "providers");
      expect(providers).toBeList([Cl.principal(deployer)]);

      // Verify liquidity entry remains unchanged
      const liquidity = simnet.getMapEntry(
        reservoirContract,
        "liquidity",
        Cl.principal(deployer)
      );
      expect(liquidity).toBeSome(Cl.uint(1000000000));

      // Verify total-liquidity remains unchanged
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(1000000000n);
    });

    it("provider cannot remove below min-liquidity-amount", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1500000000)],
        deployer
      );

      // Try to leave less than min-liquidity-amount
      const { result } = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );
      // Should return the full remaining balance
      expect(result).toBeOk(Cl.uint(1500000000));

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

      // Verify total-liquidity is now 0
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(0n);
    });

    it("provider is removed when they withdraw all liquidity", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Add more liquidity from another provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(5000000000)],
        address1
      );

      // First provider removes all their liquidity
      const { result } = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(2000000000));

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

      // Verify total-liquidity is now only from the second provider
      const totalLiquidity = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidity).toBeUint(5000000000n);

      // Second provider should now be the only one
      // Try a second provider to remove more than they have - should fail
      const result2 = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(6000000000)],
        address1
      );
      expect(result2.result).toBeErr(Cl.uint(ReservoirError.Unauthorized));

      // But they should be able to remove part of what they put in, leaving the minimum
      const result3 = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(4000000000)],
        address1
      );
      expect(result3.result).toBeOk(Cl.uint(4000000000));

      // Verify reservoir balance after second provider's removal
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n); // 5000000000 - 4000000000

      // Verify total-liquidity after second provider's removal
      const totalLiquidityAfter = simnet.getDataVar(
        reservoirContract,
        "total-liquidity"
      );
      expect(totalLiquidityAfter).toBeUint(1000000000n);
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
        "withdraw-liquidity-from-reservoir",
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
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Check total liquidity
      let liquidity = simnet.getDataVar(reservoirContract, "total-liquidity");
      expect(liquidity).toBeUint(2000000000);

      // Add liquidity from second provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1500000000)],
        address1
      );

      // Check updated total liquidity
      liquidity = simnet.getDataVar(reservoirContract, "total-liquidity");
      expect(liquidity).toBeUint(3500000000);

      // Remove some liquidity
      simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity-from-reservoir",
        [Cl.none(), Cl.uint(500000000)],
        deployer
      );

      // Check updated total liquidity after removal
      liquidity = simnet.getDataVar(reservoirContract, "total-liquidity");
      expect(liquidity).toBeUint(3000000000);
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
        [Cl.none(), Cl.uint(5000000000)],
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
      // 5000000000 - 50000 (borrowed) + 5000 (fee)
      expect(reservoirBalance).toBe(4999955000n);
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
        [Cl.none(), Cl.uint(1000000000)],
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
      const amount = 10000000000;
      const fee = 1000000000;

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        50000,
        amount,
        1,
        address1
      );

      const reservoirSignature = generateDepositSignature(
        address2PK,
        null,
        reservoirContract,
        address1,
        amount,
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
          Cl.uint(amount),
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

  describe("return-liquidity-to-reservoir", () => {
    let pipeKey;
    beforeEach(() => {
      // Add liquidity to reservoir
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );

      // Create initial tap with some funds
      const { result } = simnet.callPublicFn(
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
      expect(result.type).toBe(ClarityType.ResponseOk);
      pipeKey = (result as ResponseOkCV).value;

      // Wait for the fund to confirm
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);
    });

    it("can return liquidity to reservoir", () => {
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
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

      // Generate signature for returning liquidity
      const myReturnSignature = generateWithdrawSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        1000000,
        0,
        2,
        reservoirContract
      );
      const reservoirReturnSignature = generateWithdrawSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        0,
        1000000,
        2,
        reservoirContract
      );

      const returnLiquidity = simnet.callPublicFn(
        "reservoir",
        "return-liquidity-to-reservoir",
        [
          Cl.principal(stackflowContract),
          Cl.none(), // No token
          Cl.uint(50000), // Amount to return
          Cl.uint(1000000), // My balance
          Cl.uint(0), // Reservoir balance
          Cl.buffer(myReturnSignature),
          Cl.buffer(reservoirReturnSignature),
          Cl.uint(2), // Nonce
        ],
        address1
      );
      expect(returnLiquidity.result).toBeOk(
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(reservoirContract),
        })
      );

      // Verify the tap balance after returning liquidity
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n);

      // Verify the reservoir balance after returning liquidity
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n + 5000n);
    });
  });
});
