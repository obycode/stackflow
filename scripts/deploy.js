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

const VERSION_TAG = VERSION.replaceAll(".", "-");
const VERSION_DISPLAY = VERSION.replaceAll("-", ".");
const STACKFLOW_TOKEN_CONTRACT_NAME = `stackflow-token-${VERSION_TAG}`;
const TESTNET_SIP_010_TRAIT_ADDRESS =
  "ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT";

const CONTRACTS = [
  {
    name: STACKFLOW_TOKEN_CONTRACT_NAME,
    kind: "stackflow-token",
    file: "../contracts/stackflow-token.clar",
  },
  {
    name: `stackflow-${VERSION_TAG}`,
    kind: "stackflow",
    file: "../contracts/stackflow.clar",
  },
  {
    name: `reservoir-${VERSION_TAG}`,
    kind: "reservoir",
    file: "../contracts/reservoir.clar",
  },
];

const network = STACKS_TESTNET;

function replaceRequired(source, pattern, replacement, description) {
  const updated = source.replace(pattern, replacement);
  if (updated === source) {
    throw new Error(`Unable to update ${description}`);
  }
  return updated;
}

function buildContractCode(filePath, kind, senderAddress) {
  let codeBody = fs.readFileSync(path.resolve(__dirname, filePath), "utf8");

  codeBody = replaceRequired(
    codeBody,
    /(;;\s*version:\s*)([^\n]+)/,
    `$1${VERSION_DISPLAY}`,
    `${kind} version metadata`
  );

  codeBody = replaceRequired(
    codeBody,
    /^(\s*\(use-trait\s+sip-010\s+')[A-Z0-9]+(\.sip-010-trait-ft-standard\.sip-010-trait\))/m,
    `$1${TESTNET_SIP_010_TRAIT_ADDRESS}$2`,
    `${kind} sip-010 trait reference`
  );

  if (kind === "stackflow") {
    codeBody = replaceRequired(
      codeBody,
      /^(\s*version:\s*")[^"]+(")/m,
      `$1${VERSION_DISPLAY}$2`,
      "stackflow SIP-018 domain version"
    );
    codeBody = replaceRequired(
      codeBody,
      /^(\s*\(impl-trait\s+)(?:\.stackflow-token(?:-[A-Za-z0-9.-]+)?|'[A-Z0-9]+\.(?:stackflow-token(?:-[A-Za-z0-9.-]+)?))(\.stackflow-token\))/m,
      `$1'${senderAddress}.${STACKFLOW_TOKEN_CONTRACT_NAME}$2`,
      "stackflow token trait reference"
    );
  }

  if (kind === "reservoir") {
    codeBody = codeBody.replace(
      /^\s*;;\s*\(use-trait\s+stackflow-token\s+'[A-Z0-9]+\.(?:stackflow-token(?:-[A-Za-z0-9.-]+)?)\.stackflow-token\)\s*$/gm,
      ""
    );
    codeBody = replaceRequired(
      codeBody,
      /^(\s*\(use-trait\s+stackflow-token\s+)(?:\.stackflow-token(?:-[A-Za-z0-9.-]+)?|'[A-Z0-9]+\.(?:stackflow-token(?:-[A-Za-z0-9.-]+)?))(\.stackflow-token\))/m,
      `$1'${senderAddress}.${STACKFLOW_TOKEN_CONTRACT_NAME}$2`,
      "reservoir token trait reference"
    );
  }

  return codeBody;
}

async function deployContract(contractName, filePath, kind, nonce, senderAddress) {
  console.log(
    `Deploying contracts from address, ${senderAddress}, starting with nonce ${nonce}`
  );

  const codeBody = buildContractCode(filePath, kind, senderAddress);

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
    await deployContract(
      contract.name,
      contract.file,
      contract.kind,
      nonce,
      senderAddress
    );
    nonce += 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
