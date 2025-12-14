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
  generateWithdrawSignature,
  BORROW_TERM_BLOCKS,
  PipeAction,
  generateTransferSignature,
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

  describe("liquidity management", () => {
    it("operator can add STX liquidity", () => {
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

      // Verify get-available-liquidity
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(1000000000n));
    });

    it("operator can remove their own unused STX liquidity", () => {
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
        "withdraw-liquidity",
        [Cl.none(), Cl.uint(800000), Cl.principal(deployer)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(800000));

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(9999200000n);

      // Verify get-available-liquidity
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(9999200000n));
    });

    it("operator can remove their own unused STX liquidity to another address", () => {
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
        "withdraw-liquidity",
        [Cl.none(), Cl.uint(800000), Cl.principal(address1)],
        deployer
      );
      expect(result).toBeOk(Cl.uint(800000));

      // Verify balances
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(9999200000n);

      // Verify get-available-liquidity
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(9999200000n));
    });

    it("operator cannot remove more than the available liquidity", () => {
      // Add liquidity
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1000000000)],
        deployer
      );

      // Try to remove more than available
      const { result } = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity",
        [Cl.none(), Cl.uint(2000000000), Cl.principal(deployer)],
        deployer
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.AmountNotAvailable));

      // Verify reservoir balance remains unchanged
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n);

      // Verify get-available-liquidity remains unchanged
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(1000000000n));
    });

    it("non-operator cannot remove liquidity", () => {
      // First add liquidity as deployer
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Try to remove as non-operator
      const { result } = simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity",
        [Cl.none(), Cl.uint(500000), Cl.principal(address1)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ReservoirError.Unauthorized));
    });

    it("calculates available liquidity correctly", () => {
      // Add liquidity from first provider
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(2000000000)],
        deployer
      );

      // Check total liquidity
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(2000000000));

      // Add liquidity again
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(1500000000)],
        deployer
      );

      // Check updated total liquidity
      const { result: availableAfterAdd } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(availableAfterAdd).toBeOk(Cl.uint(3500000000));

      // Remove some liquidity
      simnet.callPublicFn(
        "reservoir",
        "withdraw-liquidity",
        [Cl.none(), Cl.uint(500000000), Cl.principal(deployer)],
        deployer
      );

      // Check updated total liquidity after removal
      const { result: availableAfterWithdraw } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(availableAfterWithdraw).toBeOk(Cl.uint(3000000000));
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
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
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

    it("can borrow additional liquidity before previous term ends", () => {
      // Set rate to 10% and fund the reservoir
      simnet.callPublicFn(
        "reservoir",
        "set-borrow-rate",
        [Cl.uint(1000)],
        deployer
      );
      simnet.callPublicFn(
        "reservoir",
        "add-liquidity",
        [Cl.none(), Cl.uint(5000000000)],
        deployer
      );

      // Fund initial tap
      const tap = simnet.callPublicFn(
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
      expect(tap.result.type).toBe(ClarityType.ResponseOk);

      const amount1 = 50000;
      const fee1 = 5000;
      const nonce1 = 1;

      const mySignature1 = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        1000000,
        amount1,
        nonce1,
        reservoirContract
      );

      const reservoirSignature1 = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount1,
        1000000,
        nonce1,
        reservoirContract
      );

      const borrow1 = simnet.callPublicFn(
        "reservoir",
        "borrow-liquidity",
        [
          Cl.principal(stackflowContract),
          Cl.uint(amount1),
          Cl.uint(fee1),
          Cl.none(),
          Cl.uint(1000000),
          Cl.uint(amount1),
          Cl.buffer(mySignature1),
          Cl.buffer(reservoirSignature1),
          Cl.uint(nonce1),
        ],
        address1
      );
      expect(borrow1.result).toBeOk(
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );

      // Wait for the first borrow deposit to confirm, but not for the term to expire
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

      const amount2 = 75000;
      const fee2 = 7500;
      const nonce2 = 2;
      const userBalance = 1000000;
      const reservoirBalance = amount1 + amount2;
      const expectedUntil = simnet.burnBlockHeight + BORROW_TERM_BLOCKS;

      const mySignature2 = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance,
        reservoirBalance,
        nonce2,
        reservoirContract
      );

      const reservoirSignature2 = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        reservoirBalance,
        userBalance,
        nonce2,
        reservoirContract
      );

      const borrow2 = simnet.callPublicFn(
        "reservoir",
        "borrow-liquidity",
        [
          Cl.principal(stackflowContract),
          Cl.uint(amount2),
          Cl.uint(fee2),
          Cl.none(),
          Cl.uint(userBalance),
          Cl.uint(reservoirBalance),
          Cl.buffer(mySignature2),
          Cl.buffer(reservoirSignature2),
          Cl.uint(nonce2),
        ],
        address1
      );
      expect(borrow2.result).toBeOk(Cl.uint(expectedUntil));

      const borrowEntry = simnet.getMapEntry(
        reservoirContract,
        "borrowed-liquidity",
        Cl.principal(address1)
      );
      expect(borrowEntry).toBeSome(
        Cl.tuple({
          amount: Cl.uint(amount2),
          until: Cl.uint(expectedUntil),
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
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      simnet.mineEmptyBlocks(BORROW_TERM_BLOCKS + 1);

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
          Cl.principal(address1),
          Cl.uint(50000), // Amount to return
          Cl.uint(1000000), // My balance
          Cl.uint(0), // Reservoir balance
          Cl.buffer(myReturnSignature),
          Cl.buffer(reservoirReturnSignature),
          Cl.uint(2), // Nonce
        ],
        deployer
      );
      expect(returnLiquidity.result).toBeOk(Cl.bool(true));

      // Verify the tap balance after returning liquidity
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n);

      // Verify the reservoir balance after returning liquidity
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n + 5000n);

      // get-available-liquidity returns actual tokens held by the reservoir
      const { result: available } = simnet.callPublicFn(
        "reservoir",
        "get-available-liquidity",
        [Cl.none()],
        deployer
      );
      expect(available).toBeOk(Cl.uint(1000005000n));
    });

    it("cannot return liquidity before borrow term ends", () => {
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
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      // Mine enough blocks for the deposit to be confirmed, but not enough for
      // the borrow term to end
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
          Cl.principal(address1),
          Cl.uint(50000), // Amount to return
          Cl.uint(1000000), // My balance
          Cl.uint(0), // Reservoir balance
          Cl.buffer(myReturnSignature),
          Cl.buffer(reservoirReturnSignature),
          Cl.uint(2), // Nonce
        ],
        deployer
      );
      expect(returnLiquidity.result).toBeErr(
        Cl.uint(ReservoirError.Unauthorized)
      );

      // Verify the tap balance after returning liquidity
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n + 50000n);

      // Verify the reservoir balance after returning liquidity
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n - 50000n + 5000n);
    });
  });

  describe("force-closures", () => {
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

      // Wait for the fund to confirm
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);
    });

    it("can force-cancel a tap with borrow-liquidity signatures", () => {
      const amount = 50000;
      const fee = 5000; // 10% of amount
      const userBalance = 1000000;

      const mySignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance,
        amount,
        1,
        reservoirContract
      );

      const reservoirSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount,
        userBalance,
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
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      simnet.mineEmptyBlocks(BORROW_TERM_BLOCKS + 1);

      const forceClose = simnet.callPublicFn(
        "reservoir",
        "force-cancel-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(), // No token
          Cl.principal(address1), // User
        ],
        deployer
      );
      expect(forceClose.result.type).toBe(ClarityType.ResponseOk);
    });

    it("can force-close a tap with transfer signatures", () => {
      const amount = 50000;
      const fee = 5000; // 10% of amount
      const userBalance = 1000000;

      const myDepositSignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance,
        amount,
        1,
        reservoirContract
      );

      const reservoirDepositSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount,
        userBalance,
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
          Cl.buffer(myDepositSignature),
          Cl.buffer(reservoirDepositSignature),
          Cl.uint(1),
        ],
        address1
      );
      expect(borrow.result).toBeOk(
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      simnet.mineEmptyBlocks(BORROW_TERM_BLOCKS + 1);

      // Generate transfer signatures, to be used for force-close
      const mySignature = generateTransferSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance + 100,
        amount - 100,
        5,
        address1
      );

      const reservoirSignature = generateTransferSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount - 100,
        userBalance + 100,
        5,
        address1
      );

      const forceClose = simnet.callPublicFn(
        "reservoir",
        "force-close-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(), // No token
          Cl.principal(address1), // User
          Cl.uint(userBalance + 100), // User balance
          Cl.uint(amount - 100), // Reservoir balance
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(5), // Nonce
          Cl.uint(PipeAction.Transfer), // Action
          Cl.principal(address1), // Actor
          Cl.none(), // No secret
          Cl.none(), // No valid-after
        ],
        deployer
      );
      expect(forceClose.result.type).toBe(ClarityType.ResponseOk);
    });

    it("cannot force-cancel before borrow term ends", () => {
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
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      // Mine enough blocks for the deposit to be confirmed, but not enough for
      // the borrow term to end
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

      const forceCancel = simnet.callPublicFn(
        "reservoir",
        "force-cancel-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(), // No token
          Cl.principal(address1),
        ],
        deployer
      );
      expect(forceCancel.result).toBeErr(Cl.uint(ReservoirError.Unauthorized));

      // Verify the tap balance after returning liquidity
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n + 50000n);

      // Verify the reservoir balance after returning liquidity
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n - 50000n + 5000n);
    });

    it("cannot force-close before borrow term ends", () => {
      const amount = 50000;
      const fee = 5000; // 10% of amount
      const userBalance = 1000000;

      const myDepositSignature = generateDepositSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance,
        amount,
        1,
        reservoirContract
      );

      const reservoirDepositSignature = generateDepositSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount,
        userBalance,
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
          Cl.uint(userBalance),
          Cl.uint(amount),
          Cl.buffer(myDepositSignature),
          Cl.buffer(reservoirDepositSignature),
          Cl.uint(1),
        ],
        address1
      );
      expect(borrow.result).toBeOk(
        Cl.uint(simnet.burnBlockHeight + BORROW_TERM_BLOCKS)
      );
      // Mine enough blocks for the deposit to be confirmed, but not enough for
      // the borrow term to end
      simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

      // Generate transfer signatures, to be used for force-close
      const mySignature = generateTransferSignature(
        address1PK,
        null,
        address1,
        reservoirContract,
        userBalance + 100,
        amount - 100,
        5,
        address1
      );

      const reservoirSignature = generateTransferSignature(
        deployerPK,
        null,
        reservoirContract,
        address1,
        amount - 100,
        userBalance + 100,
        5,
        address1
      );

      const forceClose = simnet.callPublicFn(
        "reservoir",
        "force-close-tap",
        [
          Cl.principal(stackflowContract),
          Cl.none(), // No token
          Cl.principal(address1), // User
          Cl.uint(userBalance), // User balance
          Cl.uint(amount), // Reservoir balance
          Cl.buffer(mySignature),
          Cl.buffer(reservoirSignature),
          Cl.uint(5), // Nonce
          Cl.uint(PipeAction.Transfer), // Action
          Cl.principal(address1), // Actor
          Cl.none(), // No secret
          Cl.none(), // No valid-after
        ],
        deployer
      );
      expect(forceClose.result).toBeErr(Cl.uint(ReservoirError.Unauthorized));

      // Verify the tap balance after returning liquidity
      const stxBalances = simnet.getAssetsMap().get("STX")!;
      const tapBalance = stxBalances.get(stackflowContract);
      expect(tapBalance).toBe(1000000n + 50000n);

      // Verify the reservoir balance after returning liquidity
      const reservoirBalance = stxBalances.get(reservoirContract);
      expect(reservoirBalance).toBe(1000000000n - 50000n + 5000n);
    });
  });
});
