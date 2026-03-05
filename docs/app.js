import { connect, isConnected, request } from "https://esm.sh/@stacks/connect?bundle&target=es2020";
import {
  Cl,
  Pc,
  cvToJSON,
  deserializeCV,
  principalCV,
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
const CONTRACT_PRESETS = {
  "stx-mainnet": {
    contractId: "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-0-6-0",
    tokenContract: "",
  },
  "sbtc-mainnet": {
    contractId: "SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0",
    tokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  },
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
  myBalance: document.getElementById("my-balance"),
  theirBalance: document.getElementById("their-balance"),
  transferNonce: document.getElementById("transfer-nonce"),
  transferAction: document.getElementById("transfer-action"),
  transferActor: document.getElementById("transfer-actor"),
  transferSecret: document.getElementById("transfer-secret"),
  transferValidAfter: document.getElementById("transfer-valid-after"),
  walletStatus: document.getElementById("wallet-status"),
  connectWallet: document.getElementById("connect-wallet"),
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
  return /^S[PMT][A-Z0-9]{38,42}$/i.test(normalizedText(value));
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

function decodeReadOnlyResult(resultHex) {
  const hex = normalizedText(resultHex);
  if (!hex) {
    return null;
  }
  const decoded = deserializeCV(hex);
  return unwrapClarityJson(cvToJSON(decoded));
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

function extractAddress(response) {
  const seen = new Set();
  const crawl = (value) => {
    if (value == null) return null;
    if (typeof value === "string" && isStacksAddress(value)) return value;
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = crawl(entry);
        if (found) return found;
      }
      return null;
    }

    if (typeof value.address === "string" && isStacksAddress(value.address)) {
      return value.address;
    }
    for (const nested of Object.values(value)) {
      const found = crawl(nested);
      if (found) return found;
    }
    return null;
  };
  return crawl(response);
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
    const address = extractAddress(addresses);
    if (!address) {
      throw new Error("No Stacks address was returned by the wallet");
    }
    state.connectedAddress = address;
    elements.forPrincipal.value = elements.forPrincipal.value || address;
    elements.transferActor.value = elements.transferActor.value || address;
    setWalletStatus(`Connected: ${address}`);
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

function getPresetKeyByValues(contractId, tokenContract) {
  const contractText = normalizedText(contractId);
  const tokenText = normalizedText(tokenContract);
  for (const [presetKey, preset] of Object.entries(CONTRACT_PRESETS)) {
    if (
      normalizedText(preset.contractId) === contractText &&
      normalizedText(preset.tokenContract) === tokenText
    ) {
      return presetKey;
    }
  }
  return "custom";
}

function applyContractPreset(presetKey, { log = true } = {}) {
  const preset = CONTRACT_PRESETS[presetKey];
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

async function fetchReadOnly(functionName, functionArgs, sender) {
  const { contractAddress, contractName } = parseContractId();
  const apiBase = getStacksApiBase();
  const url = `${apiBase}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sender,
      arguments: functionArgs.map((cv) => cvHex(cv)),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Read-only call failed (${response.status})`);
  }
  if (!body || typeof body !== "object") {
    throw new Error("Read-only response was not JSON");
  }
  if (body.okay === false) {
    throw new Error(`Read-only call returned error: ${body.cause || "unknown"}`);
  }
  return body.result;
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

    const resultHex = await fetchReadOnly(
      "get-pipe",
      [tokenCV, Cl.principal(withPrincipal)],
      forPrincipal,
    );
    const decoded = decodeReadOnlyResult(resultHex);
    setOutput({
      call: "get-pipe",
      forPrincipal,
      withPrincipal,
      resultHex,
      decoded,
    });
    appendLog("Fetched pipe state via read-only get-pipe.");
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
  const actor = await resolvePrincipalInput(
    "Actor Principal",
    elements.transferActor.value || forPrincipal,
  );
  const myBalance = parseUintInput("My Balance", elements.myBalance.value);
  const theirBalance = parseUintInput("Their Balance", elements.theirBalance.value);
  const nonce = parseUintInput("Nonce", elements.transferNonce.value);
  const action = parseUintInput("Action", elements.transferAction.value);
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
      domain: context.domain,
      message: context.message,
    });
    const signature = extractSignature(response);
    if (!signature) {
      throw new Error("Wallet did not return a signature");
    }
    state.lastSignature = signature;

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
      theirSignature: signature,
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
      theirSignature: state.lastSignature,
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
  elements.getPipe.addEventListener("click", handleGetPipe);
  elements.openPipe.addEventListener("click", handleOpenPipe);
  elements.forceCancel.addEventListener("click", handleForceCancel);
  elements.signTransfer.addEventListener("click", handleSignTransfer);
  elements.buildPayload.addEventListener("click", handleBuildPayload);
  elements.copyOutput.addEventListener("click", handleCopyOutput);
  elements.network.addEventListener("change", () => {
    elements.stacksApiUrl.value = DEFAULT_API_BY_NETWORK[readNetwork()];
  });
  elements.contractPreset.addEventListener("change", () => {
    applyContractPreset(elements.contractPreset.value);
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
  updateNetworkDefaults();
  if (!normalizedText(elements.contractId.value) && !normalizedText(elements.tokenContract.value)) {
    elements.contractPreset.value = "stx-mainnet";
    applyContractPreset("stx-mainnet", { log: false });
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
