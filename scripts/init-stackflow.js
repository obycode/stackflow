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
} from "@stacks/transactions";

const DEFAULT_DEVNET_DEPLOYER_KEY =
  "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";

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
    throw new Error(`Invalid STACKFLOW_CONTRACT_ID: ${contractId}`);
  }
  return { contractAddress: parts[0], contractName: parts[1] };
}

async function main() {
  const stacksNetwork = normalizeNetwork(process.env.STACKS_NETWORK);
  const stacksApiUrl =
    process.env.STACKS_API_URL?.trim() ||
    (stacksNetwork === "mainnet"
      ? "https://api.hiro.so"
      : stacksNetwork === "testnet"
        ? "https://api.testnet.hiro.so"
        : "http://localhost:20443");

  const deployerKeyInput =
    process.env.DEPLOYER_PRIVATE_KEY?.trim() || DEFAULT_DEVNET_DEPLOYER_KEY;
  if (!process.env.DEPLOYER_PRIVATE_KEY?.trim()) {
    console.warn(
      "[init-stackflow] DEPLOYER_PRIVATE_KEY not set; using default Clarinet devnet deployer key",
    );
  }

  const senderKey = normalizePrivateKey(deployerKeyInput);

  const network = createNetwork({
    network: stacksNetwork,
    client: { baseUrl: stacksApiUrl },
  });

  const deployerAddress = getAddressFromPrivateKey(senderKey, network);
  const contractId =
    process.env.STACKFLOW_CONTRACT_ID?.trim() || `${deployerAddress}.stackflow`;
  const { contractAddress, contractName } = parseContractId(contractId);

  console.log(`[init-stackflow] network=${stacksNetwork} api=${stacksApiUrl}`);
  console.log(`[init-stackflow] deployer=${deployerAddress}`);
  console.log(`[init-stackflow] contract=${contractAddress}.${contractName}`);

  const nonce = await fetchNonce({
    address: deployerAddress,
    network: stacksNetwork,
    client: { baseUrl: stacksApiUrl },
  });

  const transaction = await makeContractCall({
    network,
    senderKey,
    contractAddress,
    contractName,
    functionName: "init",
    functionArgs: [noneCV()],
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
    console.error("[init-stackflow] broadcast failed:", result);
    process.exit(1);
  }

  console.log("[init-stackflow] broadcast ok:", result.txid);
}

main().catch((error) => {
  console.error("[init-stackflow] fatal:", error);
  process.exit(1);
});
