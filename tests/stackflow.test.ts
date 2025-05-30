import {
  Cl,
  ClarityType,
  ClarityValue,
  ResponseOkCV,
} from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deployer,
  StackflowError,
  address2,
  address1,
  address3,
  stackflowContract,
  CONFIRMATION_DEPTH,
  MAX_HEIGHT,
  generateClosePipeSignature,
  address1PK,
  address2PK,
  WAITING_PERIOD,
  generateTransferSignature,
  PipeAction,
  generateDepositSignature,
  generateWithdrawSignature,
  address3PK,
  structuredDataHashWithPrefix,
  sha256,
} from "./utils";

describe("init", () => {
  it("can initialize the contract for STX", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.none()],
      deployer
    );
    expect(result).toBeOk(Cl.bool(true));
  });

  it("can initialize the contract for a SIP-010 token", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.some(Cl.principal(`${deployer}.test-token`))],
      deployer
    );
    expect(result).toBeOk(Cl.bool(true));
  });

  it("cannot initialize the contract twice", () => {
    const { result: initResult } = simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.none()],
      deployer
    );
    expect(initResult).toBeOk(Cl.bool(true));
    const { result } = simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.none()],
      deployer
    );
    expect(result).toBeErr(Cl.uint(StackflowError.AlreadyInitialized));
  });

  it("cannot fund a pipe before initializing the contract", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NotInitialized));
  });
});

describe("register-agent", () => {
  it("can register an agent", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );
    expect(result).toBeOk(Cl.bool(true));

    // Verify the map has been updated
    const agent = simnet.getMapEntry(
      stackflowContract,
      "agents",
      Cl.principal(address1)
    );
    expect(agent).toBeSome(Cl.principal(address3));
  });

  it("can overwrite an agent", () => {
    const { result: result1 } = simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );
    expect(result1).toBeOk(Cl.bool(true));

    const { result } = simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.bool(true));

    // Verify the map has been updated
    const agent = simnet.getMapEntry(
      stackflowContract,
      "agents",
      Cl.principal(address1)
    );
    expect(agent).toBeSome(Cl.principal(address2));
  });
});

describe("deregister-agent", () => {
  it("can deregister an agent", () => {
    const { result: result1 } = simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );
    expect(result1).toBeOk(Cl.bool(true));

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deregister-agent",
      [],
      address1
    );
    expect(result).toBeOk(Cl.bool(true));

    // Verify the map has been updated
    const agent = simnet.getMapEntry(
      stackflowContract,
      "agents",
      Cl.principal(address1)
    );
    expect(agent).toBeNone();
  });
});

describe("fund-pipe", () => {
  it("can fund a pipe", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;
    const burnBlockHeight = simnet.burnBlockHeight;

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(1000000n);

    // Verify that the funded amount can not be spent yet
    const { result: resultBefore } = simnet.callPrivateFn(
      "stackflow",
      "balance-check",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(0),
        Cl.uint(1000000),
        Cl.none(),
      ],
      address1
    );
    expect(resultBefore).toBeErr(Cl.uint(StackflowError.InvalidBalances));

    // Wait for the fund to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Verify that the funded amount can be spent
    const { result: resultAfter } = simnet.callPrivateFn(
      "stackflow",
      "balance-check",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(0),
        Cl.uint(1000000),
        Cl.none(),
      ],
      address1
    );
    expect(resultAfter).toBeOk(Cl.bool(true));
  });

  it("can fund a pipe that has been funded by the other party", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;
    const burnBlockHeight = simnet.burnBlockHeight;

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund a pipe that has already been funded", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const burnBlockHeight = simnet.burnBlockHeight;

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Wait for the fund to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(badResult).toBeErr(Cl.uint(StackflowError.AlreadyFunded));

    // Verify the pipe did not change
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(1000000n);
  });

  it("cannot fund a pipe that has already been funded (but pending)", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const burnBlockHeight = simnet.burnBlockHeight;

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(badResult).toBeErr(Cl.uint(StackflowError.AlreadyPending));

    // Verify the pipe did not change
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(1000000n);
  });

  it("second account cannot fund a pipe that has already been funded", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const burnBlockHeight = simnet.burnBlockHeight;

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Verify the pipe
    const pipeBefore = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipeBefore).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Wait for the fund to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(3000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(badResult).toBeErr(Cl.uint(StackflowError.AlreadyFunded));

    // Verify the pipe did not change
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund pipe with unapproved token", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Give address1 and address2 some test tokens
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address1)],
      deployer
    );
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address2)],
      deployer
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.UnapprovedToken));
  });

  it("can fund a pipe with an approved token", () => {
    // Give address1 and address2 some test tokens
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address1)],
      deployer
    );
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address2)],
      deployer
    );

    const burnBlockHeight = simnet.burnBlockHeight;

    // Initialize the contract for test-token
    simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.some(Cl.principal(`${deployer}.test-token`))],
      deployer
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.some(Cl.principal(`${deployer}.test-token`)),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const tokenBalances = simnet.getAssetsMap().get(".test-token.test-coin")!;

    const balance1 = tokenBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = tokenBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = tokenBalances.get(stackflowContract);
    expect(contractBalance).toBe(1000000n);
  });

  it("can fund a SIP-010 token pipe that has been funded by the other party", () => {
    // Give address1 and address2 some test tokens
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address1)],
      deployer
    );
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address2)],
      deployer
    );

    // Initialize the contract for test-token
    simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.some(Cl.principal(`${deployer}.test-token`))],
      deployer
    );

    const burnBlockHeight = simnet.burnBlockHeight;

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address1),
        Cl.uint(0),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.some(Cl.principal(`${deployer}.test-token`)),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );

    // Verify the balances
    const tokenBalances = simnet.getAssetsMap().get(".test-token.test-coin")!;

    const balance1 = tokenBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = tokenBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = tokenBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund a SIP-010 token pipe that has already been funded", () => {
    // Give address1 and address2 some test tokens
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address1)],
      deployer
    );
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address2)],
      deployer
    );

    // Initialize the contract for test-token
    simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.some(Cl.principal(`${deployer}.test-token`))],
      deployer
    );

    const burnBlockHeight = simnet.burnBlockHeight;

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.some(Cl.principal(`${deployer}.test-token`)),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Wait for the fund to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    expect(badResult).toBeErr(Cl.uint(StackflowError.AlreadyFunded));

    // Verify the pipe did not change
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const tokenBalances = simnet.getAssetsMap().get(".test-token.test-coin")!;

    const balance1 = tokenBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = tokenBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = tokenBalances.get(stackflowContract);
    expect(contractBalance).toBe(1000000n);
  });

  it("second account cannot fund a SIP-010 token pipe that has already been funded", () => {
    // Give address1 and address2 some test tokens
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address1)],
      deployer
    );
    simnet.callPublicFn(
      "test-token",
      "mint",
      [Cl.uint(100000000000000n), Cl.principal(address2)],
      deployer
    );

    // Initialize the contract for test-token
    simnet.callPublicFn(
      "stackflow",
      "init",
      [Cl.some(Cl.principal(`${deployer}.test-token`))],
      deployer
    );

    const burnBlockHeight = simnet.burnBlockHeight;

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
        Cl.uint(0),
      ],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address1),
        Cl.uint(0),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.some(Cl.principal(`${deployer}.test-token`)),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (result as ResponseOkCV).value;

    // Verify the pipe
    const pipeBefore = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipeBefore).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Wait for the fund to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(3000000),
        Cl.principal(address1),
        Cl.uint(0),
      ],
      address2
    );
    expect(badResult).toBeErr(Cl.uint(StackflowError.AlreadyFunded));

    // Verify the pipe did not change
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    // Verify the balances
    const tokenBalances = simnet.getAssetsMap().get(".test-token.test-coin")!;

    const balance1 = tokenBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = tokenBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = tokenBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

describe("close-pipe", () => {
  it("account 1 can close account with no transfers", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address1
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1000000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );
    expect(result).toBeOk(Cl.bool(false));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);
  });

  it("account 1 can close account with a 0 balance", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      0,
      2000000,
      1,
      address1
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      0,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(0),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );
    expect(result).toBeOk(Cl.bool(false));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);
  });

  it("account 2 can close account with no transfers", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address2
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(2000000),
        Cl.uint(1000000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
      ],
      address2
    );
    expect(result).toBeOk(Cl.bool(false));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);
  });

  it("account 1 can close account with transfers", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address1
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );
    expect(result).toBeOk(Cl.bool(false));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000600000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999400000n);
  });

  it("account 2 can close account with transfers", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
      ],
      address2
    );
    expect(result).toBeOk(Cl.bool(false));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);
  });

  it("account 1 fails with 2 bad signatures", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address1
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 fails with bad other signature", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address2
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
      ],
      address2
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidOtherSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot close with bad total balance", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      2000000,
      2000000,
      1,
      address1
    );
    const signature2 = generateClosePipeSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      2000000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-pipe",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(2000000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidTotalBalance));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

describe("force-cancel", () => {
  it("account 1 can force cancel a pipe", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const current_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(current_height + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(current_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 can force cancel pipe", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const current_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(Cl.uint(current_height + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(current_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address2)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("canceling a non-existent pipe gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup a pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address3
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NoSuchPipe));
  });
});

describe("force-close", () => {
  // Initialize the contract for STX
  simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

  it("account 1 can force-close", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2
    );

    let heightBefore = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 can force-close", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2
    );

    let heightBefore = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1400000),
        Cl.uint(1600000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address2
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
        closer: Cl.some(Cl.principal(address2)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 1 fails with 2 bad signatures", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 fails with bad other signature", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address2
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidOtherSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot close with bad total balance", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      2000000,
      2000000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      2000000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(2000000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidTotalBalance));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("force-close fails when valid-after is in future", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const futureBlock = simnet.burnBlockHeight + 10;

    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address1,
      null,
      futureBlock
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address1,
      null,
      futureBlock
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address1),
        Cl.none(),
        Cl.some(Cl.uint(futureBlock)),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.NotValidYet));
  });

  it("cannot force-close with deposit signatures that were never applied", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      1050000,
      2000000,
      1,
      address1
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1050000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1050000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Deposit),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidTotalBalance));
  });

  it("cannot force-close with withdraw signatures that were never applied", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1050000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Withdraw),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidTotalBalance));
  });
});

describe("dispute-closure", () => {
  it("disputing a non-existent pipe gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup a pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address3,
      1300000,
      1700000,
      1,
      address2
    );
    const signature3 = generateTransferSignature(
      address3PK,
      null,
      address3,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature3),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NoSuchPipe));
  });

  it("disputing a pipe that is not closing gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const burnBlockHeight = simnet.burnBlockHeight;

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 2 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address2
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.NoCloseInProgress));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 can dispute account 1's closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 2 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address2
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 can dispute account 2's closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 1 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1300000),
        Cl.uint(1700000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 cannot dispute its own closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address1
    );

    simnet.mineEmptyBurnBlock();

    // Account 1 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1300000),
        Cl.uint(1700000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.SelfDispute));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(cancel_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 can dispute account 1's closure with an agent-signed transfer", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent for address 1
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address3PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 2 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "dispute-closure",
      [
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address2
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });
});

describe("agent-dispute-closure", () => {
  it("disputing a non-existent pipe gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );

    // Setup a pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address3,
      1300000,
      1700000,
      1,
      address3
    );
    const signature3 = generateTransferSignature(
      address2PK,
      null,
      address3,
      address1,
      1700000,
      1300000,
      1,
      address3
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address1),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature3),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address3),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NoSuchPipe));
  });

  it("disputing a pipe that is not closing gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address2
    );

    const burnBlockHeight = simnet.burnBlockHeight;

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 2 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address2),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.NoCloseInProgress));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 2 can dispute account 1's closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address2
    );

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 2 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address2),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1700000),
        Cl.uint(1300000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 can dispute account 2's closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    // Account 1 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address1),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1300000),
        Cl.uint(1700000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000300000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999700000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 cannot dispute its own closure", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Register an agent
    simnet.callPublicFn(
      "stackflow",
      "register-agent",
      [Cl.principal(address3)],
      address1
    );

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlock();

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1,
      address2
    );

    simnet.mineEmptyBurnBlock();

    // Account 1 disputes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address1),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1300000),
        Cl.uint(1700000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.SelfDispute));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(cancel_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

describe("finalize", () => {
  it("finalizing a non-existent pipe gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup a pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address1)],
      address3
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NoSuchPipe));
  });

  it("finalizing a pipe that is not closing gives an error", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    const burnBlockHeight = simnet.burnBlockHeight;

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Account 2 tries to finalize a closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.NoCloseInProgress));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 1 can finalize account 1's cancel", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height beyond the waiting period
    simnet.mineEmptyBurnBlocks(WAITING_PERIOD + 1);

    // Account 1 finalizes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 can finalize account 2's cancel", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlocks(WAITING_PERIOD + 1);

    // Account 1 finalizes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(100000000000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("account 1 can finalize account 1's force-close", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2
    );

    let heightBefore = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlocks(WAITING_PERIOD + 1);

    // Account 1 finalizes the closure
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the pipe has been reset
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(100000000600000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999999400000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(0n);
  });

  it("pipe cannot be finalized before waiting period has passed", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe and save the pipe key
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const cancel_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(cancel_height + WAITING_PERIOD));

    // Increment the burn block height
    simnet.mineEmptyBurnBlocks(WAITING_PERIOD - 1);

    // Account 1 tries to finalize the closure early
    const { result: disputeResult } = simnet.callPublicFn(
      "stackflow",
      "finalize",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(disputeResult).toBeErr(Cl.uint(StackflowError.NotExpired));

    // Verify that the map entry is unchanged
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(cancel_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

describe("deposit", () => {
  it("can deposit to a valid pipe from account1", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      1050000,
      2000000,
      1,
      address1
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1050000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1050000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999998950000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(50000),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
      })
    );
  });

  it("can deposit to a valid pipe from account2", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2050000,
      3,
      address2
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2050000,
      1000000,
      3,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(2050000),
        Cl.uint(1000000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(3),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999997950000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(3),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(50000),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );
  });

  it("can deposit after transfers", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      10000,
      3040000,
      3,
      address2
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      3040000,
      10000,
      3,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(3040000),
        Cl.uint(10000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(3),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999997950000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(10000),
        "balance-2": Cl.uint(2990000n),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(3),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(50000),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );
  });

  it("cannot deposit into non-existant pipe", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      3040000,
      10000,
      3,
      address1
    );
    const signature3 = generateDepositSignature(
      address3PK,
      null,
      address2,
      address1,
      10000,
      3040000,
      3,
      address1
    );

    // Try a deposit when no pipes exist
    const { result: result1 } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address3),
        Cl.uint(10000),
        Cl.uint(3040000),
        Cl.buffer(signature1),
        Cl.buffer(signature3),
        Cl.uint(3),
      ],
      address1
    );
    expect(result1).toBeErr(Cl.uint(StackflowError.NoSuchPipe));

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Try a deposit when one other pipe exists
    const { result: result2 } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address3),
        Cl.uint(10000),
        Cl.uint(3040000),
        Cl.buffer(signature1),
        Cl.buffer(signature3),
        Cl.uint(3),
      ],
      address1
    );
    expect(result2).toBeErr(Cl.uint(StackflowError.NoSuchPipe));
  });

  it("can not deposit with bad signatures", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      10000,
      3040000,
      3,
      address2
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      3040000,
      10000,
      3,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(3030000),
        Cl.uint(20000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(3),
      ],
      address2
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );
  });

  it("cannot deposit with an old nonce", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      1050000,
      2000000,
      1,
      address1
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1050000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1050000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Wait for the deposit to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result: result2 } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(10000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1060000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result2).toBeErr(Cl.uint(StackflowError.NonceTooLow));

    // Verify the balances did not change with the failed deposit
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999998950000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the pipe did not change with the failed deposit
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(50000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.none(),
      })
    );
  });

  it("fails deposit with invalid balances", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Try deposit with invalid balances
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      500000, // Balance less than deposit amount
      2000000,
      1,
      address1
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(1000000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(500000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidBalances));
  });
});

describe("withdraw", () => {
  it("can withdraw from a valid pipe from account1", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(500000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999500000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(2500000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(500000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );
  });

  it("can withdraw from a valid pipe from account2", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address2
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(2000000),
        Cl.uint(500000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
      ],
      address2
    );

    expect(result).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998500000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(2500000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(500000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );
  });

  it("cannot withdraw with a bad sender signature", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(500000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );
  });

  it("cannot withdraw with an invalid other signature", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2500000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(500000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidOtherSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );
  });

  it("cannot withdraw as the wrong actor", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(2000000),
        Cl.uint(500000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
      ],
      address2
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );
  });

  it("cannot withdraw with an old nonce", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const pipeKey = (fundResult as ResponseOkCV).value;

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a deposit
    const depositSignature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      1050000,
      2000000,
      1,
      address1
    );
    const depositSignature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1050000,
      1,
      address1
    );

    const { result: depositResult } = simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(50000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1050000),
        Cl.uint(2000000),
        Cl.buffer(depositSignature1),
        Cl.buffer(depositSignature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(depositResult).toBeOk(
      Cl.tuple({
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
        token: Cl.none(),
      })
    );

    // Wait for the deposit to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures for a withdraw
    const signature1 = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      500000,
      2000000,
      1,
      address1
    );
    const signature2 = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      500000,
      1,
      address1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(500000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.NonceTooLow));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999998950000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the pipe
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(50000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.none(),
      })
    );
  });
});

describe("multiple deposits and withdrawals", () => {
  it("can perform multiple deposits and withdrawals in sequence", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // First deposit
    const signature1Deposit1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      2000000,
      2000000,
      1,
      address1
    );
    const signature2Deposit1 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      2000000,
      1,
      address1
    );

    simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(1000000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(2000000),
        Cl.uint(2000000),
        Cl.buffer(signature1Deposit1),
        Cl.buffer(signature2Deposit1),
        Cl.uint(1),
      ],
      address1
    );

    // Second deposit
    const signature1Deposit2 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      3000000,
      2000000,
      2,
      address2
    );
    const signature2Deposit2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      3000000,
      2,
      address2
    );

    simnet.callPublicFn(
      "stackflow",
      "deposit",
      [
        Cl.uint(1000000),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(2000000),
        Cl.uint(3000000),
        Cl.buffer(signature2Deposit2),
        Cl.buffer(signature1Deposit2),
        Cl.uint(2),
      ],
      address2
    );

    // Wait for the deposits to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Withdraw
    const signature1Withdraw = generateWithdrawSignature(
      address1PK,
      null,
      address1,
      address2,
      2500000,
      2000000,
      3,
      address1
    );
    const signature2Withdraw = generateWithdrawSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      2500000,
      3,
      address1
    );

    simnet.callPublicFn(
      "stackflow",
      "withdraw",
      [
        Cl.uint(500000),
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(2500000),
        Cl.uint(2000000),
        Cl.buffer(signature1Withdraw),
        Cl.buffer(signature2Withdraw),
        Cl.uint(3),
      ],
      address1
    );

    // Verify final balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    const balance2 = stxBalances.get(address2);
    const contractBalance = stxBalances.get(stackflowContract);

    expect(balance1).toBe(99999998500000n);
    expect(balance2).toBe(99999997000000n);
    expect(contractBalance).toBe(4500000n);
  });
});

describe("agent-dispute additional tests", () => {
  it("agent-dispute-closure fails when agent not registered", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Force close
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address1
    );

    simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    // Try to dispute with unregistered agent
    const { result } = simnet.callPublicFn(
      "stackflow",
      "agent-dispute-closure",
      [
        Cl.principal(address2),
        Cl.none(),
        Cl.principal(address1),
        Cl.uint(1400000),
        Cl.uint(1600000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address3
    );

    expect(result).toBeErr(Cl.uint(StackflowError.Unauthorized));
  });
});

describe("get-pipe", () => {
  it("returns the pipe info", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "get-pipe",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(340282366920938463463374607431768211455n),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
      })
    );
  });
});

describe("contract-of-optional", () => {
  it("returns the contract principal", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "contract-of-optional",
      [Cl.some(Cl.contractPrincipal(deployer, "test-token"))],
      address1
    );
    expect(result).toBeSome(Cl.contractPrincipal(deployer, "test-token"));
  });

  it("returns none", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "contract-of-optional",
      [Cl.none()],
      address1
    );
    expect(result).toBeNone();
  });
});

describe("get-pipe-key", () => {
  it("ensures the pipe key is built correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-pipe-key",
      [Cl.none(), Cl.principal(address1), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
  });

  it("ensures the pipe key is ordered correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-pipe-key",
      [Cl.none(), Cl.principal(address2), Cl.principal(address1)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
  });

  it("ensures the pipe key includes the specified token", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-pipe-key",
      [
        Cl.some(Cl.contractPrincipal(address1, "test-token")),
        Cl.principal(address1),
        Cl.principal(address2),
      ],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.some(Cl.contractPrincipal(address1, "test-token")),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
  });
});

describe("increase-sender-balance", () => {
  it("increases the balance of principal-1", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "increase-sender-balance",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({
          "balance-1": Cl.uint(100),
          "balance-2": Cl.uint(0),
          "expires-at": Cl.uint(0),
          nonce: Cl.uint(0),
          closer: Cl.none(),
          "pending-1": Cl.none(),
          "pending-2": Cl.none(),
        }),
        Cl.none(),
        Cl.uint(123),
      ],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        "balance-1": Cl.uint(100),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(0),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(123),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
        "pending-2": Cl.none(),
      })
    );
  });

  it("increases the balance of principal-2", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "increase-sender-balance",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({
          "balance-1": Cl.uint(100),
          "balance-2": Cl.uint(0),
          "expires-at": Cl.uint(0),
          nonce: Cl.uint(0),
          closer: Cl.none(),
          "pending-1": Cl.none(),
          "pending-2": Cl.none(),
        }),
        Cl.none(),
        Cl.uint(123),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        "balance-1": Cl.uint(100),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(0),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.none(),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(123),
            "burn-height": Cl.uint(simnet.burnBlockHeight + CONFIRMATION_DEPTH),
          })
        ),
      })
    );
  });
});

describe("execute-withdraw", () => {
  it("fails when the contract has no balance", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "execute-withdraw",
      [Cl.none(), Cl.uint(100)],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.WithdrawalFailed));
  });

  it("passes when the contract has a sufficient balance", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result } = simnet.callPrivateFn(
      "stackflow",
      "execute-withdraw",
      [Cl.none(), Cl.uint(100)],
      address1
    );
    expect(result).toBeOk(Cl.bool(true));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000100n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(999900n);
  });

  it("fails when the contract has an insufficient balance", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(100), Cl.principal(address2), Cl.uint(0)],
      address1
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const { result } = simnet.callPrivateFn(
      "stackflow",
      "execute-withdraw",
      [Cl.none(), Cl.uint(101)],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.WithdrawalFailed));

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999999900n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(100n);
  });
});

describe("transfers with secrets", () => {
  it("can transfer and force-close with a secret", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2,
      "1234567890abcdef"
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2,
      "1234567890abcdef"
    );

    let heightBefore = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.some(Cl.bufferFromHex("1234567890abcdef")),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("force-close with incorrect secret fails", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2,
      "1234567890abcdef"
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2,
      "1234567890abcdef"
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.some(Cl.bufferFromHex("1234567890abcdee")),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSenderSignature));

    // Verify that the map has not changed
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

describe("make-structured-data-hash", () => {
  it("makes the structured data hash for a transfer", () => {
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "make-structured-data-hash",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(10000),
        Cl.uint(20000),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    const data = Cl.tuple({
      token: Cl.none(),
      "principal-1": Cl.principal(address1),
      "principal-2": Cl.principal(address2),
      "balance-1": Cl.uint(10000),
      "balance-2": Cl.uint(20000),
      nonce: Cl.uint(1),
      action: Cl.uint(PipeAction.Transfer),
      actor: Cl.principal(address2),
      "hashed-secret": Cl.none(),
      "valid-after": Cl.none(),
    });
    const expectedHash = structuredDataHashWithPrefix(data);
    expect(result).toBeOk(Cl.buffer(expectedHash));
  });

  it("makes the structured data hash for a close", () => {
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "make-structured-data-hash",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(12345),
        Cl.uint(98765),
        Cl.uint(2),
        Cl.uint(PipeAction.Close),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    const data = Cl.tuple({
      token: Cl.none(),
      "principal-1": Cl.principal(address1),
      "principal-2": Cl.principal(address2),
      "balance-1": Cl.uint(12345),
      "balance-2": Cl.uint(98765),
      nonce: Cl.uint(2),
      action: Cl.uint(PipeAction.Close),
      actor: Cl.principal(address1),
      "hashed-secret": Cl.none(),
      "valid-after": Cl.none(),
    });
    const expectedHash = structuredDataHashWithPrefix(data);
    expect(result).toBeOk(Cl.buffer(expectedHash));
  });
});

describe("transfers with valid-after", () => {
  it("can transfer and force-close with a past valid-after", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    let heightBefore = simnet.burnBlockHeight;

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2,
      null,
      heightBefore
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2,
      null,
      heightBefore
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.some(Cl.uint(heightBefore)),
      ],
      address1
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
        closer: Cl.some(Cl.principal(address1)),
        "pending-1": Cl.none(),
        "pending-2": Cl.none(),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("force-close with future valid-after fails", () => {
    // Initialize the contract for STX
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Setup the pipe
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(0)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const pipeKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1), Cl.uint(0)],
      address2
    );

    // Wait for the funds to confirm
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);

    const heightBefore = simnet.burnBlockHeight;

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1,
      address2,
      null,
      heightBefore + 10
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1,
      address2,
      null,
      heightBefore + 10
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.some(Cl.uint(heightBefore + 10)),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(StackflowError.NotValidYet));

    // Verify that the map has not changed
    const pipe = simnet.getMapEntry(stackflowContract, "pipes", pipeKey);
    expect(pipe).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(0),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
        "pending-1": Cl.some(
          Cl.tuple({
            amount: Cl.uint(1000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
        "pending-2": Cl.some(
          Cl.tuple({
            amount: Cl.uint(2000000),
            "burn-height": Cl.uint(simnet.burnBlockHeight),
          })
        ),
      })
    );

    // Verify the balances have not changed yet
    const stxBalances = simnet.getAssetsMap().get("STX")!;
    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });
});

// `verify-signature` is the read-only function that users can call off-chain
// to validate a signature.
describe("verify-signature", () => {
  var pipeKey: ClarityValue;

  // Setup - ensure contract is initialized
  beforeEach(() => {
    // Initialize the contract
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Fund a pipe
    let { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(10)],
      address1
    );
    expect(result.type).toBe(ClarityType.ResponseOk);
    pipeKey = (result as ResponseOkCV).value;

    // Mine blocks to confirm the transaction
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);
  });

  it("validates a valid signature", () => {
    const balance1 = 600000;
    const balance2 = 400000;
    const nonce = 11;

    const signature = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address2
    );
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeOk(Cl.none());
  });

  it("rejects signature from wrong signer", () => {
    const balance1 = 500000;
    const balance2 = 500000;
    const nonce = 21;

    const signature1 = generateClosePipeSignature(
      address3PK, // Wrong signer
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1
    );

    // Using the wrong signer for the signature
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Close),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSignature));
  });

  it("rejects signature over the wrong data", () => {
    const balance1 = 500000;
    const balance2 = 500000;
    const nonce = 21;

    const signature1 = generateClosePipeSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1
    );

    // Using the wrong signer for the signature
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce + 1), // Different nonce
        Cl.uint(PipeAction.Close),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSignature));
  });

  it("rejects signature with invalid balances", () => {
    const balance1 = 600000;
    const balance2 = 500000;
    const nonce = 21;

    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1
    );

    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Close),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidTotalBalance));
  });

  it("rejects signature with invalid nonce", () => {
    const balance1 = 700000;
    const balance2 = 300000;
    const nonce = 10; // Nonce is too low, should be > 10

    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1
    );

    // Using the wrong signer for the signature
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Close),
        Cl.principal(address1),
        Cl.none(),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.NonceTooLow));
  });

  it("accepts valid signature with past `valid-after`", () => {
    const balance1 = 1000000;
    const balance2 = 0;
    const nonce = 11;
    const validAfter = simnet.burnBlockHeight - 2; // Past block height

    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1,
      null,
      validAfter
    );

    // Using the wrong signer for the signature
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address1),
        Cl.none(),
        Cl.some(Cl.uint(validAfter)),
      ],
      address1
    );

    expect(result).toBeOk(Cl.none());
  });

  it("accepts valid signature with future `valid-after`", () => {
    const balance1 = 1000000;
    const balance2 = 0;
    const nonce = 11;
    const validAfter = simnet.burnBlockHeight + 2; // Future block height

    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address1,
      null,
      validAfter
    );

    // Using the wrong signer for the signature
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature",
      [
        Cl.buffer(signature1),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address1),
        Cl.none(),
        Cl.some(Cl.uint(validAfter)),
      ],
      address1
    );

    expect(result).toBeOk(
      Cl.some(Cl.uint(validAfter - simnet.burnBlockHeight))
    );
  });
});

// `verify-signature-with-secret` is the read-only function that users can call
// off-chain to validate a signature and the corresponding secret.
describe("verify-signature-with-secret", () => {
  var pipeKey: ClarityValue;

  // Setup - ensure contract is initialized
  beforeEach(() => {
    // Initialize the contract
    simnet.callPublicFn("stackflow", "init", [Cl.none()], deployer);

    // Fund a pipe
    let { result } = simnet.callPublicFn(
      "stackflow",
      "fund-pipe",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2), Cl.uint(10)],
      address1
    );
    expect(result.type).toBe(ClarityType.ResponseOk);
    pipeKey = (result as ResponseOkCV).value;

    // Mine blocks to confirm the transaction
    simnet.mineEmptyBlocks(CONFIRMATION_DEPTH);
  });

  it("validates a valid signature with valid secret", () => {
    const balance1 = 600000;
    const balance2 = 400000;
    const nonce = 11;
    const secret = "01234567890abcdef";

    const signature = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address2,
      secret
    );
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature-with-secret",
      [
        Cl.buffer(signature),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.some(Cl.buffer(Buffer.from(secret, "hex"))),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeOk(Cl.none());
  });

  it("fails with an invalid secret", () => {
    const balance1 = 600000;
    const balance2 = 400000;
    const nonce = 11;
    const secret = "0123456789abcdef";
    const invalid = "0123456789abcdee";

    const signature = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      balance1,
      balance2,
      nonce,
      address2,
      secret
    );
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signature-with-secret",
      [
        Cl.buffer(signature),
        Cl.principal(address1),
        pipeKey,
        Cl.uint(balance1),
        Cl.uint(balance2),
        Cl.uint(nonce),
        Cl.uint(PipeAction.Transfer),
        Cl.principal(address2),
        Cl.some(Cl.buffer(Buffer.from(invalid, "hex"))),
        Cl.none(),
      ],
      address1
    );

    expect(result).toBeErr(Cl.uint(StackflowError.InvalidSignature));
  });
});
