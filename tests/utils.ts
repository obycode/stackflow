import {
  Cl,
  ClarityValue,
  serializeCV,
  serializeCVBytes,
  signWithKey,
} from "@stacks/transactions";
import { createHash } from "crypto";

export const accounts = simnet.getAccounts();
export const deployer = accounts.get("deployer")!;
export const address1 = accounts.get("wallet_1")!;
export const address2 = accounts.get("wallet_2")!;
export const address3 = accounts.get("wallet_3")!;
export const address4 = accounts.get("wallet_4")!;
export const stackflowContract = `${deployer}.stackflow`;
export const reservoirContract = `${deployer}.reservoir`;

export const deployerPK =
  "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";
export const address1PK =
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801";
export const address2PK =
  "530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101";
export const address3PK =
  "d655b2523bcd65e34889725c73064feb17ceb796831c0e111ba1a552b0f31b3901";
export const address4PK =
  "f9d7206a47f14d2870c163ebab4bf3e70d18f5d14ce1031f3902fbbc894fe4c701";

export const WAITING_PERIOD = 144;
export const MAX_HEIGHT = 340282366920938463463374607431768211455n;
export const CONFIRMATION_DEPTH = 6;
export const BORROW_TERM_BLOCKS = 4000;

export enum PipeAction {
  Close = 0,
  Transfer = 1,
  Deposit = 2,
  Withdraw = 3,
}

export enum StackflowError {
  DepositFailed = 100,
  NoSuchPipe = 101,
  InvalidPrincipal = 102,
  InvalidSenderSignature = 103,
  InvalidOtherSignature = 104,
  ConsensusBuff = 105,
  Unauthorized = 106,
  MaxAllowed = 107,
  InvalidTotalBalance = 108,
  WithdrawalFailed = 109,
  PipeExpired = 110,
  NonceTooLow = 111,
  CloseInProgress = 112,
  NoCloseInProgress = 113,
  SelfDispute = 114,
  AlreadyFunded = 115,
  InvalidWithdrawal = 116,
  UnapprovedToken = 117,
  NotExpired = 118,
  NotInitialized = 119,
  AlreadyInitialized = 120,
  NotValidYet = 121,
  AlreadyPending = 122,
  Pending = 123,
  InvalidBalances = 124,
  InvalidSignature = 125,
  InvalidFee = 204,
}

export enum ReservoirError {
  BorrowFeePaymentFailed = 200,
  Unauthorized = 201,
  FundingFailed = 202,
  TransferFailed = 203,
  InvalidFee = 204,
  AlreadyInitialized = 205,
  NotInitialized = 206,
  UnapprovedToken = 207,
  IncorrectStackflow = 208,
  AmountTooLow = 209,
  LiquidityPoolFull = 210,
}

const structuredDataPrefix = Buffer.from([0x53, 0x49, 0x50, 0x30, 0x31, 0x38]);

const chainIds = {
  mainnet: 1,
  testnet: 2147483648,
};

export function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function structuredDataHash(structuredData: ClarityValue): Buffer {
  return sha256(Buffer.from(serializeCVBytes(structuredData)));
}

const domainHash = structuredDataHash(
  Cl.tuple({
    name: Cl.stringAscii("StackFlow"),
    version: Cl.stringAscii("0.6.0"),
    "chain-id": Cl.uint(chainIds.testnet),
  })
);

export function structuredDataHashWithPrefix(
  structuredData: ClarityValue
): Buffer {
  const messageHash = structuredDataHash(structuredData);
  return sha256(Buffer.concat([structuredDataPrefix, domainHash, messageHash]));
}

export function signStructuredData(
  privateKey: string,
  structuredData: ClarityValue
): Buffer {
  const hash = structuredDataHashWithPrefix(structuredData);
  const data = signWithKey(privateKey, hash.toString("hex"));
  return Buffer.from(data.slice(2) + data.slice(0, 2), "hex");
}

export function generatePipeSignature(
  privateKey: string,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  action: PipeAction,
  actor: string,
  secret: string | null = null,
  valid_after: number | null = null
): Buffer {
  const meFirst =
    serializeCV(Cl.principal(myPrincipal)) <
    serializeCV(Cl.principal(theirPrincipal));
  const principal1 = meFirst ? myPrincipal : theirPrincipal;
  const principal2 = meFirst ? theirPrincipal : myPrincipal;
  const balance1 = meFirst ? myBalance : theirBalance;
  const balance2 = meFirst ? theirBalance : myBalance;

  const tokenCV =
    token === null
      ? Cl.none()
      : Cl.some(Cl.contractPrincipal(token[0], token[1]));
  const secretCV =
    secret === null
      ? Cl.none()
      : Cl.some(Cl.buffer(sha256(Buffer.from(secret, "hex"))));
  const validAfterCV =
    valid_after === null ? Cl.none() : Cl.some(Cl.uint(valid_after));

  const data = Cl.tuple({
    token: tokenCV,
    "principal-1": Cl.principal(principal1),
    "principal-2": Cl.principal(principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(nonce),
    action: Cl.uint(action),
    actor: Cl.principal(actor),
    "hashed-secret": secretCV,
    "valid-after": validAfterCV,
  });
  return signStructuredData(privateKey, data);
}

export function generateClosePipeSignature(
  privateKey: string,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string
): Buffer {
  return generatePipeSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    PipeAction.Close,
    actor
  );
}

export function generateTransferSignature(
  privateKey: string,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string,
  secret: string | null = null,
  valid_after: number | null = null
): Buffer {
  return generatePipeSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    PipeAction.Transfer,
    actor,
    secret,
    valid_after
  );
}

export function generateDepositSignature(
  privateKey: string,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string
): Buffer {
  return generatePipeSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    PipeAction.Deposit,
    actor
  );
}

export function generateWithdrawSignature(
  privateKey: string,
  token: [string, string] | null,
  myPrincipal: string,
  theirPrincipal: string,
  myBalance: number,
  theirBalance: number,
  nonce: number,
  actor: string
): Buffer {
  return generatePipeSignature(
    privateKey,
    token,
    myPrincipal,
    theirPrincipal,
    myBalance,
    theirBalance,
    nonce,
    PipeAction.Withdraw,
    actor
  );
}
