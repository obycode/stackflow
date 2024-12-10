import {
  Cl,
  ClarityValue,
  createStacksPrivateKey,
  cvToString,
  serializeCV,
  signWithKey,
  StacksPrivateKey,
} from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;

const address1PK = createStacksPrivateKey(
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801"
);

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
    });
  });
});
