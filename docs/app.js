import {
  connect,
  disconnect,
  isConnected,
  request,
} from "https://esm.sh/@stacks/connect?bundle&target=es2020";
import { createNetwork } from "https://esm.sh/@stacks/network@7.2.0?bundle&target=es2020";
import {
  Cl,
  Pc,
  cvToJSON,
  fetchCallReadOnlyFunction,
  getAddressFromPublicKey,
  principalCV,
  publicKeyFromSignatureRsv,
  serializeCV,
} from "https://esm.sh/@stacks/transactions@7.2.0?bundle&target=es2020";

const CHAIN_IDS = {
  mainnet: 1n,
  testnet: 2147483648n,
  devnet: 2147483648n,
};

const DEFAULT_API_BY_NETWORK = {
  mainnet: "https://api.hiro.so",
  testnet: "https://api.testnet.hiro.so",
  devnet: "http://127.0.0.1:3999",
};

const STACKFLOW_MESSAGE_VERSION = "0.6.0";
const BNSV2_API_BASE = "https://api.bnsv2.com";
const CONTRACT_PRESETS_BY_NETWORK = {
  devnet: [
    {
      key: "stx-devnet",
      label: "STX (devnet default)",
      contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackflow",
      tokenContract: "",
    },
    {
      key: "sbtc-devnet",
      label: "sBTC (devnet default)",
      contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackflow-sbtc",
      tokenContract: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.test-token",
    },
  ],
  testnet: [
    {
      key: "stx-testnet",
      label: "STX (testnet default)",
      contractId: "ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0",
      tokenContract: "",
    },
    {
      key: "sbtc-testnet",
      label: "sBTC (testnet default)",
      contractId: "ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-sbtc-0-6-0",
      tokenContract: "",
    },
  ],
  mainnet: [
    {
      key: "stx-mainnet",
      label: "STX (mainnet default)",
      contractId: "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-0-6-0",
      tokenContract: "",
    },
    {
      key: "sbtc-mainnet",
      label: "sBTC (mainnet default)",
      contractId: "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0",
      tokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    },
  ],
};

const elements = {
  network: document.getElementById("network"),
  stacksApiUrl: document.getElementById("stacks-api-url"),
  contractId: document.getElementById("contract-id"),
  contractPreset: document.getElementById("contract-preset"),
  counterparty: document.getElementById("counterparty"),
  tokenContract: document.getElementById("token-contract"),
  forPrincipal: document.getElementById("for-principal"),
  openAmount: document.getElementById("open-amount"),
  openNonce: document.getElementById("open-nonce"),
  // Pipe State
  pipeNonce: document.getElementById("pipe-nonce"),
  pipeMyBalance: document.getElementById("pipe-my-balance"),
  pipeTheirBalance: document.getElementById("pipe-their-balance"),
  // Proposed Action
  actionType: document.getElementById("action-type"),
  actionAmount: document.getElementById("action-amount"),
  actionAmountRow: document.getElementById("action-amount-row"),
  resultNonce: document.getElementById("result-nonce"),
  resultActionCode: document.getElementById("result-action-code"),
  resultMyBalance: document.getElementById("result-my-balance"),
  resultTheirBalance: document.getElementById("result-their-balance"),
  // Shared transfer fields
  transferActor: document.getElementById("transfer-actor"),
  actorCustomRow: document.getElementById("actor-custom-row"),
  transferActorCustom: document.getElementById("transfer-actor-custom"),
  transferSecret: document.getElementById("transfer-secret"),
  transferValidAfter: document.getElementById("transfer-valid-after"),
  // Sign & Validate
  mySignature: document.getElementById("my-signature"),
  validateSignature: document.getElementById("validate-signature"),
  validateSigBtn: document.getElementById("validate-sig-btn"),
  useMySignatureBtn: document.getElementById("use-my-sig-btn"),
  validationResult: document.getElementById("validation-result"),
  validationIcon: document.getElementById("validation-icon"),
  validationText: document.getElementById("validation-text"),
  // Common
  walletStatus: document.getElementById("wallet-status"),
  connectWallet: document.getElementById("connect-wallet"),
  disconnectWallet: document.getElementById("disconnect-wallet"),
  getPipe: document.getElementById("get-pipe"),
  openPipe: document.getElementById("open-pipe"),
  forceCancel: document.getElementById("force-cancel"),
  signTransfer: document.getElementById("sign-transfer"),
  buildPayload: document.getElementById("build-payload"),
  copyOutput: document.getElementById("copy-output"),
  output: document.getElementById("output"),
  log: document.getElementById("log"),
};

const state = {
  connectedAddress: null,
  lastSignature: null,
  lastPayload: null,
  nameCache: new Map(),
};

function normalizedText(value) {
  return String(value ?? "").trim();
}

function isStacksAddress(value) {
  return /^S[PMTN][A-Z0-9]{38,42}$/i.test(normalizedText(value));
}

function isAddressOnNetwork(address, network = readNetwork()) {
  const text = normalizedText(address).toUpperCase();
  if (!text) {
    return false;
  }
  if (network === "mainnet") {
    return /^S[PM]/.test(text);
  }
  return /^S[TN]/.test(text);
}

function isPrincipalText(value) {
  const text = normalizedText(value);
  if (!text || !/^S/i.test(text)) {
    return false;
  }
  try {
    principalCV(text);
    return true;
  } catch {
    return false;
  }
}

function getStacksApiBase() {
  const apiBase = normalizedText(elements.stacksApiUrl.value).replace(/\/+$/, "");
  if (!apiBase) {
    throw new Error("Stacks API URL is required");
  }
  return apiBase;
}

function looksLikeBtcName(value) {
  const text = normalizedText(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,36}\.btc$/.test(text);
}

function nowStamp() {
  return new Date().toISOString().slice(11, 19);
}

function appendLog(message, { error = false } = {}) {
  const next = `[${nowStamp()}] ${message}`;
  elements.log.textContent = `${elements.log.textContent}\n${next}`.trim();
  elements.log.scrollTop = elements.log.scrollHeight;
  if (error) {
    console.error(`[pipe-console] ${message}`);
  } else {
    console.log(`[pipe-console] ${message}`);
  }
}

function setOutput(value) {
  elements.output.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function setWalletStatus(message, { error = false } = {}) {
  elements.walletStatus.textContent = message;
  elements.walletStatus.classList.toggle("error", error);
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function cvHex(cv) {
  return `0x${toHex(serializeCV(cv))}`;
}

function compareBytes(left, right) {
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
}

function canonicalPrincipals(a, b) {
  const aBytes = serializeCV(principalCV(a));
  const bBytes = serializeCV(principalCV(b));
  return compareBytes(aBytes, bBytes) <= 0
    ? { principal1: a, principal2: b }
    : { principal1: b, principal2: a };
}

function unwrapClarityJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => unwrapClarityJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value;
  const keys = Object.keys(record);
  if (keys.length === 2 && keys.includes("type") && keys.includes("value")) {
    const type = String(record.type || "");
    if (type === "uint" || type === "int") {
      return String(record.value ?? "");
    }
    if (type === "optional_none") {
      return null;
    }
    return unwrapClarityJson(record.value);
  }

  const output = {};
  for (const [key, nested] of Object.entries(record)) {
    output[key] = unwrapClarityJson(nested);
  }
  return output;
}

function parseContractId() {
  const raw = normalizedText(elements.contractId.value);
  if (!raw.includes(".")) {
    throw new Error("Contract must be ADDRESS.NAME");
  }
  const [address, name] = raw.split(".");
  if (!address || !name) {
    throw new Error("Contract must be ADDRESS.NAME");
  }
  principalCV(address);
  return { contractId: raw, contractAddress: address, contractName: name };
}

function readNetwork() {
  const network = normalizedText(elements.network.value).toLowerCase();
  if (!CHAIN_IDS[network]) {
    throw new Error(`Unsupported network: ${network}`);
  }
  return network;
}

function extractPrincipalFromNamePayload(payload) {
  const visited = new Set();
  const crawl = (value) => {
    if (value == null) {
      return null;
    }
    if (typeof value === "string") {
      return isPrincipalText(value) ? value : null;
    }
    if (typeof value !== "object") {
      return null;
    }
    if (visited.has(value)) {
      return null;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = crawl(entry);
        if (found) {
          return found;
        }
      }
      return null;
    }

    const priorityKeys = [
      "address",
      "owner",
      "owner_address",
      "ownerAddress",
      "current_owner",
      "principal",
    ];
    for (const key of priorityKeys) {
      if (key in value) {
        const found = crawl(value[key]);
        if (found) {
          return found;
        }
      }
    }
    for (const nested of Object.values(value)) {
      const found = crawl(nested);
      if (found) {
        return found;
      }
    }
    return null;
  };

  return crawl(payload);
}

async function resolveBtcNameToPrincipal(name) {
  const normalizedName = normalizedText(name).toLowerCase();
  const network = readNetwork();
  const cacheKey = `${network}:${normalizedName}`;
  const cached = state.nameCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const encoded = encodeURIComponent(normalizedName);
  const endpoints =
    network === "mainnet"
      ? [`${BNSV2_API_BASE}/names/${encoded}`]
      : network === "testnet"
        ? [`${BNSV2_API_BASE}/testnet/names/${encoded}`]
        : [`${BNSV2_API_BASE}/testnet/names/${encoded}`, `${BNSV2_API_BASE}/names/${encoded}`];

  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { accept: "application/json" },
      });
      if (response.status === 404) {
        failures.push(`${response.status} ${endpoint}`);
        continue;
      }
      if (!response.ok) {
        failures.push(`${response.status} ${endpoint}`);
        continue;
      }
      const body = await response.json().catch(() => null);
      const principal = extractPrincipalFromNamePayload(body);
      if (principal) {
        state.nameCache.set(cacheKey, principal);
        return principal;
      }
      failures.push(`no-principal ${endpoint}`);
    } catch (error) {
      failures.push(
        `error ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Could not resolve ${normalizedName}. Tried: ${failures.slice(0, 3).join(" | ")}`,
  );
}

async function resolvePrincipalInput(fieldName, value, { required = true } = {}) {
  const input = normalizedText(value);
  if (!input) {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return null;
  }

  if (isPrincipalText(input)) {
    return input;
  }

  if (looksLikeBtcName(input)) {
    const principal = await resolveBtcNameToPrincipal(input);
    appendLog(`${fieldName}: resolved ${input} -> ${principal}`);
    return principal;
  }

  throw new Error(`${fieldName} must be a Stacks principal or .btc name`);
}

function parseOptionalTokenCV() {
  const token = normalizedText(elements.tokenContract.value);
  if (!token) {
    return { cv: Cl.none(), tokenText: null };
  }
  principalCV(token);
  return { cv: Cl.some(Cl.principal(token)), tokenText: token };
}

function parseUintInput(fieldName, value, { min = 0n } = {}) {
  const raw = normalizedText(value);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${fieldName} must be an unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed < min) {
    throw new Error(`${fieldName} must be >= ${min.toString(10)}`);
  }
  return parsed;
}

function hexToBytes(value) {
  const text = normalizedText(value).toLowerCase();
  const normalized = text.startsWith("0x") ? text.slice(2) : text;
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("hashed secret must be valid hex");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function parseHashedSecretCV() {
  const secret = normalizedText(elements.transferSecret.value);
  if (!secret) {
    return { cv: Cl.none(), text: null };
  }
  const bytes = hexToBytes(secret);
  if (bytes.length !== 32) {
    throw new Error("hashed secret must be exactly 32 bytes");
  }
  return { cv: Cl.some(Cl.buffer(bytes)), text: `0x${toHex(bytes)}` };
}

function parseValidAfterCV() {
  const raw = normalizedText(elements.transferValidAfter.value);
  if (!raw) {
    return { cv: Cl.none(), text: null };
  }
  const value = parseUintInput("Valid After", raw);
  return { cv: Cl.some(Cl.uint(value)), text: value.toString(10) };
}

function extractAddress(response, network = readNetwork()) {
  const seen = new Set();
  const found = [];
  const crawl = (value) => {
    if (value == null) return;
    if (typeof value === "string" && isStacksAddress(value)) {
      found.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        crawl(entry);
      }
      return;
    }

    if (typeof value.address === "string" && isStacksAddress(value.address)) {
      found.push(value.address);
    }
    for (const nested of Object.values(value)) {
      crawl(nested);
    }
  };
  crawl(response);
  return found.find((address) => isAddressOnNetwork(address, network)) || found[0] || null;
}

function extractSignature(response) {
  if (!response || typeof response !== "object") return null;
  if (typeof response.signature === "string") return response.signature;
  if (response.result && typeof response.result === "object") {
    if (typeof response.result.signature === "string") return response.result.signature;
  }
  return null;
}

function extractTxid(response) {
  if (!response || typeof response !== "object") return null;
  if (typeof response.txid === "string") return response.txid;
  if (response.result && typeof response.result === "object") {
    if (typeof response.result.txid === "string") return response.result.txid;
  }
  return null;
}

async function ensureWallet({ interactive }) {
  if (state.connectedAddress) {
    return state.connectedAddress;
  }
  let connected = false;
  try {
    connected = await Promise.resolve(isConnected());
  } catch {
    connected = false;
  }

  if (!connected && interactive) {
    await connect();
  }

  if (connected || interactive) {
    const addresses = await request("getAddresses");
    const address = extractAddress(addresses, readNetwork());
    if (!address) {
      throw new Error("No Stacks address was returned by the wallet");
    }
    state.connectedAddress = address;
    elements.forPrincipal.value = elements.forPrincipal.value || address;
    setWalletStatus(`Connected: ${address}`);
    updateActorOptions();
    return address;
  }

  return null;
}

function updateNetworkDefaults() {
  const network = readNetwork();
  if (!normalizedText(elements.stacksApiUrl.value)) {
    elements.stacksApiUrl.value = DEFAULT_API_BY_NETWORK[network];
  }
}

function getPresetsForNetwork(network = readNetwork()) {
  return CONTRACT_PRESETS_BY_NETWORK[network] || [];
}

function findPresetByKey(presetKey, network = readNetwork()) {
  return getPresetsForNetwork(network).find((preset) => preset.key === presetKey) || null;
}

function renderPresetOptions(network = readNetwork()) {
  const presets = getPresetsForNetwork(network);
  const selected = normalizedText(elements.contractPreset.value) || "custom";
  const options = [
    ...presets.map((preset) => `<option value="${preset.key}">${preset.label}</option>`),
    '<option value="custom">Custom (manual)</option>',
  ];
  elements.contractPreset.innerHTML = options.join("");

  if (presets.some((preset) => preset.key === selected) || selected === "custom") {
    elements.contractPreset.value = selected;
  } else {
    elements.contractPreset.value = "custom";
  }
}

function getPresetKeyByValues(contractId, tokenContract, network = readNetwork()) {
  const contractText = normalizedText(contractId);
  const tokenText = normalizedText(tokenContract);
  for (const preset of getPresetsForNetwork(network)) {
    if (
      normalizedText(preset.contractId) === contractText &&
      normalizedText(preset.tokenContract) === tokenText
    ) {
      return preset.key;
    }
  }
  return "custom";
}

function applyContractPreset(presetKey, { log = true } = {}) {
  const preset = findPresetByKey(presetKey);
  if (!preset) {
    return;
  }
  elements.contractId.value = preset.contractId;
  elements.tokenContract.value = preset.tokenContract;
  if (log) {
    appendLog(
      `Applied preset ${presetKey}: contract=${preset.contractId}, token=${
        preset.tokenContract || "(none)"
      }`,
    );
  }
}

async function handleConnectWallet() {
  try {
    const address = await ensureWallet({ interactive: true });
    appendLog(`Wallet connected: ${address}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setWalletStatus(message, { error: true });
    appendLog(`Connect wallet failed: ${message}`, { error: true });
  }
}

async function handleDisconnectWallet() {
  const previousAddress = state.connectedAddress;
  try {
    await disconnect();
  } catch {
    // Some providers may not implement explicit disconnect cleanly; still clear local state.
  }

  state.connectedAddress = null;
  state.lastSignature = null;
  if (previousAddress && normalizedText(elements.forPrincipal.value) === previousAddress) {
    elements.forPrincipal.value = "";
  }
  if (previousAddress && normalizedText(elements.transferActor.value) === previousAddress) {
    elements.transferActor.value = "";
  }
  setWalletStatus("Wallet not connected.");
  appendLog(previousAddress ? `Wallet disconnected: ${previousAddress}` : "Wallet disconnected.");
}

function getReadOnlySenderCandidates(sender, contractAddress, network = readNetwork()) {
  const candidates = [];
  const senderText = normalizedText(sender);
  const contractAddressText = normalizedText(contractAddress);

  if (senderText && isAddressOnNetwork(senderText, network)) {
    candidates.push(senderText);
  }
  if (
    contractAddressText &&
    isAddressOnNetwork(contractAddressText, network) &&
    !candidates.includes(contractAddressText)
  ) {
    candidates.push(contractAddressText);
  }
  if (senderText && !candidates.includes(senderText)) {
    candidates.push(senderText);
  }
  if (contractAddressText && !candidates.includes(contractAddressText)) {
    candidates.push(contractAddressText);
  }
  return candidates;
}

async function fetchReadOnly(functionName, functionArgs, sender) {
  const { contractAddress, contractName } = parseContractId();
  const network = createNetwork({
    network: readNetwork(),
    client: { baseUrl: getStacksApiBase() },
  });
  const senders = getReadOnlySenderCandidates(sender, contractAddress);

  let lastError = null;
  for (const senderCandidate of senders) {
    try {
      const result = await fetchCallReadOnlyFunction({
        network,
        senderAddress: senderCandidate,
        contractAddress,
        contractName,
        functionName,
        functionArgs,
      });
      if (senderCandidate !== sender) {
        appendLog(`Read-only ${functionName} used fallback sender=${senderCandidate}.`);
      }
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : "Read-only call failed for all sender candidates";
  throw new Error(message);
}

async function handleGetPipe() {
  try {
    const withPrincipal = await resolvePrincipalInput(
      "Counterparty",
      elements.counterparty.value,
    );
    const forPrincipal = await resolvePrincipalInput(
      "For Principal",
      elements.forPrincipal.value || state.connectedAddress,
    );
    const { cv: tokenCV } = parseOptionalTokenCV();

    const resultCv = await fetchReadOnly(
      "get-pipe",
      [tokenCV, Cl.principal(withPrincipal)],
      forPrincipal,
    );
    const resultHex = cvHex(resultCv);
    const decoded = unwrapClarityJson(cvToJSON(resultCv));
    setOutput({
      call: "get-pipe",
      forPrincipal,
      withPrincipal,
      resultHex,
      decoded,
    });

    // Populate Pipe State fields when we get valid data
    if (decoded && decoded.nonce !== undefined) {
      elements.pipeNonce.value = decoded.nonce;
      const pair = canonicalPrincipals(forPrincipal, withPrincipal);
      const iAmP1 = pair.principal1 === forPrincipal;
      elements.pipeMyBalance.value = iAmP1 ? (decoded["balance-1"] ?? "0") : (decoded["balance-2"] ?? "0");
      elements.pipeTheirBalance.value = iAmP1 ? (decoded["balance-2"] ?? "0") : (decoded["balance-1"] ?? "0");
      updatePreview();
      appendLog("Fetched pipe state and populated fields.");
    } else {
      appendLog("Fetched pipe state via read-only get-pipe.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput(`Error: ${message}`);
    appendLog(`Get pipe failed: ${message}`, { error: true });
  }
}

function stxPostConditionForAmount(principal, amount) {
  return Pc.principal(principal).willSendEq(amount).ustx();
}

async function callContract(functionName, functionArgs, options = {}) {
  const { contractId } = parseContractId();
  const network = readNetwork();
  return request("stx_callContract", {
    contract: contractId,
    functionName,
    functionArgs,
    network,
    postConditionMode: options.postConditionMode ?? "deny",
    postConditions: options.postConditions ?? [],
  });
}

async function handleOpenPipe() {
  try {
    const sender = await ensureWallet({ interactive: true });
    if (!sender) {
      throw new Error("Connect wallet first");
    }
    const withPrincipal = await resolvePrincipalInput(
      "Counterparty",
      elements.counterparty.value,
    );
    const amount = parseUintInput("Amount", elements.openAmount.value, { min: 1n });
    const nonceText = normalizedText(elements.openNonce.value);
    const nonce = nonceText ? parseUintInput("Nonce", nonceText) : 0n;
    const { cv: tokenCV, tokenText } = parseOptionalTokenCV();

    const args = [
      tokenCV,
      Cl.uint(amount),
      Cl.principal(withPrincipal),
      Cl.uint(nonce),
    ];

    const options =
      tokenText == null
        ? {
            postConditionMode: "deny",
            postConditions: [stxPostConditionForAmount(sender, amount)],
          }
        : {
            postConditionMode: "allow",
            postConditions: [],
          };

    const response = await callContract("fund-pipe", args, options);
    const txid = extractTxid(response);
    setOutput({
      action: "fund-pipe",
      txid,
      response,
    });
    appendLog(txid ? `fund-pipe submitted: ${txid}` : "fund-pipe submitted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput(`Error: ${message}`);
    appendLog(`Open pipe failed: ${message}`, { error: true });
  }
}

async function handleForceCancel() {
  try {
    await ensureWallet({ interactive: true });
    const withPrincipal = await resolvePrincipalInput(
      "Counterparty",
      elements.counterparty.value,
    );
    const { cv: tokenCV } = parseOptionalTokenCV();

    const response = await callContract("force-cancel", [
      tokenCV,
      Cl.principal(withPrincipal),
    ]);
    const txid = extractTxid(response);
    setOutput({
      action: "force-cancel",
      txid,
      response,
    });
    appendLog(txid ? `force-cancel submitted: ${txid}` : "force-cancel submitted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput(`Error: ${message}`);
    appendLog(`Force cancel failed: ${message}`, { error: true });
  }
}

function computeAutoResult() {
  const actionType = normalizedText(elements.actionType.value);
  const pipeNonce = parseUintInput("Nonce", elements.pipeNonce.value);
  const pipeMyBalance = parseUintInput("My Balance", elements.pipeMyBalance.value);
  const pipeTheirBalance = parseUintInput("Their Balance", elements.pipeTheirBalance.value);
  const amount = parseUintInput("Amount", elements.actionAmount.value);

  if (actionType === "transfer-to") {
    if (amount > pipeMyBalance) throw new Error("Amount exceeds my balance");
    return { nonce: pipeNonce + 1n, myBalance: pipeMyBalance - amount, theirBalance: pipeTheirBalance + amount, actionCode: 1n };
  }
  if (actionType === "transfer-from") {
    if (amount > pipeTheirBalance) throw new Error("Amount exceeds their balance");
    return { nonce: pipeNonce + 1n, myBalance: pipeMyBalance + amount, theirBalance: pipeTheirBalance - amount, actionCode: 1n };
  }
  if (actionType === "close") {
    return { nonce: pipeNonce + 1n, myBalance: pipeMyBalance, theirBalance: pipeTheirBalance, actionCode: 0n };
  }
  throw new Error(`Unknown action type: ${actionType}`);
}

function updatePreview() {
  try {
    const result = computeAutoResult();
    elements.resultNonce.value = result.nonce.toString();
    elements.resultMyBalance.value = result.myBalance.toString();
    elements.resultTheirBalance.value = result.theirBalance.toString();
    elements.resultActionCode.value = result.actionCode.toString();
  } catch {
    // leave fields as-is on error
  }
}

function truncateAddr(addr) {
  const t = normalizedText(addr);
  if (!t) return "";
  return t.length > 14 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t;
}

function updateActorOptions() {
  const myRaw = normalizedText(elements.forPrincipal.value) || state.connectedAddress || "";
  const themRaw = normalizedText(elements.counterparty.value) || "";
  const opts = elements.transferActor.options;
  opts[0].text = myRaw ? `Me — ${truncateAddr(myRaw)}` : "Me";
  opts[1].text = themRaw ? `Them — ${truncateAddr(themRaw)}` : "Them";
}

function handleActorChange() {
  const isCustom = normalizedText(elements.transferActor.value) === "custom";
  elements.actorCustomRow.classList.toggle("hidden", !isCustom);
}

function handleActionTypeChange() {
  const actionType = normalizedText(elements.actionType.value);
  const hasAmount = actionType === "transfer-to" || actionType === "transfer-from";
  elements.actionAmountRow.classList.toggle("hidden", !hasAmount);
  // Auto-select actor based on action
  if (actionType === "transfer-to") {
    elements.transferActor.value = "me";
  } else if (actionType === "transfer-from") {
    elements.transferActor.value = "them";
  } else if (actionType === "close") {
    elements.transferActor.value = "me";
  }
  handleActorChange();
  updatePreview();
}

function cvToBytes(cv) {
  const result = serializeCV(cv);
  // serializeCV returns a hex string in stacks.js v7
  if (typeof result === "string") {
    const hex = result.startsWith("0x") ? result.slice(2) : result;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
  return result;
}

async function computeStructuredDataHash(domain, message) {
  // SIP-018: sha256("SIP018" || sha256(domain_bytes) || sha256(message_bytes))
  const prefix = new Uint8Array([0x53, 0x49, 0x50, 0x30, 0x31, 0x38]);
  const [domainHashBuf, messageHashBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", cvToBytes(domain)),
    crypto.subtle.digest("SHA-256", cvToBytes(message)),
  ]);
  const payload = new Uint8Array(prefix.length + 32 + 32);
  payload.set(prefix, 0);
  payload.set(new Uint8Array(domainHashBuf), prefix.length);
  payload.set(new Uint8Array(messageHashBuf), prefix.length + 32);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
}

async function buildTransferContext() {
  const network = readNetwork();
  const { contractId } = parseContractId();
  const forPrincipal = await resolvePrincipalInput(
    "For Principal",
    elements.forPrincipal.value || state.connectedAddress,
  );
  const withPrincipal = await resolvePrincipalInput(
    "Counterparty",
    elements.counterparty.value,
  );
  const actorMode = normalizedText(elements.transferActor.value);
  const actor =
    actorMode === "me" ? forPrincipal
    : actorMode === "them" ? withPrincipal
    : await resolvePrincipalInput("Custom Actor", elements.transferActorCustom.value);
  const myBalance = parseUintInput("My Resulting Balance", elements.resultMyBalance.value);
  const theirBalance = parseUintInput("Their Resulting Balance", elements.resultTheirBalance.value);
  const nonce = parseUintInput("Resulting Nonce", elements.resultNonce.value);
  const action = parseUintInput("Action Code", elements.resultActionCode.value);
  const { cv: tokenCV, tokenText } = parseOptionalTokenCV();
  const { cv: hashedSecretCV, text: hashedSecretText } = parseHashedSecretCV();
  const { cv: validAfterCV, text: validAfterText } = parseValidAfterCV();

  const pair = canonicalPrincipals(forPrincipal, withPrincipal);
  const balance1 = pair.principal1 === forPrincipal ? myBalance : theirBalance;
  const balance2 = pair.principal1 === forPrincipal ? theirBalance : myBalance;

  const domain = Cl.tuple({
    name: Cl.stringAscii(contractId),
    version: Cl.stringAscii(STACKFLOW_MESSAGE_VERSION),
    "chain-id": Cl.uint(CHAIN_IDS[network]),
  });

  const message = Cl.tuple({
    token: tokenCV,
    "principal-1": Cl.principal(pair.principal1),
    "principal-2": Cl.principal(pair.principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(nonce),
    action: Cl.uint(action),
    actor: Cl.principal(actor),
    "hashed-secret": hashedSecretCV,
    "valid-after": validAfterCV,
  });

  return {
    network,
    contractId,
    forPrincipal,
    withPrincipal,
    token: tokenText,
    myBalance: myBalance.toString(10),
    theirBalance: theirBalance.toString(10),
    nonce: nonce.toString(10),
    action: action.toString(10),
    actor,
    hashedSecret: hashedSecretText,
    validAfter: validAfterText,
    domain,
    message,
  };
}

async function handleSignTransfer() {
  try {
    await ensureWallet({ interactive: true });
    const context = await buildTransferContext();
    const response = await request("stx_signStructuredMessage", {
      network: readNetwork(),
      domain: context.domain,
      message: context.message,
    });
    const signature = extractSignature(response);
    if (!signature) {
      throw new Error("Wallet did not return a signature");
    }
    state.lastSignature = signature;
    elements.mySignature.value = signature;

    const payload = {
      contractId: context.contractId,
      forPrincipal: context.forPrincipal,
      withPrincipal: context.withPrincipal,
      token: context.token,
      myBalance: context.myBalance,
      theirBalance: context.theirBalance,
      nonce: context.nonce,
      action: context.action,
      actor: context.actor,
      hashedSecret: context.hashedSecret,
      validAfter: context.validAfter,
      signature,
    };
    state.lastPayload = payload;
    setOutput(payload);
    appendLog("Structured transfer message signed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput(`Error: ${message}`);
    appendLog(`Sign transfer failed: ${message}`, { error: true });
  }
}

async function handleBuildPayload() {
  try {
    const context = await buildTransferContext();
    const payload = {
      contractId: context.contractId,
      forPrincipal: context.forPrincipal,
      withPrincipal: context.withPrincipal,
      token: context.token,
      myBalance: context.myBalance,
      theirBalance: context.theirBalance,
      nonce: context.nonce,
      action: context.action,
      actor: context.actor,
      hashedSecret: context.hashedSecret,
      validAfter: context.validAfter,
      signature: state.lastSignature,
    };
    state.lastPayload = payload;
    setOutput(payload);
    appendLog("Built transfer payload JSON.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput(`Error: ${message}`);
    appendLog(`Build payload failed: ${message}`, { error: true });
  }
}

function showValidationResult(success, text) {
  elements.validationResult.classList.remove("hidden");
  elements.validationIcon.textContent = success ? "✓" : "✗";
  elements.validationIcon.className = `validation-icon ${success ? "ok" : "fail"}`;
  elements.validationText.textContent = text;
}

async function handleValidateSignature() {
  try {
    const sigInput = normalizedText(elements.validateSignature.value);
    if (!sigInput) throw new Error("No signature to validate");

    const sig = sigInput.startsWith("0x") ? sigInput.slice(2) : sigInput;
    if (!/^[0-9a-fA-F]{130}$/.test(sig)) {
      throw new Error("Signature must be 65 bytes (130 hex chars)");
    }

    const context = await buildTransferContext();
    const hashBytes = await computeStructuredDataHash(context.domain, context.message);
    const hashHex = toHex(hashBytes);

    const network = readNetwork();
    const forAddr = context.forPrincipal.split(".")[0];
    const withAddr = context.withPrincipal.split(".")[0];

    // Try as-is (RSV), then with recovery byte moved from front to back (VRS→RSV)
    const candidates = [sig, sig.slice(2) + sig.slice(0, 2)];
    let recoveredAddress = null;
    let isParticipant = false;
    let label = "";

    for (const candidate of candidates) {
      try {
        const pubKey = publicKeyFromSignatureRsv(hashHex, candidate);
        const addr = getAddressFromPublicKey(pubKey, network);
        if (recoveredAddress === null) recoveredAddress = addr;
        if (addr === forAddr) {
          recoveredAddress = addr;
          label = `Signed by ME — ${addr}`;
          isParticipant = true;
          break;
        }
        if (addr === withAddr) {
          recoveredAddress = addr;
          label = `Signed by COUNTERPARTY — ${addr}`;
          isParticipant = true;
          break;
        }
      } catch {
        // try next format
      }
    }

    if (!recoveredAddress) throw new Error("Could not recover signer from signature");
    if (!isParticipant) label = `Unknown signer — ${recoveredAddress}`;

    showValidationResult(isParticipant, label);
    setOutput({ recoveredAddress, isParticipant, label });
    appendLog(`Signature validation: ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showValidationResult(false, message);
    setOutput(`Error: ${message}`);
    appendLog(`Validate signature failed: ${message}`, { error: true });
  }
}

function handleUseMySignature() {
  const sig = normalizedText(elements.mySignature.value) || state.lastSignature;
  if (!sig) {
    appendLog("No signature generated yet — sign with wallet first.", { error: true });
    return;
  }
  elements.validateSignature.value = sig;
}

async function handleCopyOutput() {
  try {
    await navigator.clipboard.writeText(elements.output.textContent || "");
    appendLog("Copied output to clipboard.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`Copy failed: ${message}`, { error: true });
  }
}

function wireEvents() {
  elements.connectWallet.addEventListener("click", handleConnectWallet);
  elements.disconnectWallet.addEventListener("click", handleDisconnectWallet);
  elements.getPipe.addEventListener("click", handleGetPipe);
  elements.openPipe.addEventListener("click", handleOpenPipe);
  elements.forceCancel.addEventListener("click", handleForceCancel);
  elements.signTransfer.addEventListener("click", handleSignTransfer);
  elements.buildPayload.addEventListener("click", handleBuildPayload);
  elements.validateSigBtn.addEventListener("click", handleValidateSignature);
  elements.useMySignatureBtn.addEventListener("click", handleUseMySignature);
  elements.copyOutput.addEventListener("click", handleCopyOutput);
  // Pipe State / Action preview live updates
  elements.actionType.addEventListener("change", handleActionTypeChange);
  elements.transferActor.addEventListener("change", handleActorChange);
  for (const id of ["pipe-nonce", "pipe-my-balance", "pipe-their-balance", "action-amount"]) {
    document.getElementById(id).addEventListener("input", updatePreview);
  }
  // Refresh actor option labels when principals change
  elements.forPrincipal.addEventListener("input", updateActorOptions);
  elements.counterparty.addEventListener("input", updateActorOptions);
  elements.network.addEventListener("change", () => {
    const previousPresetKey = elements.contractPreset.value;
    elements.stacksApiUrl.value = DEFAULT_API_BY_NETWORK[readNetwork()];
    renderPresetOptions();
    if (previousPresetKey !== "custom") {
      const presets = getPresetsForNetwork();
      if (presets.length > 0) {
        elements.contractPreset.value = presets[0].key;
        applyContractPreset(presets[0].key);
      }
      return;
    }
    elements.contractPreset.value = getPresetKeyByValues(
      elements.contractId.value,
      elements.tokenContract.value,
    );
  });
  elements.contractPreset.addEventListener("change", () => {
    const presetKey = elements.contractPreset.value;
    if (presetKey === "custom") {
      return;
    }
    applyContractPreset(presetKey);
  });
  elements.contractId.addEventListener("input", () => {
    elements.contractPreset.value = getPresetKeyByValues(
      elements.contractId.value,
      elements.tokenContract.value,
    );
  });
  elements.tokenContract.addEventListener("input", () => {
    elements.contractPreset.value = getPresetKeyByValues(
      elements.contractId.value,
      elements.tokenContract.value,
    );
  });
}

async function bootstrap() {
  wireEvents();
  handleActionTypeChange();
  updateActorOptions();
  updateNetworkDefaults();
  renderPresetOptions();
  if (!normalizedText(elements.contractId.value) && !normalizedText(elements.tokenContract.value)) {
    const presets = getPresetsForNetwork();
    if (presets.length > 0) {
      elements.contractPreset.value = presets[0].key;
      applyContractPreset(presets[0].key, { log: false });
    } else {
      elements.contractPreset.value = "custom";
    }
  } else {
    elements.contractPreset.value = getPresetKeyByValues(
      elements.contractId.value,
      elements.tokenContract.value,
    );
  }
  try {
    const address = await ensureWallet({ interactive: false });
    if (address) {
      appendLog(`Restored wallet session: ${address}`);
    } else {
      appendLog("No active wallet session.");
    }
  } catch (error) {
    appendLog(
      `Wallet session restore failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { error: true },
    );
  }
}

bootstrap().catch((error) => {
  appendLog(
    `Fatal startup error: ${error instanceof Error ? error.message : String(error)}`,
    { error: true },
  );
});
