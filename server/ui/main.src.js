import { connect, disconnect, isConnected, request } from "https://esm.sh/@stacks/connect?bundle&target=es2020";
import {
  Cl,
  Pc,
  principalCV,
  serializeCV,
} from "https://esm.sh/@stacks/transactions@7.2.0?bundle&target=es2020";

const CHAIN_IDS = {
  mainnet: 1n,
  testnet: 2147483648n,
  devnet: 2147483648n,
  mocknet: 2147483648n,
};

const STORAGE_KEY = "stackflow-console-config-v1";

let connectedAddress = null;
let watchtowerProducerEnabled = false;
let watchtowerProducerPrincipal = null;

const ids = {
  watchtowerUrl: "watchtower-url",
  contractId: "contract-id",
  network: "network",
  contractVersion: "contract-version",
  walletStatus: "wallet-status",
  pipesBody: "pipes-body",
  sigWith: "sig-with",
  sigActor: "sig-actor",
  sigToken: "sig-token",
  sigTokenAssetName: "sig-token-asset-name",
  sigAction: "sig-action",
  sigMyBalance: "sig-my-balance",
  sigTheirBalance: "sig-their-balance",
  sigNonce: "sig-nonce",
  sigValidAfter: "sig-valid-after",
  sigSecret: "sig-secret",
  sigMySignature: "sig-my-signature",
  sigTheirSignature: "sig-their-signature",
  signaturePayload: "signature-payload",
  txResult: "tx-result",
  actionHelp: "action-help",
  actionSelect: "action-select",
  actionSubmitBtn: "action-submit-btn",
  callFundAmount: "call-fund-amount",
  callAmountLabel: "call-amount-label",
  sigMySignatureLabel: "sig-my-signature-label",
  sigMySignatureHelp: "sig-my-signature-help",
};

const ACTION_FIELD_IDS = [
  "field-sig-with",
  "field-sig-token",
  "field-sig-token-asset-name",
  "field-call-fund-amount",
  "field-sig-nonce",
  "field-sig-my-balance",
  "field-sig-their-balance",
  "field-sig-action",
  "field-sig-actor",
  "field-sig-valid-after",
  "field-sig-secret",
  "field-sig-my-signature",
  "field-sig-their-signature",
];

const ACTION_DEFS = {
  "fund-pipe": {
    submitLabel: "Submit fund-pipe",
    help: "Create or add initial liquidity to a pipe on-chain.",
    amountLabel: "fund-pipe Amount",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-token-asset-name",
      "field-call-fund-amount",
      "field-sig-nonce",
    ],
  },
  deposit: {
    submitLabel: "Submit deposit",
    help: "Add funds on-chain using signatures from both parties.",
    amountLabel: "deposit Amount",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-token-asset-name",
      "field-call-fund-amount",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  withdraw: {
    submitLabel: "Submit withdraw",
    help: "Withdraw funds on-chain using signatures from both parties.",
    amountLabel: "withdraw Amount",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-token-asset-name",
      "field-call-fund-amount",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "force-cancel": {
    submitLabel: "Submit force-cancel",
    help: "Start an on-chain cancellation waiting period for this pipe.",
    fields: ["field-sig-with", "field-sig-token"],
  },
  "close-pipe": {
    submitLabel: "Submit close-pipe",
    help: "Cooperatively close a pipe with both signatures.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-token-asset-name",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "force-close": {
    submitLabel: "Submit force-close",
    help: "Start a forced closure with signed balances.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-action",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "finalize": {
    submitLabel: "Submit finalize",
    help: "Finalize a previously forced closure after the waiting period.",
    fields: ["field-sig-with", "field-sig-token", "field-sig-token-asset-name"],
  },
  "sign-transfer": {
    submitLabel: "Sign transfer state",
    help: "Generate your signature for an off-chain transfer state.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
    ],
  },
  "sign-deposit": {
    submitLabel: "Sign deposit state",
    help: "Generate your signature for an off-chain deposit state.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
    ],
  },
  "sign-withdrawal": {
    submitLabel: "Sign withdrawal state",
    help: "Generate your signature for an off-chain withdrawal state.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
    ],
  },
  "sign-close": {
    submitLabel: "Sign close state",
    help: "Generate your signature for an off-chain close state.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-my-signature",
    ],
  },
  "request-producer-transfer": {
    submitLabel: "Request producer transfer signature",
    help: "Send your transfer signature to the producer and receive their signature.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "request-producer-deposit": {
    submitLabel: "Request producer deposit signature",
    help: "Send your deposit signature to the producer and receive their signature.",
    amountLabel: "deposit Amount",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-call-fund-amount",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "request-producer-withdrawal": {
    submitLabel: "Request producer withdrawal signature",
    help: "Send your withdrawal signature to the producer and receive their signature.",
    amountLabel: "withdraw Amount",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-call-fund-amount",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "request-producer-close": {
    submitLabel: "Request producer close signature",
    help: "Send your close signature to the producer and receive their signature.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-actor",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
  "submit-signature-state": {
    submitLabel: "Submit signature state",
    help: "Send the latest signed state to the watchtower.",
    fields: [
      "field-sig-with",
      "field-sig-token",
      "field-sig-my-balance",
      "field-sig-their-balance",
      "field-sig-nonce",
      "field-sig-action",
      "field-sig-actor",
      "field-sig-secret",
      "field-sig-valid-after",
      "field-sig-my-signature",
      "field-sig-their-signature",
    ],
  },
};

const PRODUCER_ACTION_CONFIG = {
  "request-producer-transfer": {
    endpoint: "/producer/transfer",
    action: "1",
  },
  "request-producer-close": {
    endpoint: "/producer/signature-request",
    action: "0",
  },
  "request-producer-deposit": {
    endpoint: "/producer/signature-request",
    action: "2",
  },
  "request-producer-withdrawal": {
    endpoint: "/producer/signature-request",
    action: "3",
  },
};

function $(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

function setStatus(id, message, isError = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function getInput(id) {
  return /** @type {HTMLInputElement | HTMLSelectElement} */ ($(id));
}

function getSelectedAction() {
  const selected = normalizedText(getInput(ids.actionSelect).value);
  return ACTION_DEFS[selected] ? selected : "fund-pipe";
}

function setSignedActionForSelection(action) {
  const mapping = {
    "sign-close": "0",
    "sign-transfer": "1",
    "sign-deposit": "2",
    "sign-withdrawal": "3",
    "request-producer-close": "0",
    "request-producer-transfer": "1",
    "request-producer-deposit": "2",
    "request-producer-withdrawal": "3",
  };

  const value = mapping[action];
  if (value !== undefined) {
    getInput(ids.sigAction).value = value;
  }
}

function getProducerActionConfig(action) {
  return PRODUCER_ACTION_CONFIG[action] || null;
}

function isProducerRequestAction(action) {
  return Boolean(getProducerActionConfig(action));
}

function updateActionUi() {
  const action = getSelectedAction();
  const def = ACTION_DEFS[action];

  for (const fieldId of ACTION_FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field) {
      continue;
    }
    const shouldShow = def.fields.includes(fieldId);
    field.classList.toggle("hidden", !shouldShow);
    field.hidden = !shouldShow;
    field.style.display = shouldShow ? "" : "none";
  }

  $(ids.actionSubmitBtn).textContent = def.submitLabel;
  const amountLabel = document.getElementById(ids.callAmountLabel);
  if (amountLabel) {
    amountLabel.textContent = def.amountLabel || "Amount";
  }

  const signAction = action.startsWith("sign-");
  const mySigInput = getInput(ids.sigMySignature);
  const mySigLabel = document.getElementById(ids.sigMySignatureLabel);
  const mySigHelp = document.getElementById(ids.sigMySignatureHelp);

  mySigInput.readOnly = signAction;
  mySigInput.classList.toggle("generated-output", signAction);
  mySigInput.placeholder = signAction ? "Auto-generated after signing" : "0x...";

  if (mySigLabel) {
    mySigLabel.textContent = signAction
      ? "My Signature (Generated Output)"
      : "My Signature (RSV hex)";
  }
  if (mySigHelp) {
    mySigHelp.textContent = signAction
      ? "Click the submit button to generate this signature. It will auto-fill here."
      : "Paste your signature, or switch to a sign-* action to generate it here.";
  }

  if (
    isProducerRequestAction(action) &&
    !normalizedText(getInput(ids.sigWith).value) &&
    watchtowerProducerPrincipal
  ) {
    getInput(ids.sigWith).value = watchtowerProducerPrincipal;
  }

  let producerHint = "";
  if (isProducerRequestAction(action)) {
    if (watchtowerProducerEnabled && watchtowerProducerPrincipal) {
      producerHint = ` Producer principal: ${watchtowerProducerPrincipal}.`;
    } else {
      producerHint =
        " Producer signing is not reported as enabled by the watchtower.";
    }
  }

  setStatus(ids.actionHelp, `Action: ${action}. ${def.help}${producerHint}`, false);
  setSignedActionForSelection(action);
}

function normalizedText(value) {
  return String(value || "").trim();
}

function splitContractPrincipal(contractId) {
  const value = normalizedText(contractId);
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }

  return {
    address: parts[0],
    name: parts[1],
  };
}

function parseClarityName(value, fieldName) {
  const text = normalizedText(value);
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }

  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(text)) {
    throw new Error(`${fieldName} must be a valid Clarity name`);
  }

  return text;
}

function inferTokenAssetName(tokenContractId) {
  try {
    const { name } = splitContractPrincipal(tokenContractId);
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) {
      return name;
    }
  } catch {
    // Ignore and require explicit name when needed.
  }

  return null;
}

function getTokenAssetName(tokenContractId) {
  if (!tokenContractId) {
    return null;
  }

  const explicit = normalizedText(getInput(ids.sigTokenAssetName).value);
  if (explicit) {
    return parseClarityName(explicit, "Token asset name");
  }

  const inferred = inferTokenAssetName(tokenContractId);
  if (inferred) {
    return inferred;
  }

  throw new Error("Token asset name is required for FT post-conditions");
}

function makePostConditionForTransfer(principal, tokenContractId, amount) {
  const builder = Pc.principal(principal).willSendEq(amount);
  if (!tokenContractId) {
    return builder.ustx();
  }

  return builder.ft(tokenContractId, getTokenAssetName(tokenContractId));
}

function saveConfig() {
  const data = {
    watchtowerUrl: getInput(ids.watchtowerUrl).value.trim(),
    contractId: getInput(ids.contractId).value.trim(),
    network: getInput(ids.network).value.trim(),
    contractVersion: getInput(ids.contractVersion).value.trim(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadConfig() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.watchtowerUrl === "string") {
      getInput(ids.watchtowerUrl).value = parsed.watchtowerUrl;
    }
    if (typeof parsed.contractId === "string") {
      getInput(ids.contractId).value = parsed.contractId;
    }
    if (typeof parsed.network === "string") {
      getInput(ids.network).value = parsed.network;
    }
    if (typeof parsed.contractVersion === "string") {
      getInput(ids.contractVersion).value = parsed.contractVersion;
    }
  } catch {
    // Ignore invalid cached data.
  }
}

function defaultConfig() {
  getInput(ids.watchtowerUrl).value = window.location.origin;
  getInput(ids.contractVersion).value = "0.6.0";
}

function toBigInt(value, field) {
  const text = normalizedText(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  if (!/^\d+$/.test(text)) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  return BigInt(text);
}

function optionalBigInt(value, field) {
  const text = normalizedText(value);
  if (!text) {
    return null;
  }
  if (!/^\d+$/.test(text)) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  return BigInt(text);
}

function normalizeHex(value, field, expectedBytes = null) {
  const raw = normalizedText(value).toLowerCase();
  if (!raw) {
    throw new Error(`${field} is required`);
  }
  const text = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]+$/.test(text)) {
    throw new Error(`${field} must be hex`);
  }
  if (expectedBytes !== null && text.length !== expectedBytes * 2) {
    throw new Error(`${field} must be ${expectedBytes} bytes`);
  }
  return `0x${text}`;
}

function optionalHex(value, field, expectedBytes = null) {
  const text = normalizedText(value);
  if (!text) {
    return null;
  }
  return normalizeHex(text, field, expectedBytes);
}

function hexToBytes(hex) {
  const normalized = normalizeHex(hex, "hex");
  const raw = normalized.slice(2);
  const output = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) {
    output[i / 2] = Number.parseInt(raw.slice(i, i + 2), 16);
  }
  return output;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function compareBytes(left, right) {
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] < right[i]) {
      return -1;
    }
    if (left[i] > right[i]) {
      return 1;
    }
  }
  if (left.length < right.length) {
    return -1;
  }
  if (left.length > right.length) {
    return 1;
  }
  return 0;
}

function canonicalPrincipals(a, b) {
  const aBytes = serializeCV(principalCV(a));
  const bBytes = serializeCV(principalCV(b));
  if (compareBytes(aBytes, bBytes) <= 0) {
    return { principal1: a, principal2: b };
  }
  return { principal1: b, principal2: a };
}

function optionalPrincipalCv(value) {
  const text = normalizedText(value);
  return text ? Cl.some(Cl.principal(text)) : Cl.none();
}

function optionalUIntCv(value) {
  return value === null ? Cl.none() : Cl.some(Cl.uint(value));
}

function optionalSecretCv(secretHex) {
  if (!secretHex) {
    return Cl.none();
  }
  return Cl.some(Cl.buffer(hexToBytes(secretHex)));
}

function signatureToBufferCv(signature) {
  return Cl.buffer(hexToBytes(normalizeHex(signature, "signature", 65)));
}

function parseContractId() {
  const raw = normalizedText(getInput(ids.contractId).value);
  let contractId = raw;
  if (contractId.startsWith("'")) {
    contractId = contractId.slice(1);
  }
  if (!contractId.includes(".") && contractId.includes("/")) {
    contractId = contractId.replace("/", ".");
  }

  const parts = contractId.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Stackflow contract must be a contract principal");
  }

  try {
    principalCV(parts[0]);
  } catch {
    throw new Error("Invalid contract address in contract principal");
  }

  getInput(ids.contractId).value = contractId;
  return contractId;
}

function parseSignerInputs() {
  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const withPrincipal = normalizedText(getInput(ids.sigWith).value);
  if (!withPrincipal) {
    throw new Error("Counterparty principal is required");
  }

  const actorInput = normalizedText(getInput(ids.sigActor).value);
  const actor = actorInput || connectedAddress;
  const token = normalizedText(getInput(ids.sigToken).value) || null;
  const myBalance = toBigInt(getInput(ids.sigMyBalance).value, "My balance");
  const theirBalance = toBigInt(
    getInput(ids.sigTheirBalance).value,
    "Their balance",
  );
  const nonce = toBigInt(getInput(ids.sigNonce).value, "Nonce");
  const action = toBigInt(getInput(ids.sigAction).value, "Action");
  const validAfter = optionalBigInt(
    getInput(ids.sigValidAfter).value,
    "Valid-after",
  );
  const secret = optionalHex(
    getInput(ids.sigSecret).value,
    "Secret preimage",
    32,
  );

  return {
    withPrincipal,
    actor,
    token,
    myBalance,
    theirBalance,
    nonce,
    action,
    validAfter,
    secret,
  };
}

function parseActionContext({ requireNonce = false } = {}) {
  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const withPrincipal = normalizedText(getInput(ids.sigWith).value);
  if (!withPrincipal) {
    throw new Error("Counterparty principal is required");
  }

  const token = normalizedText(getInput(ids.sigToken).value) || null;
  const nonce = requireNonce
    ? toBigInt(getInput(ids.sigNonce).value, "Nonce")
    : null;

  return {
    withPrincipal,
    token,
    nonce,
  };
}

async function getHashedSecretCv(secret) {
  if (!secret) {
    return Cl.none();
  }
  const digest = await sha256(hexToBytes(secret));
  return Cl.some(Cl.buffer(digest));
}

async function buildStructuredState() {
  const contractId = parseContractId();
  const signer = parseSignerInputs();
  const pair = canonicalPrincipals(connectedAddress, signer.withPrincipal);
  const balance1 =
    pair.principal1 === connectedAddress ? signer.myBalance : signer.theirBalance;
  const balance2 =
    pair.principal1 === connectedAddress ? signer.theirBalance : signer.myBalance;

  const hashedSecret = await getHashedSecretCv(signer.secret);
  const message = Cl.tuple({
    token: optionalPrincipalCv(signer.token),
    "principal-1": Cl.principal(pair.principal1),
    "principal-2": Cl.principal(pair.principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(signer.nonce),
    action: Cl.uint(signer.action),
    actor: Cl.principal(signer.actor),
    "hashed-secret": hashedSecret,
    "valid-after": optionalUIntCv(signer.validAfter),
  });

  const network = normalizedText(getInput(ids.network).value);
  const chainId = CHAIN_IDS[network] || CHAIN_IDS.testnet;
  const version = normalizedText(getInput(ids.contractVersion).value) || "0.6.0";
  const domain = Cl.tuple({
    name: Cl.stringAscii(contractId),
    version: Cl.stringAscii(version),
    "chain-id": Cl.uint(chainId),
  });

  return {
    contractId,
    signer,
    message,
    domain,
  };
}

function extractAddress(response) {
  const isStacksAddress = (value) =>
    typeof value === "string" && /^S[PMT][A-Z0-9]{38,42}$/i.test(value);

  const seen = new Set();

  const findAddress = (value) => {
    if (value === null || value === undefined) {
      return null;
    }

    if (isStacksAddress(value)) {
      return value;
    }

    if (typeof value !== "object") {
      return null;
    }

    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      // Prefer explicit STX-marked entries first.
      for (const item of value) {
        if (
          item &&
          typeof item === "object" &&
          String(item.symbol || item.chain || "").toUpperCase().includes("STX") &&
          isStacksAddress(item.address)
        ) {
          return item.address;
        }
      }

      for (const item of value) {
        const nested = findAddress(item);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (isStacksAddress(value.address)) {
      return value.address;
    }
    if (isStacksAddress(value.stxAddress)) {
      return value.stxAddress;
    }
    if (isStacksAddress(value.stacksAddress)) {
      return value.stacksAddress;
    }

    const priorityKeys = [
      "result",
      "addresses",
      "account",
      "accounts",
      "stx",
      "stacks",
      "wallet",
    ];

    for (const key of priorityKeys) {
      if (key in value) {
        const nested = findAddress(value[key]);
        if (nested) {
          return nested;
        }
      }
    }

    for (const nestedValue of Object.values(value)) {
      const nested = findAddress(nestedValue);
      if (nested) {
        return nested;
      }
    }

    return null;
  };

  return findAddress(response);
}

async function resolveConnectedAddress(connectResponse = null) {
  const initialAddress = extractAddress(connectResponse);
  if (initialAddress) {
    return initialAddress;
  }

  const response = await request("getAddresses");
  const address = extractAddress(response);
  if (!address) {
    const details = JSON.stringify(response);
    throw new Error(
      `Wallet connected, but no valid STX address found. getAddresses response: ${details.slice(0, 300)}`,
    );
  }
  return address;
}

function extractSignature(response) {
  if (!response || typeof response !== "object") {
    return null;
  }
  if (typeof response.signature === "string") {
    return response.signature;
  }
  if (response.result && typeof response.result === "object") {
    if (typeof response.result.signature === "string") {
      return response.result.signature;
    }
  }
  return null;
}

function extractTxid(response) {
  if (!response || typeof response !== "object") {
    return null;
  }
  if (typeof response.txid === "string") {
    return response.txid;
  }
  if (response.result && typeof response.result === "object") {
    if (typeof response.result.txid === "string") {
      return response.result.txid;
    }
  }
  return null;
}

function buildWatchtowerPayload() {
  const parsed = parseSignerInputs();
  const contractId = parseContractId();
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const theirSignature = normalizeHex(
    getInput(ids.sigTheirSignature).value,
    "Counterparty signature",
    65,
  );
  const amount =
    parsed.action === 2n || parsed.action === 3n
      ? toBigInt(getInput(ids.callFundAmount).value, "Amount").toString(10)
      : "0";

  return {
    contractId,
    forPrincipal: connectedAddress,
    withPrincipal: parsed.withPrincipal,
    token: parsed.token,
    amount,
    myBalance: parsed.myBalance.toString(10),
    theirBalance: parsed.theirBalance.toString(10),
    mySignature,
    theirSignature,
    nonce: parsed.nonce.toString(10),
    action: parsed.action.toString(10),
    actor: parsed.actor,
    secret: parsed.secret,
    validAfter: parsed.validAfter ? parsed.validAfter.toString(10) : null,
    beneficialOnly: false,
  };
}

function buildProducerRequestPayload(action) {
  const config = getProducerActionConfig(action);
  if (!config) {
    throw new Error(`Unsupported producer action: ${action}`);
  }

  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const parsed = parseSignerInputs();
  const contractId = parseContractId();
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const amount =
    config.action === "2" || config.action === "3"
      ? toBigInt(getInput(ids.callFundAmount).value, "Amount").toString(10)
      : "0";

  return {
    endpoint: config.endpoint,
    payload: {
      contractId,
      forPrincipal: parsed.withPrincipal,
      withPrincipal: connectedAddress,
      token: parsed.token,
      amount,
      myBalance: parsed.theirBalance.toString(10),
      theirBalance: parsed.myBalance.toString(10),
      theirSignature: mySignature,
      nonce: parsed.nonce.toString(10),
      action: config.action,
      actor: parsed.actor,
      secret: parsed.secret,
      validAfter: parsed.validAfter ? parsed.validAfter.toString(10) : null,
      beneficialOnly: false,
    },
  };
}

function renderPayloadPreview() {
  const action = getSelectedAction();
  if (
    action === "sign-transfer" ||
    action === "sign-deposit" ||
    action === "sign-withdrawal" ||
    action === "sign-close"
  ) {
    const mySignature = normalizedText(getInput(ids.sigMySignature).value);
    if (mySignature) {
      $(ids.signaturePayload).textContent = JSON.stringify(
        { mySignature },
        null,
        2,
      );
    } else {
      $(ids.signaturePayload).textContent =
        "Generated signature appears here.";
    }
    return;
  }

  if (isProducerRequestAction(action)) {
    try {
      const request = buildProducerRequestPayload(action);
      $(ids.signaturePayload).textContent = JSON.stringify(request, null, 2);
    } catch (error) {
      $(ids.signaturePayload).textContent =
        error instanceof Error ? error.message : "invalid producer request";
    }
    return;
  }

  if (action !== "submit-signature-state") {
    $(ids.signaturePayload).textContent =
      "Payload preview appears for submit-signature-state and producer requests.";
    return;
  }

  try {
    const payload = buildWatchtowerPayload();
    $(ids.signaturePayload).textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    $(ids.signaturePayload).textContent =
      error instanceof Error ? error.message : "invalid signature payload";
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPipesPlaceholder(message) {
  $(ids.pipesBody).innerHTML =
    `<article class="pipe-card pipe-card-empty"><p>${escapeHtml(message)}</p></article>`;
}

function toDisplayAmount(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const text = String(value);
  if (!/^\d+$/.test(text)) {
    return text;
  }

  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toUintOrNull(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return BigInt(text);
}

function computeDisplayBalances(pipe, connected) {
  const principal1 = pipe.pipeKey?.["principal-1"] || "";
  const principal2 = pipe.pipeKey?.["principal-2"] || "";
  const connectedIs1 = connected === principal1;
  const connectedIs2 = connected === principal2;

  const mineConfirmed = connectedIs1
    ? pipe.balance1
    : connectedIs2
      ? pipe.balance2
      : null;
  const theirsConfirmed = connectedIs1
    ? pipe.balance2
    : connectedIs2
      ? pipe.balance1
      : null;
  const minePending = connectedIs1
    ? pipe.pending1Amount
    : connectedIs2
      ? pipe.pending2Amount
      : null;
  const theirsPending = connectedIs1
    ? pipe.pending2Amount
    : connectedIs2
      ? pipe.pending1Amount
      : null;
  const minePendingHeight = connectedIs1
    ? pipe.pending1BurnHeight
    : connectedIs2
      ? pipe.pending2BurnHeight
      : null;
  const theirsPendingHeight = connectedIs1
    ? pipe.pending2BurnHeight
    : connectedIs2
      ? pipe.pending1BurnHeight
      : null;
  const counterparty = connectedIs1 ? principal2 : principal1;

  const mineConfirmedUint = toUintOrNull(mineConfirmed);
  const minePendingUint = toUintOrNull(minePending);
  const theirsConfirmedUint = toUintOrNull(theirsConfirmed);
  const theirsPendingUint = toUintOrNull(theirsPending);

  const mineEffective =
    mineConfirmedUint !== null && minePendingUint !== null
      ? (mineConfirmedUint + minePendingUint).toString(10)
      : mineConfirmed;
  const theirsEffective =
    theirsConfirmedUint !== null && theirsPendingUint !== null
      ? (theirsConfirmedUint + theirsPendingUint).toString(10)
      : theirsConfirmed;

  return {
    counterparty,
    mineConfirmed,
    theirsConfirmed,
    minePending,
    theirsPending,
    minePendingHeight,
    theirsPendingHeight,
    mineEffective,
    theirsEffective,
  };
}

function pendingText(amount, burnHeight) {
  const raw = String(amount ?? "");
  if (!/^\d+$/.test(raw)) {
    return "-";
  }

  if (raw === "0") {
    return "0";
  }

  return `${toDisplayAmount(raw)} (burn ${escapeHtml(String(burnHeight ?? "?"))})`;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

function pipeMatchesParticipants(pipe, connected, withPrincipal, token) {
  const pipeKey = pipe?.pipeKey;
  if (!pipeKey) {
    return false;
  }

  const principal1 = normalizedText(pipeKey["principal-1"]);
  const principal2 = normalizedText(pipeKey["principal-2"]);
  const pipeToken = pipeKey.token ?? null;

  return (
    pipeToken === token &&
    ((principal1 === connected && principal2 === withPrincipal) ||
      (principal2 === connected && principal1 === withPrincipal))
  );
}

async function resolvePipeTotals(withPrincipal, token) {
  const baseUrl = normalizedText(getInput(ids.watchtowerUrl).value);
  if (!baseUrl) {
    throw new Error("Watchtower URL is required");
  }

  const body = await fetchJson(
    `${baseUrl}/pipes?limit=500&principal=${encodeURIComponent(connectedAddress)}`,
  );
  const pipes = Array.isArray(body.pipes) ? body.pipes : [];
  const pipe = pipes.find((candidate) =>
    pipeMatchesParticipants(candidate, connectedAddress, withPrincipal, token),
  );

  if (!pipe) {
    throw new Error("Unable to find pipe state for finalize post-condition");
  }

  if (!/^\d+$/.test(String(pipe.balance1 ?? "")) || !/^\d+$/.test(String(pipe.balance2 ?? ""))) {
    throw new Error("Pipe balances unavailable for finalize post-condition");
  }

  return {
    balance1: BigInt(pipe.balance1),
    balance2: BigInt(pipe.balance2),
  };
}

async function refreshPipes() {
  if (!connectedAddress) {
    setStatus(ids.walletStatus, "Connect wallet to load pipes.", true);
    renderPipesPlaceholder("Connect wallet to load watched pipes.");
    return;
  }

  try {
    const baseUrl = normalizedText(getInput(ids.watchtowerUrl).value);
    if (!baseUrl) {
      throw new Error("Watchtower URL is required");
    }

    const [pipeBody, closureBody] = await Promise.all([
      fetchJson(
        `${baseUrl}/pipes?limit=500&principal=${encodeURIComponent(connectedAddress)}`,
      ),
      fetchJson(`${baseUrl}/closures`),
    ]);

    const pipes = Array.isArray(pipeBody.pipes) ? pipeBody.pipes : [];
    const closures = Array.isArray(closureBody.closures) ? closureBody.closures : [];
    const closureByPipeId = new Map(
      closures.map((item) => [`${item.contractId || ""}|${item.pipeId}`, item]),
    );

    if (pipes.length === 0) {
      renderPipesPlaceholder("No watched pipes for this wallet.");
      return;
    }

    $(ids.pipesBody).innerHTML = pipes
      .map((pipe) => {
        const balances = computeDisplayBalances(pipe, connectedAddress);
        const closure = closureByPipeId.get(
          `${pipe.contractId || ""}|${pipe.pipeId}`,
        );
        const closureText = closure
          ? `${closure.event} (exp ${closure.expiresAt ?? "?"})`
          : "-";
        return `<article class="pipe-card">
          <div class="pipe-card-head">
            <div class="pipe-peer">${escapeHtml(balances.counterparty || "-")}</div>
            <div class="pipe-token">${escapeHtml(pipe.pipeKey?.token ?? "STX")}</div>
          </div>
          <div class="pipe-stats">
            <div class="pipe-stat">
              <span class="pipe-stat-label">My confirmed</span>
              <span class="pipe-stat-value">${escapeHtml(toDisplayAmount(balances.mineConfirmed))}</span>
            </div>
            <div class="pipe-stat">
              <span class="pipe-stat-label">Their confirmed</span>
              <span class="pipe-stat-value">${escapeHtml(toDisplayAmount(balances.theirsConfirmed))}</span>
            </div>
            <div class="pipe-stat">
              <span class="pipe-stat-label">My pending</span>
              <span class="pipe-stat-value">${pendingText(
                balances.minePending,
                balances.minePendingHeight,
              )}</span>
            </div>
            <div class="pipe-stat">
              <span class="pipe-stat-label">Their pending</span>
              <span class="pipe-stat-value">${pendingText(
                balances.theirsPending,
                balances.theirsPendingHeight,
              )}</span>
            </div>
            <div class="pipe-stat">
              <span class="pipe-stat-label">My effective</span>
              <span class="pipe-stat-value">${escapeHtml(toDisplayAmount(balances.mineEffective))}</span>
            </div>
            <div class="pipe-stat">
              <span class="pipe-stat-label">Their effective</span>
              <span class="pipe-stat-value">${escapeHtml(toDisplayAmount(balances.theirsEffective))}</span>
            </div>
          </div>
          <div class="pipe-meta">
            <div>Nonce: ${escapeHtml(pipe.nonce ?? "-")} | Event: ${escapeHtml(pipe.event ?? "-")} | Source: ${escapeHtml(pipe.source ?? "-")}</div>
            <div>Closure: ${escapeHtml(closureText)}</div>
            <div>Pipe: ${escapeHtml(pipe.pipeId ?? "-")}</div>
            <div>Updated: ${escapeHtml(pipe.updatedAt ?? "-")}</div>
          </div>
        </article>`;
      })
      .join("");
  } catch (error) {
    setStatus(
      ids.walletStatus,
      error instanceof Error ? error.message : "failed to refresh pipes",
      true,
    );
  }
}

async function callContract(functionName, functionArgs, options = {}) {
  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const contract = parseContractId();
  const network = normalizedText(getInput(ids.network).value) || "devnet";
  const postConditions = Array.isArray(options.postConditions)
    ? options.postConditions
    : [];
  const postConditionMode = options.postConditionMode || "deny";
  const response = await request("stx_callContract", {
    contract,
    functionName,
    functionArgs,
    postConditions,
    postConditionMode,
    network,
  });
  const txid = extractTxid(response);
  return txid || JSON.stringify(response);
}

async function connectWallet() {
  try {
    const response = await connect();
    connectedAddress = await resolveConnectedAddress(response);
    getInput(ids.sigActor).value = connectedAddress;
    setStatus(ids.walletStatus, `Connected: ${connectedAddress}`);
    await refreshPipes();
  } catch (error) {
    setStatus(
      ids.walletStatus,
      error instanceof Error ? error.message : "wallet connection failed",
      true,
    );
  }
}

async function disconnectWallet() {
  try {
    await disconnect();
  } finally {
    connectedAddress = null;
    setStatus(ids.walletStatus, "Wallet disconnected.");
    renderPipesPlaceholder("Connect wallet to load watched pipes.");
  }
}

async function signStructuredState() {
  try {
    if (!connectedAddress) {
      throw new Error("Connect wallet first");
    }

    const state = await buildStructuredState();
    const response = await request("stx_signStructuredMessage", {
      domain: state.domain,
      message: state.message,
    });
    const signature = extractSignature(response);
    if (!signature) {
      throw new Error("Wallet did not return a signature");
    }

    getInput(ids.sigMySignature).value = normalizeHex(
      signature,
      "Generated signature",
      65,
    );
    renderPayloadPreview();
  } catch (error) {
    setStatus(
      ids.walletStatus,
      error instanceof Error ? error.message : "signing failed",
      true,
    );
  }
}

async function submitSignatureState() {
  try {
    const payload = buildWatchtowerPayload();
    const baseUrl = normalizedText(getInput(ids.watchtowerUrl).value);
    if (!baseUrl) {
      throw new Error("Watchtower URL is required");
    }

    const response = await fetch(`${baseUrl}/signature-states`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));

    if (response.status === 409 && body?.reason === "nonce-too-low") {
      const incomingNonce = body?.incomingNonce ?? payload.nonce ?? "?";
      const existingNonce = body?.existingNonce ?? body?.state?.nonce ?? "?";
      setStatus(
        ids.txResult,
        `Signature state rejected: nonce must be higher (incoming ${incomingNonce}, existing ${existingNonce}).`,
        true,
      );
      return;
    }

    if (!response.ok) {
      const message =
        typeof body?.error === "string"
          ? body.error
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    renderPayloadPreview();
    setStatus(
      ids.txResult,
      `Signature state stored (stored=${body.stored}, replaced=${body.replaced})`,
    );
    await refreshPipes();
  } catch (error) {
    setStatus(
      ids.txResult,
      error instanceof Error ? error.message : "submit state failed",
      true,
    );
  }
}

async function requestProducerSignature(action) {
  const baseUrl = normalizedText(getInput(ids.watchtowerUrl).value);
  if (!baseUrl) {
    throw new Error("Watchtower URL is required");
  }

  const requestPayload = buildProducerRequestPayload(action);
  const response = await fetch(`${baseUrl}${requestPayload.endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestPayload.payload),
  });
  const body = await response.json().catch(() => ({}));

  if (response.status === 409 && body?.reason === "nonce-too-low") {
    const incomingNonce =
      body?.incomingNonce ?? requestPayload.payload.nonce ?? "?";
    const existingNonce = body?.existingNonce ?? body?.state?.nonce ?? "?";
    setStatus(
      ids.txResult,
      `Producer request rejected: nonce must be higher (incoming ${incomingNonce}, existing ${existingNonce}).`,
      true,
    );
    return;
  }

  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  const producerSignature = normalizeHex(
    body?.mySignature,
    "Producer signature",
    65,
  );
  getInput(ids.sigTheirSignature).value = producerSignature;
  renderPayloadPreview();
  setStatus(
    ids.txResult,
    `Producer signature received (stored=${body.stored}, replaced=${body.replaced}).`,
  );
  await refreshPipes();
}

function bindInputs() {
  const configIds = [
    ids.watchtowerUrl,
    ids.contractId,
    ids.network,
    ids.contractVersion,
  ];
  for (const id of configIds) {
    getInput(id).addEventListener("change", saveConfig);
  }
  getInput(ids.watchtowerUrl).addEventListener("change", async () => {
    await syncNetworkFromWatchtower();
  });
  getInput(ids.actionSelect).addEventListener("change", () => {
    updateActionUi();
    renderPayloadPreview();
  });

  const sigInputs = [
    ids.sigWith,
    ids.sigActor,
    ids.sigToken,
    ids.sigTokenAssetName,
    ids.sigAction,
    ids.sigMyBalance,
    ids.sigTheirBalance,
    ids.sigNonce,
    ids.sigValidAfter,
    ids.sigSecret,
    ids.sigMySignature,
    ids.sigTheirSignature,
    ids.callFundAmount,
  ];
  for (const id of sigInputs) {
    getInput(id).addEventListener("input", renderPayloadPreview);
  }

  getInput(ids.sigToken).addEventListener("change", () => {
    const token = normalizedText(getInput(ids.sigToken).value);
    if (!token) {
      return;
    }

    const existing = normalizedText(getInput(ids.sigTokenAssetName).value);
    if (existing) {
      return;
    }

    const inferred = inferTokenAssetName(token);
    if (inferred) {
      getInput(ids.sigTokenAssetName).value = inferred;
    }
  });
}

function normalizeNetworkName(value) {
  const text = normalizedText(value).toLowerCase();
  if (
    text === "mainnet" ||
    text === "testnet" ||
    text === "devnet" ||
    text === "mocknet"
  ) {
    return text;
  }
  return null;
}

async function syncNetworkFromWatchtower() {
  const baseUrl = normalizedText(getInput(ids.watchtowerUrl).value);
  if (!baseUrl) {
    return;
  }

  try {
    const health = await fetchJson(`${baseUrl}/health`);
    watchtowerProducerEnabled = Boolean(health?.producerEnabled);
    watchtowerProducerPrincipal =
      typeof health?.producerPrincipal === "string" &&
      normalizedText(health.producerPrincipal)
        ? health.producerPrincipal
        : null;
    const remoteNetwork = normalizeNetworkName(health?.stacksNetwork);
    if (!remoteNetwork) {
      return;
    }

    const uiNetwork = normalizeNetworkName(getInput(ids.network).value);
    if (uiNetwork !== remoteNetwork) {
      getInput(ids.network).value = remoteNetwork;
      saveConfig();
      setStatus(
        ids.walletStatus,
        `Network auto-synced from watchtower: ${remoteNetwork}`,
      );
    }

    if (isProducerRequestAction(getSelectedAction())) {
      updateActionUi();
      renderPayloadPreview();
    }
  } catch {
    // Ignore; watchtower may be offline during page load.
  }
}

async function initWalletState() {
  try {
    if (!isConnected()) {
      return;
    }
    connectedAddress = await resolveConnectedAddress();
    getInput(ids.sigActor).value = connectedAddress;
    setStatus(ids.walletStatus, `Connected: ${connectedAddress}`);
    await refreshPipes();
  } catch {
    connectedAddress = null;
  }
}

async function callFundPipe() {
  const action = parseActionContext({ requireNonce: true });
  const amount = toBigInt(
    getInput(ids.callFundAmount).value,
    "fund-pipe amount",
  );
  const postConditions = [
    makePostConditionForTransfer(connectedAddress, action.token, amount),
  ];

  const txid = await callContract("fund-pipe", [
    optionalPrincipalCv(action.token),
    Cl.uint(amount),
    Cl.principal(action.withPrincipal),
    Cl.uint(action.nonce),
  ], {
    postConditions,
    postConditionMode: "deny",
  });
  setStatus(ids.txResult, `fund-pipe submitted: ${txid}`);
}

async function callDeposit() {
  const signer = parseSignerInputs();
  const amount = toBigInt(
    getInput(ids.callFundAmount).value,
    "deposit amount",
  );
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const theirSignature = normalizeHex(
    getInput(ids.sigTheirSignature).value,
    "Counterparty signature",
    65,
  );
  const postConditions = [
    makePostConditionForTransfer(connectedAddress, signer.token, amount),
  ];

  const txid = await callContract("deposit", [
    Cl.uint(amount),
    optionalPrincipalCv(signer.token),
    Cl.principal(signer.withPrincipal),
    Cl.uint(signer.myBalance),
    Cl.uint(signer.theirBalance),
    signatureToBufferCv(mySignature),
    signatureToBufferCv(theirSignature),
    Cl.uint(signer.nonce),
  ], {
    postConditions,
    postConditionMode: "deny",
  });
  setStatus(ids.txResult, `deposit submitted: ${txid}`);
}

async function callWithdraw() {
  const signer = parseSignerInputs();
  const contractId = parseContractId();
  const amount = toBigInt(
    getInput(ids.callFundAmount).value,
    "withdraw amount",
  );
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const theirSignature = normalizeHex(
    getInput(ids.sigTheirSignature).value,
    "Counterparty signature",
    65,
  );
  const postConditions = [
    makePostConditionForTransfer(contractId, signer.token, amount),
  ];

  const txid = await callContract("withdraw", [
    Cl.uint(amount),
    optionalPrincipalCv(signer.token),
    Cl.principal(signer.withPrincipal),
    Cl.uint(signer.myBalance),
    Cl.uint(signer.theirBalance),
    signatureToBufferCv(mySignature),
    signatureToBufferCv(theirSignature),
    Cl.uint(signer.nonce),
  ], {
    postConditions,
    postConditionMode: "deny",
  });
  setStatus(ids.txResult, `withdraw submitted: ${txid}`);
}

async function callForceCancel() {
  const action = parseActionContext();
  const txid = await callContract("force-cancel", [
    optionalPrincipalCv(action.token),
    Cl.principal(action.withPrincipal),
  ]);
  setStatus(ids.txResult, `force-cancel submitted: ${txid}`);
}

async function callFinalize() {
  const action = parseActionContext();
  const contractId = parseContractId();
  const totals = await resolvePipeTotals(action.withPrincipal, action.token);
  const txid = await callContract("finalize", [
    optionalPrincipalCv(action.token),
    Cl.principal(action.withPrincipal),
  ], {
    postConditions: [
      makePostConditionForTransfer(
        contractId,
        action.token,
        totals.balance1 + totals.balance2,
      ),
    ],
    postConditionMode: "deny",
  });
  setStatus(ids.txResult, `finalize submitted: ${txid}`);
}

async function callClosePipe() {
  const signer = parseSignerInputs();
  const contractId = parseContractId();
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const theirSignature = normalizeHex(
    getInput(ids.sigTheirSignature).value,
    "Counterparty signature",
    65,
  );
  const total = signer.myBalance + signer.theirBalance;
  const txid = await callContract("close-pipe", [
    optionalPrincipalCv(signer.token),
    Cl.principal(signer.withPrincipal),
    Cl.uint(signer.myBalance),
    Cl.uint(signer.theirBalance),
    signatureToBufferCv(mySignature),
    signatureToBufferCv(theirSignature),
    Cl.uint(signer.nonce),
  ], {
    postConditions: [
      makePostConditionForTransfer(contractId, signer.token, total),
    ],
    postConditionMode: "deny",
  });
  setStatus(ids.txResult, `close-pipe submitted: ${txid}`);
}

async function callForceClose() {
  const signer = parseSignerInputs();
  const mySignature = normalizeHex(
    getInput(ids.sigMySignature).value,
    "My signature",
    65,
  );
  const theirSignature = normalizeHex(
    getInput(ids.sigTheirSignature).value,
    "Counterparty signature",
    65,
  );
  const txid = await callContract("force-close", [
    optionalPrincipalCv(signer.token),
    Cl.principal(signer.withPrincipal),
    Cl.uint(signer.myBalance),
    Cl.uint(signer.theirBalance),
    signatureToBufferCv(mySignature),
    signatureToBufferCv(theirSignature),
    Cl.uint(signer.nonce),
    Cl.uint(signer.action),
    Cl.principal(signer.actor),
    optionalSecretCv(signer.secret),
    optionalUIntCv(signer.validAfter),
  ]);
  setStatus(ids.txResult, `force-close submitted: ${txid}`);
}

async function executeSelectedAction() {
  const action = getSelectedAction();
  setStatus(ids.txResult, "");

  if (action === "fund-pipe") {
    await callFundPipe();
    return;
  }

  if (action === "deposit") {
    await callDeposit();
    return;
  }

  if (action === "withdraw") {
    await callWithdraw();
    return;
  }

  if (action === "force-cancel") {
    await callForceCancel();
    return;
  }

  if (action === "close-pipe") {
    await callClosePipe();
    return;
  }

  if (action === "force-close") {
    await callForceClose();
    return;
  }

  if (action === "finalize") {
    await callFinalize();
    return;
  }

  if (
    action === "sign-transfer" ||
    action === "sign-deposit" ||
    action === "sign-withdrawal" ||
    action === "sign-close"
  ) {
    setSignedActionForSelection(action);
    await signStructuredState();
    setStatus(ids.txResult, "Signature generated.");
    return;
  }

  if (action === "submit-signature-state") {
    await submitSignatureState();
    return;
  }

  if (isProducerRequestAction(action)) {
    await requestProducerSignature(action);
    return;
  }

  throw new Error(`Unsupported action: ${action}`);
}

function wireActions() {
  $("connect-btn").addEventListener("click", connectWallet);
  $("disconnect-btn").addEventListener("click", disconnectWallet);
  $("refresh-pipes-btn").addEventListener("click", refreshPipes);

  $(ids.actionSubmitBtn).addEventListener("click", async () => {
    try {
      await executeSelectedAction();
    } catch (error) {
      setStatus(
        ids.txResult,
        error instanceof Error ? error.message : "action failed",
        true,
      );
    }
  });
}

async function init() {
  defaultConfig();
  loadConfig();
  bindInputs();
  wireActions();
  updateActionUi();
  await syncNetworkFromWatchtower();
  await initWalletState();
  if (!connectedAddress) {
    renderPipesPlaceholder("Connect wallet to load watched pipes.");
  }
  renderPayloadPreview();
}

init();
