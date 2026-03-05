import "dotenv/config";

import { createNetwork } from "@stacks/network";
import {
  AnchorMode,
  PostConditionMode,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
} from "@stacks/transactions";

function normalizePrivateKey(input) {
  const trimmed = input.trim();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

function normalizeNetwork(input) {
  const value = String(input || "devnet").trim().toLowerCase();
  if (value === "mainnet" || value === "testnet" || value === "devnet" || value === "mocknet") {
    return value;
  }
  throw new Error("STACKS_NETWORK must be one of: mainnet, testnet, devnet, mocknet");
}

function parseContractId(contractId) {
  const normalized = contractId.startsWith("'")
    ? contractId.slice(1)
    : contractId;
  const parts = normalized.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }
  return { contractAddress: parts[0], contractName: parts[1] };
}

function normalizeContractId(label, contractId) {
  const normalized = String(contractId || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  const parsed = parseContractId(normalized);
  return `${parsed.contractAddress}.${parsed.contractName}`;
}

function parseInitMode(value) {
  const mode = String(value || "single").trim().toLowerCase();
  if (mode === "single" || mode === "devnet-both") {
    return mode;
  }
  throw new Error("STACKFLOW_INIT_MODE must be one of: single, devnet-both");
}

function nextNonce(value) {
  return typeof value === "bigint" ? value + 1n : value + 1;
}

async function submitInitTx({
  network,
  senderKey,
  nonce,
  contractId,
  tokenContractId,
}) {
  const { contractAddress, contractName } = parseContractId(contractId);
  const tokenArg = tokenContractId ? someCV(principalCV(tokenContractId)) : noneCV();

  console.log(
    `[init-stackflow] init contract=${contractId} token=${tokenContractId || "none"} nonce=${nonce.toString()}`,
  );

  const transaction = await makeContractCall({
    network,
    senderKey,
    contractAddress,
    contractName,
    functionName: "init",
    functionArgs: [tokenArg],
    nonce,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    validateWithAbi: false,
  });

  const result = await broadcastTransaction({
    transaction,
    network,
  });

  if ("reason" in result) {
    throw new Error(
      `init broadcast failed contract=${contractId} token=${tokenContractId || "none"} reason=${
        result.reason || "unknown"
      }`,
    );
  }

  console.log(`[init-stackflow] init broadcast ok contract=${contractId} txid=${result.txid}`);
}

async function main() {
  const stacksNetwork = normalizeNetwork(process.env.STACKS_NETWORK);
  const initMode = parseInitMode(process.env.STACKFLOW_INIT_MODE);
  const stacksApiUrl =
    process.env.STACKS_API_URL?.trim() ||
    (stacksNetwork === "mainnet"
      ? "https://api.hiro.so"
      : stacksNetwork === "testnet"
        ? "https://api.testnet.hiro.so"
        : "http://localhost:20443");

  const deployerKeyInput = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!deployerKeyInput) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is required; refusing to use embedded fixture keys",
    );
  }

  const senderKey = normalizePrivateKey(deployerKeyInput);

  const network = createNetwork({
    network: stacksNetwork,
    client: { baseUrl: stacksApiUrl },
  });

  const deployerAddress = getAddressFromPrivateKey(senderKey, network);
  console.log(`[init-stackflow] network=${stacksNetwork} api=${stacksApiUrl}`);
  console.log(`[init-stackflow] mode=${initMode}`);
  console.log(`[init-stackflow] deployer=${deployerAddress}`);

  const initCalls =
    initMode === "devnet-both"
      ? [
          {
            contractId: normalizeContractId(
              "STACKFLOW_CONTRACT_ID",
              process.env.STACKFLOW_CONTRACT_ID?.trim() || `${deployerAddress}.stackflow`,
            ),
            tokenContractId: null,
          },
          {
            contractId: normalizeContractId(
              "STACKFLOW_SBTC_CONTRACT_ID",
              process.env.STACKFLOW_SBTC_CONTRACT_ID?.trim() ||
                `${deployerAddress}.stackflow-sbtc`,
            ),
            tokenContractId: normalizeContractId(
              "STACKFLOW_SBTC_TOKEN_CONTRACT_ID",
              process.env.STACKFLOW_SBTC_TOKEN_CONTRACT_ID?.trim() ||
                `${deployerAddress}.test-token`,
            ),
          },
        ]
      : [
          {
            contractId: normalizeContractId(
              "STACKFLOW_CONTRACT_ID",
              process.env.STACKFLOW_CONTRACT_ID?.trim() || `${deployerAddress}.stackflow`,
            ),
            tokenContractId: process.env.STACKFLOW_TOKEN_CONTRACT_ID?.trim()
              ? normalizeContractId(
                  "STACKFLOW_TOKEN_CONTRACT_ID",
                  process.env.STACKFLOW_TOKEN_CONTRACT_ID,
                )
              : null,
          },
        ];

  let nonce = await fetchNonce({
    address: deployerAddress,
    network: stacksNetwork,
    client: { baseUrl: stacksApiUrl },
  });

  for (const call of initCalls) {
    await submitInitTx({
      network,
      senderKey,
      nonce,
      contractId: call.contractId,
      tokenContractId: call.tokenContractId,
    });
    nonce = nextNonce(nonce);
  }
}

main().catch((error) => {
  console.error("[init-stackflow] fatal:", error);
  process.exit(1);
});
