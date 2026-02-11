import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import {
  AnchorMode,
  ClarityVersion,
  broadcastTransaction,
  getAddressFromPrivateKey,
  makeContractDeploy,
  fetchNonce,
} from "@stacks/transactions";
import { STACKS_TESTNET } from "@stacks/network";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STACKS_API_URL =
  process.env.STACKS_API_URL ?? "https://api.testnet.hiro.so";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

if (!DEPLOYER_PRIVATE_KEY) {
  console.error("DEPLOYER_PRIVATE_KEY is required in the environment");
  process.exit(1);
}

const VERSION = process.env.VERSION;
if (!VERSION) {
  console.error("VERSION is required in the environment");
  process.exit(1);
}

const CONTRACTS = [
  {
    name: `stackflow-token-${VERSION}`,
    file: "../contracts/stackflow-token.clar",
  },
  { name: `stackflow-${VERSION}`, file: "../contracts/stackflow.clar" },
  { name: `reservoir-${VERSION}`, file: "../contracts/reservoir.clar" },
];

const network = STACKS_TESTNET;

async function deployContract(contractName, filePath, nonce) {
  const senderAddress = getAddressFromPrivateKey(DEPLOYER_PRIVATE_KEY, network);
  console.log(
    `Deploying contracts from address, ${senderAddress}, starting with nonce ${nonce}`
  );

  const codeBody = fs.readFileSync(path.resolve(__dirname, filePath), "utf8");

  const txOptions = {
    contractName,
    codeBody,
    senderKey: DEPLOYER_PRIVATE_KEY,
    nonce,
    network,
    clarityVersion: ClarityVersion.Clarity4,
    anchorMode: AnchorMode.Any,
  };

  const transaction = await makeContractDeploy(txOptions);
  const resp = await broadcastTransaction({ transaction, network });
  console.log(`${contractName} tx broadcast:`, resp);
  return resp;
}

async function main() {
  const senderAddress = getAddressFromPrivateKey(DEPLOYER_PRIVATE_KEY, network);
  let nonce = await fetchNonce(senderAddress, network);
  for (const contract of CONTRACTS) {
    await deployContract(contract.name, contract.file, nonce);
    nonce += 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
