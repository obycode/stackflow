import {
  Cl,
  ClarityType,
  ClarityValue,
  createStacksPrivateKey,
  cvToString,
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
  Close = 0,
  Transfer = 1,
  Deposit = 2,
  Withdraw = 3,
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
  AlreadyFunded = 115,
  InvalidWithdrawal = 116,
  UnapprovedToken = 117,
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
  action: ChannelAction,
  actor: string | null = null
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
  const actorCV = actor === null ? Cl.none() : Cl.some(Cl.principal(actor));

  const data = Cl.tuple({
    token: tokenCV,
    "principal-1": Cl.principal(principal1),
    "principal-2": Cl.principal(principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(nonce),
    action: Cl.uint(action),
    actor: actorCV,
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

function generateDepositSignature(
  privateKey: StacksPrivateKey,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string
): Buffer {
  return generateChannelSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    ChannelAction.Deposit,
    actor
  );
}

function generateWithdrawSignature(
  privateKey: StacksPrivateKey,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string
): Buffer {
  return generateChannelSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    ChannelAction.Withdraw,
    actor
  );
}

describe("manage allowed SIP tokens", () => {
  it("unadded token is not allowed", () => {
    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "is-allowed-token",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    expect(result).toBeBool(false);
  });

  it("adding a token makes it allowed", () => {
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "is-allowed-token",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    expect(result).toBeBool(true);
  });

  it("removing a token makes it unallowed", () => {
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    simnet.callPublicFn(
      "stackflow",
      "remove-allowed-sip-010",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "is-allowed-token",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    expect(result).toBeBool(false);
  });

  it("removing a token that was never added is still unallowed", () => {
    simnet.callPublicFn(
      "stackflow",
      "remove-allowed-sip-010",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    const { result } = simnet.callReadOnlyFn(
      "stackflow",
      "is-allowed-token",
      [Cl.principal(`${deployer}.foo`)],
      deployer
    );

    expect(result).toBeBool(false);
  });
});

describe("fund-channel", () => {
  it("can fund a channel", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(0),
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

  it("can fund a channel that has been funded by the other party", () => {
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
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

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund a channel that has already been funded", () => {
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (result as ResponseOkCV).value;

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address2)],
      address1
    );
    expect(badResult).toBeErr(Cl.uint(TxError.AlreadyFunded));

    // Verify the channel did not change
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(0),
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

  it("second account cannot fund a channel that has already been funded", () => {
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(2000000), Cl.principal(address1)],
      address2
    );
    expect(result).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
    const channelBefore = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channelBefore).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(3000000), Cl.principal(address1)],
      address2
    );
    expect(badResult).toBeErr(Cl.uint(TxError.AlreadyFunded));

    // Verify the channel did not change
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

    // Verify the balances
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund channel with unapproved token", () => {
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
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
      ],
      address1
    );
    expect(result).toBeErr(Cl.uint(TxError.UnapprovedToken));
  });

  it("can fund a channel with an approved token", () => {
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

    // Set the test-token as approved
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.test-token`)],
      deployer
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
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
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(0),
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

  it("can fund a SIP-010 token channel that has been funded by the other party", () => {
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

    // Set the test-token as approved
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.test-token`)],
      deployer
    );

    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
      ],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address1),
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
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
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

    // Verify the balances
    const tokenBalances = simnet.getAssetsMap().get(".test-token.test-coin")!;

    const balance1 = tokenBalances.get(address1);
    expect(balance1).toBe(99999999000000n);

    const balance2 = tokenBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = tokenBalances.get(stackflowContract);
    expect(contractBalance).toBe(3000000n);
  });

  it("cannot fund a SIP-010 token channel that has already been funded", () => {
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

    // Set the test-token as approved
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.test-token`)],
      deployer
    );

    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
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
    const channelKey = (result as ResponseOkCV).value;

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address2),
      ],
      address1
    );
    expect(badResult).toBeErr(Cl.uint(TxError.AlreadyFunded));

    // Verify the channel did not change
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(0),
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

  it("second account cannot fund a SIP-010 token channel that has already been funded", () => {
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

    // Set the test-token as approved
    simnet.callPublicFn(
      "stackflow",
      "add-allowed-sip-010",
      [Cl.principal(`${deployer}.test-token`)],
      deployer
    );

    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(1000000),
        Cl.principal(address2),
      ],
      address1
    );
    const { result } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(2000000),
        Cl.principal(address1),
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
    const channelKey = (result as ResponseOkCV).value;

    // Verify the channel
    const channelBefore = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channelBefore).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );

    const { result: badResult } = simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [
        Cl.some(Cl.principal(`${deployer}.test-token`)),
        Cl.uint(3000000),
        Cl.principal(address1),
      ],
      address2
    );
    expect(badResult).toBeErr(Cl.uint(TxError.AlreadyFunded));

    // Verify the channel did not change
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

  it("cannot close with bad total balance", () => {
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

describe("force-close", () => {
  it("account 1 can force-close", () => {
    // Setup the channel
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

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
      ],
      address1
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
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

  it("account 2 can force-close", () => {
    // Setup the channel
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

    // Create the signatures
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1600000,
      1400000,
      1
    );
    const signature2 = generateTransferSignature(
      address2PK,
      null,
      address2,
      address1,
      1400000,
      1600000,
      1
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
      ],
      address2
    );
    expect(result).toBeOk(Cl.uint(heightBefore + WAITING_PERIOD));

    // Verify that the waiting period has been set in the map
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1600000),
        "balance-2": Cl.uint(1400000),
        "expires-at": Cl.uint(heightBefore + WAITING_PERIOD),
        nonce: Cl.uint(1),
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
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
      1
    );
    const signature2 = generateTransferSignature(
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
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(1600000),
        Cl.uint(1400000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      1000000,
      2000000,
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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

  it("cannot close with bad total balance", () => {
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
    const signature1 = generateTransferSignature(
      address1PK,
      null,
      address1,
      address2,
      2000000,
      2000000,
      1
    );
    const signature2 = generateTransferSignature(
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
      "force-close",
      [
        Cl.none(),
        Cl.principal(address2),
        Cl.uint(2000000),
        Cl.uint(2000000),
        Cl.buffer(signature1),
        Cl.buffer(signature2),
        Cl.uint(1),
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
      action: Cl.uint(ChannelAction.Transfer),
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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

describe("deposit", () => {
  it("can deposit to a valid channel from account1", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

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

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1050000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
      })
    );
  });

  it("can deposit to a valid channel from account2", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

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

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000),
        "balance-2": Cl.uint(2050000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(3),
        closer: Cl.none(),
      })
    );
  });

  it("can deposit after transfers", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      3040000,
      10000,
      3,
      address2
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      10000,
      3040000,
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
        Cl.uint(10000),
        Cl.uint(3040000),
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

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(3040000n),
        "balance-2": Cl.uint(10000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(3),
        closer: Cl.none(),
      })
    );
  });

  it("cannot deposit into non-existant channel", () => {
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

    // Try a deposit when no channels exist
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
    expect(result1).toBeErr(Cl.uint(TxError.NoSuchChannel));

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

    // Try a deposit when no channels exist
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
    expect(result2).toBeErr(Cl.uint(TxError.NoSuchChannel));
  });

  it("can not deposit with bad signatures", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

    // Create the signatures for a deposit
    const signature1 = generateDepositSignature(
      address1PK,
      null,
      address1,
      address2,
      3040000,
      10000,
      3,
      address2
    );
    const signature2 = generateDepositSignature(
      address2PK,
      null,
      address2,
      address1,
      10000,
      3040000,
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
        Cl.uint(20000),
        Cl.uint(3030000),
        Cl.buffer(signature2),
        Cl.buffer(signature1),
        Cl.uint(3),
      ],
      address2
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

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1000000n),
        "balance-2": Cl.uint(2000000n),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(0),
        closer: Cl.none(),
      })
    );
  });

  it("cannot deposit with an old nonce", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

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

    expect(result2).toBeErr(Cl.uint(TxError.NonceTooLow));

    // Verify the balances did not change with the failed deposit
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999998950000n);

    const balance2 = stxBalances.get(address2);
    expect(balance2).toBe(99999998000000n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(3050000n);

    // Verify the channel did not change with the failed deposit
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(1050000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
      })
    );
  });
});

describe("withdraw", () => {
  it("can withdraw from a valid channel from account1", () => {
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
    expect(fundResult).toBeOk(
      Cl.tuple({
        token: Cl.none(),
        "principal-1": Cl.principal(address1),
        "principal-2": Cl.principal(address2),
      })
    );
    const channelKey = (fundResult as ResponseOkCV).value;

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

    // Verify the channel
    const channel = simnet.getMapEntry(
      stackflowContract,
      "channels",
      channelKey
    );
    expect(channel).toBeSome(
      Cl.tuple({
        "balance-1": Cl.uint(500000),
        "balance-2": Cl.uint(2000000),
        "expires-at": Cl.uint(MAX_HEIGHT),
        nonce: Cl.uint(1),
        closer: Cl.none(),
      })
    );
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

describe("execute-withdraw", () => {
  it("fails when the contract has no balance", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "execute-withdraw",
      [Cl.none(), Cl.uint(100)],
      address1
    );
    expect(result).toBeErr(Cl.uint(TxError.WithdrawalFailed));
  });

  it("passes when the contract has a sufficient balance", () => {
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(1000000), Cl.principal(address2)],
      address1
    );

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
    simnet.callPublicFn(
      "stackflow",
      "fund-channel",
      [Cl.none(), Cl.uint(100), Cl.principal(address2)],
      address1
    );

    const { result } = simnet.callPrivateFn(
      "stackflow",
      "execute-withdraw",
      [Cl.none(), Cl.uint(101)],
      address1
    );
    expect(result).toBeErr(Cl.uint(TxError.WithdrawalFailed));

    // Verify the balances have not changed
    const stxBalances = simnet.getAssetsMap().get("STX")!;

    const balance1 = stxBalances.get(address1);
    expect(balance1).toBe(99999999999900n);

    const contractBalance = stxBalances.get(stackflowContract);
    expect(contractBalance).toBe(100n);
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
        Cl.uint(ChannelAction.Transfer),
        Cl.none(),
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
      action: Cl.uint(ChannelAction.Transfer),
      actor: Cl.none(),
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
        Cl.uint(ChannelAction.Close),
        Cl.none(),
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
      action: Cl.uint(ChannelAction.Close),
      actor: Cl.none(),
    });
  });
});

describe("update-channel-tuple", () => {
  it("updates channel correctly from account-1", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "update-channel-tuple",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({
          "balance-1": Cl.uint(123),
          "balance-2": Cl.uint(456),
          "expires-at": Cl.uint(789),
          nonce: Cl.uint(0),
          closer: Cl.none(),
        }),
        Cl.uint(999),
        Cl.uint(888),
        Cl.uint(4),
      ],
      address1
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(999),
      "balance-2": Cl.uint(888),
      "expires-at": Cl.uint(789),
      nonce: Cl.uint(4),
      closer: Cl.none(),
    });
  });

  it("updates channel correctly from account-2", () => {
    const { result } = simnet.callPrivateFn(
      "stackflow",
      "update-channel-tuple",
      [
        Cl.tuple({
          token: Cl.none(),
          "principal-1": Cl.principal(address1),
          "principal-2": Cl.principal(address2),
        }),
        Cl.tuple({
          "balance-1": Cl.uint(123),
          "balance-2": Cl.uint(456),
          "expires-at": Cl.uint(789),
          nonce: Cl.uint(0),
          closer: Cl.some(Cl.principal(address1)),
        }),
        Cl.uint(999),
        Cl.uint(888),
        Cl.uint(4),
      ],
      address2
    );
    expect(result).toBeTuple({
      "balance-1": Cl.uint(888),
      "balance-2": Cl.uint(999),
      "expires-at": Cl.uint(789),
      nonce: Cl.uint(4),
      closer: Cl.some(Cl.principal(address1)),
    });
  });
});
