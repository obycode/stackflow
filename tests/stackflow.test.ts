import {
  Cl,
  ClarityType,
  ClarityValue,
  createStacksPrivateKey,
  ResponseOkCV,
  serializeCV,
  signWithKey,
  StacksPrivateKey,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { createHash } from "crypto";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;
const address3 = accounts.get("wallet_3")!;
const stackflowContract = `${deployer}.stackflow`;

const address1PK = createStacksPrivateKey(
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801"
);
const address2PK = createStacksPrivateKey(
  "530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101"
);
const address3PK = createStacksPrivateKey(
  "d655b2523bcd65e34889725c73064feb17ceb796831c0e111ba1a552b0f31b3901"
);

const WAITING_PERIOD = 144;
const MAX_HEIGHT = 340282366920938463463374607431768211455n;

enum ChannelAction {
  Close = "close",
  Transfer = "transfer",
}

enum TxError {
  DepositFailed = 100,
  NoSuchChannel = 101,
  InvalidPrincipal = 102,
  InvalidSenderSignature = 103,
  InvalidOtherSignature = 104,
  ConsensusBuff = 105,
  Unauthorized = 106,
  MaxAllowed = 107,
  InvalidTotalBalance = 108,
  WithdrawalFailed = 109,
  ChannelExpired = 110,
  NonceTooLow = 111,
  CloseInProgress = 112,
  NoCloseInProgress = 113,
  SelfDispute = 114,
}

const structuredDataPrefix = Buffer.from([0x53, 0x49, 0x50, 0x30, 0x31, 0x38]);

const chainIds = {
  mainnet: 1,
  testnet: 2147483648,
};

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function structuredDataHash(structuredData: ClarityValue): Buffer {
  return sha256(Buffer.from(serializeCV(structuredData)));
}

const domainHash = structuredDataHash(
  Cl.tuple({
    name: Cl.stringAscii("StackFlow"),
    version: Cl.stringAscii("0.1.0"),
    "chain-id": Cl.uint(chainIds.testnet),
  })
);

function signStructuredData(
  privateKey: StacksPrivateKey,
  structuredData: ClarityValue
): Buffer {
  const messageHash = structuredDataHash(structuredData);
  const input = sha256(
    Buffer.concat([structuredDataPrefix, domainHash, messageHash])
  );
  const data = signWithKey(privateKey, input.toString("hex")).data;
  return Buffer.from(data.slice(2) + data.slice(0, 2), "hex");
}

function generateChannelSignature(
  privateKey: StacksPrivateKey,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  action: ChannelAction
): Buffer {
  const meFirst = myPrincipal < theirPrincipal;
  const principal1 = meFirst ? myPrincipal : theirPrincipal;
  const principal2 = meFirst ? theirPrincipal : myPrincipal;
  const balance1 = meFirst ? myBalance : theirBalance;
  const balance2 = meFirst ? theirBalance : myBalance;

  const tokenCV =
    token === null
      ? Cl.none()
      : Cl.some(Cl.contractPrincipal(token[0], token[1]));

  const data = Cl.tuple({
    token: tokenCV,
    "principal-1": Cl.principal(principal1),
    "principal-2": Cl.principal(principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(nonce),
    action: Cl.stringAscii(action),
  });
  return signStructuredData(privateKey, data);
}

function generateCloseChannelSignature(
  privateKey: StacksPrivateKey,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number
): Buffer {
  return generateChannelSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    ChannelAction.Close
  );
}

function generateTransferSignature(
  privateKey: StacksPrivateKey,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number
): Buffer {
  return generateChannelSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    ChannelAction.Transfer
  );
}

describe("close-channel", () => {
  it("account 1 can close account with no transfers", () => {
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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

  it("account 2 can close account with no transfers", () => {
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      1000000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    expect(result).toBeErr(Cl.uint(TxError.InvalidSenderSignature));

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
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    expect(result).toBeErr(Cl.uint(TxError.InvalidOtherSignature));

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("account 1 cannot close with bad total balance", () => {
    // Setup the channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures
    const signature1 = generateCloseChannelSignature(
      address1PK,
      null,
      address1,
      address2,
      2000000,
      2000000,
      1
    );
    const signature2 = generateCloseChannelSignature(
      address2PK,
      null,
      address2,
      address1,
      2000000,
      2000000,
      1
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "close-channel",
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
    expect(result).toBeErr(Cl.uint(TxError.InvalidTotalBalance));

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
  it("account 1 can force cancel a channel", () => {
    // Setup the channel and save the channel key
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    const current_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(Cl.uint(current_height + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(current_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
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

  it("account 2 can force cancel channel", () => {
    // Setup the channel and save the channel key
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;

    const current_height = simnet.burnBlockHeight;
    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(Cl.uint(current_height + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(current_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address2)),
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

  it("canceling a non-existent channel gives an error", () => {
    // Setup a channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "force-cancel",
      [Cl.none(), Cl.principal(address1)],
      address3
    );
    expect(result).toBeErr(Cl.uint(TxError.NoSuchChannel));
  });
});

describe("dispute-closure", () => {
  it("disputing a non-existent channel gives an error", () => {
    // Setup a channel
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );

    // Create the signatures for a transfer
    const data = Cl.tuple({
      token: Cl.none(),
      "principal-1": Cl.principal(address1),
      "principal-2": Cl.principal(address3),
      "balance-1": Cl.uint(1300000),
      "balance-2": Cl.uint(1700000),
      nonce: Cl.uint(1),
      action: Cl.stringAscii(ChannelAction.Transfer),
    });
    const signature1 = signStructuredData(address1PK, data);
    const signature3 = signStructuredData(address3PK, data);

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
      ],
      address3
    );
    expect(result).toBeErr(Cl.uint(TxError.NoSuchChannel));
  });

  it("disputing a channel that is not closing gives an error", () => {
    // Setup the channel and save the channel key
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;

    // Create the signatures for a transfer
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1300000,
      1700000,
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
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
      ],
      address2
    );
    expect(disputeResult).toBeErr(Cl.uint(TxError.NoCloseInProgress));

    // Verify that the map entry is unchanged
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
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
    // Setup the channel and save the channel key
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;

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
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
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
      ],
      address2
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the channel has been deleted
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeNone();

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
    // Setup the channel and save the channel key
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;

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
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
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
      ],
      address1
    );
    expect(disputeResult).toBeOk(Cl.bool(false));

    // Verify that the channel has been deleted
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeNone();

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
    // Setup the channel and save the channel key
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result: fundResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(fundResult.type).toBe(ClarityType.ResponseOk);
    const channelKey = (fundResult as ResponseOkCV).value;

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
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1700000,
      1300000,
      1
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
      ],
      address1
    );
    expect(disputeResult).toBeErr(Cl.uint(TxError.SelfDispute));

    // Verify that the map entry is unchanged
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(cancel_height + WAITING_PERIOD),
        nonce: Cl.uint(0),
        closer: Cl.some(Cl.principal(address1)),
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

describe("get-channel-balances", () => {
  it("returns the channel balances", () => {
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "get-channel-balances",
      [Cl.none(), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(0),
        "expires-at": Cl.uint(340282366920938463463374607431768211455n),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );
  });
});

describe("verify-signed-structured-data", () => {
  it("verifies the signed structured data", () => {
    const data = Cl.tuple({
      foo: Cl.uint(123),
      bar: Cl.stringAscii("hello world"),
    });
    const dataHash = structuredDataHash(data);
    const signature = signStructuredData(address1PK, data);
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signed-structured-data",
      [Cl.buffer(dataHash), Cl.buffer(signature), Cl.principal(address1)],
      address1
    );
    expect(result).toBeBool(true);
  });

  it("fails to verify the signed structured data", () => {
    const data = Cl.stringAscii("hello world");
    const dataHash = structuredDataHash(data);
    const signature = signStructuredData(address1PK, Cl.stringAscii("foo bar"));
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "verify-signed-structured-data",
      [Cl.buffer(dataHash), Cl.buffer(signature), Cl.principal(address1)],
      address1
    );
    expect(result).toBeBool(false);
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

describe("get-channel-key", () => {
  it("ensures the channel key is built correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-channel-key",
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

  it("ensures the channel key is ordered correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-channel-key",
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

  it("ensures the channel key includes the specified token", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "get-channel-key",
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
        Cl.tuple({ "balance-1": Cl.uint(100), "balance-2": Cl.uint(0) }),
        Cl.none(),
        Cl.uint(123),
      ],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        "balance-1": Cl.uint(223),
        "balance-2": Cl.uint(0),
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
        Cl.tuple({ "balance-1": Cl.uint(100), "balance-2": Cl.uint(0) }),
        Cl.none(),
        Cl.uint(123),
      ],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        "balance-1": Cl.uint(100),
        "balance-2": Cl.uint(123),
      })
    );
  });
});

describe("make-channel-data", () => {
  it("ensures the channel data is built correctly", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "make-channel-data",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(100),
        Cl.uint(0),
        Cl.uint(4),
        Cl.stringAscii(ChannelAction.Transfer),
      ],
      address1
    );
    expect(result).toBeTuple({
      token: Cl.none(),
      "principal-1": Cl.principal(address1),
      "principal-2": Cl.principal(address2),
      "balance-1": Cl.uint(100),
      "balance-2": Cl.uint(0),
      nonce: Cl.uint(4),
      action: Cl.stringAscii(ChannelAction.Transfer),
    });
  });

  it("ensures the channel data is built correctly from principal-2", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "make-channel-data",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.uint(120),
        Cl.uint(80),
        Cl.uint(7),
        Cl.stringAscii(ChannelAction.Close),
      ],
      address2
    );
    expect(result).toBeTuple({
      token: Cl.none(),
      "principal-1": Cl.principal(address1),
      "principal-2": Cl.principal(address2),
      "balance-1": Cl.uint(80),
      "balance-2": Cl.uint(120),
      nonce: Cl.uint(7),
      action: Cl.stringAscii(ChannelAction.Close),
    });
  });
});
