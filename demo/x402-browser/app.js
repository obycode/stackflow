import { connect, isConnected, request } from "https://esm.sh/@stacks/connect?bundle&target=es2020";
import { Cl, Pc, principalCV, serializeCV } from "https://esm.sh/@stacks/transactions@7.2.0?bundle&target=es2020";

const CHAIN_IDS = {
  mainnet: 1n,
  testnet: 2147483648n,
  devnet: 2147483648n,
};

const STORAGE_KEY = "stackflow-x402-browser-settings-v3";
const STACKFLOW_MESSAGE_VERSION = "0.6.0";

const elements = {
  premiumLink: document.getElementById("premium-link"),
  connectWallet: document.getElementById("connect-wallet"),
  walletStatus: document.getElementById("wallet-status"),
  logOutput: document.getElementById("log-output"),
  responseOutput: document.getElementById("response-output"),
  paywallDialog: document.getElementById("paywall-dialog"),
  challengeText: document.getElementById("challenge-text"),
  payWallet: document.getElementById("pay-wallet"),
  openPipe: document.getElementById("open-pipe"),
  openAmount: document.getElementById("settings-open-amount"),
  configNetwork: document.getElementById("config-network"),
  configContract: document.getElementById("config-contract"),
  configObserver: document.getElementById("config-observer"),
};

const state = {
  connectedAddress: null,
  lastPaymentChallenge: null,
  config: {
    network: "testnet",
    contractId: "",
    counterpartyPrincipal: "",
    priceAmount: "",
    priceAsset: "",
    openPipeAmount: "1000",
    stacksNodeEventsObserver: "",
  },
};

function normalizedText(value) {
  return String(value ?? "").trim();
}

function nowStamp() {
  return new Date().toISOString().slice(11, 19);
}

function log(message, { error = false } = {}) {
  const line = `[${nowStamp()}] ${message}`;
  const current = elements.logOutput.textContent || "";
  elements.logOutput.textContent = `${current}\n${line}`.trimStart();
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  if (error) {
    console.error(`[x402-demo] ${message}`);
  } else {
    console.log(`[x402-demo] ${message}`);
  }
}

function setResponseOutput(value) {
  if (typeof value === "string") {
    elements.responseOutput.textContent = value;
    return;
  }
  elements.responseOutput.textContent = JSON.stringify(value, null, 2);
}

function setWalletStatus(message, { error = false } = {}) {
  elements.walletStatus.textContent = message;
  elements.walletStatus.style.color = error ? "#9f1f1f" : "var(--muted)";
}

function isStacksAddress(value) {
  return typeof value === "string" && /^S[PMT][A-Z0-9]{38,42}$/i.test(value);
}

function parseContractId(rawInput) {
  let contractId = normalizedText(rawInput);
  if (!contractId) {
    throw new Error("Stackflow contract is required");
  }
  if (contractId.startsWith("'")) {
    contractId = contractId.slice(1);
  }
  if (!contractId.includes(".") && contractId.includes("/")) {
    contractId = contractId.replace("/", ".");
  }

  const parts = contractId.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Stackflow contract must be in ADDRESS.NAME form");
  }

  const [address] = parts;
  try {
    principalCV(address);
  } catch {
    throw new Error("Invalid contract address");
  }

  return contractId;
}

function parseNetwork(value) {
  const network = normalizedText(value).toLowerCase();
  if (!CHAIN_IDS[network]) {
    throw new Error(`Unsupported network: ${network}`);
  }
  return network;
}

function parseOpenAmount() {
  const openAmountText = normalizedText(elements.openAmount.value);
  if (!/^\d+$/.test(openAmountText) || BigInt(openAmountText) <= 0n) {
    throw new Error("Open Pipe Amount must be a positive integer");
  }
  return BigInt(openAmountText);
}

function loadStoredOpenAmount() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.openAmount === "string" && /^\d+$/.test(parsed.openAmount)) {
        elements.openAmount.value = parsed.openAmount;
      }
    }
  } catch {
    // ignore malformed storage
  }
}

function persistOpenAmount() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      openAmount: normalizedText(elements.openAmount.value),
    }),
  );
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
  return compareBytes(aBytes, bBytes) <= 0
    ? { principal1: a, principal2: b }
    : { principal1: b, principal2: a };
}

function makeStxPostConditionForTransfer(principal, amount) {
  return Pc.principal(principal).willSendEq(amount).ustx();
}

function extractAddress(response) {
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

function toBase64UrlJson(value) {
  const utf8 = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function parseJsonResponse(response) {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { body: null, rawText };
  }
  try {
    return { body: JSON.parse(rawText), rawText };
  } catch {
    return { body: null, rawText };
  }
}

function describeFailure(status, payload, rawText, fallback) {
  if (payload && typeof payload.error === "string") {
    return `${payload.error}${payload.reason ? ` (${payload.reason})` : ""}`;
  }
  if (rawText && rawText.trim()) {
    return rawText.slice(0, 300);
  }
  return `${fallback} (status ${status})`;
}

function updateDialogMessage(text) {
  elements.challengeText.textContent = text;
}

function setDialogActions({ allowOpenPipe, allowPay }) {
  elements.openPipe.disabled = !allowOpenPipe;
  elements.payWallet.disabled = !allowPay;
}

async function withPaywallDialogSuspended(work) {
  const wasOpen = elements.paywallDialog.open;
  if (wasOpen) {
    elements.paywallDialog.close("wallet-ui");
  }
  try {
    return await work();
  } finally {
    if (wasOpen && state.lastPaymentChallenge) {
      elements.paywallDialog.showModal();
      await updatePaywallReadiness();
    }
  }
}

function renderConnectedState() {
  if (state.connectedAddress) {
    setWalletStatus(`Connected: ${state.connectedAddress}`);
    elements.connectWallet.textContent = "Reconnect Wallet";
  } else {
    setWalletStatus("Wallet not connected");
    elements.connectWallet.textContent = "Connect Wallet";
  }
}

function renderConfigState() {
  elements.configNetwork.textContent = state.config.network || "-";
  elements.configContract.textContent = state.config.contractId || "-";
  elements.configObserver.textContent = state.config.stacksNodeEventsObserver || "-";
}

async function resolveConnectedAddress(connectResponse = null) {
  const initialAddress = extractAddress(connectResponse);
  if (initialAddress) {
    return initialAddress;
  }
  const response = await request("getAddresses");
  const address = extractAddress(response);
  if (!address) {
    throw new Error("Wallet connected, but no valid STX address was found");
  }
  return address;
}

async function ensureConnectedWallet({ interactive }) {
  if (state.connectedAddress) {
    return state.connectedAddress;
  }

  let connected = false;
  try {
    connected = await Promise.resolve(isConnected());
  } catch {
    connected = false;
  }
  if (connected) {
    const address = await resolveConnectedAddress(null);
    state.connectedAddress = address;
    renderConnectedState();
    return address;
  }

  if (!interactive) {
    return null;
  }

  const response = await withPaywallDialogSuspended(() => connect());
  const address = await resolveConnectedAddress(response);
  state.connectedAddress = address;
  renderConnectedState();
  return address;
}

async function fetchDemoConfig() {
  const response = await fetch("/demo/config");
  const { body, rawText } = await parseJsonResponse(response);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(describeFailure(response.status, body, rawText, "Failed to load demo config"));
  }

  const network = parseNetwork(body.network);
  const contractId = parseContractId(body.contractId);
  const counterpartyPrincipal = normalizedText(body.counterpartyPrincipal);
  if (!isStacksAddress(counterpartyPrincipal)) {
    throw new Error("Demo config did not include a valid counterparty principal");
  }

  state.config.network = network;
  state.config.contractId = contractId;
  state.config.counterpartyPrincipal = counterpartyPrincipal;
  state.config.priceAmount = normalizedText(body.priceAmount);
  state.config.priceAsset = normalizedText(body.priceAsset);
  state.config.openPipeAmount = /^\d+$/.test(normalizedText(body.openPipeAmount))
    ? normalizedText(body.openPipeAmount)
    : "1000";
  state.config.stacksNodeEventsObserver = normalizedText(body.stacksNodeEventsObserver);

  if (!normalizedText(elements.openAmount.value)) {
    elements.openAmount.value = state.config.openPipeAmount;
  }

  renderConfigState();
}

async function fetchPipeStatus() {
  if (!state.connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const response = await fetch("/demo/pipe-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principal: state.connectedAddress }),
  });

  const { body, rawText } = await parseJsonResponse(response);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(describeFailure(response.status, body, rawText, "Failed to fetch pipe status"));
  }

  return {
    hasPipe: Boolean(body.hasPipe),
    canPay: Boolean(body.canPay),
    myConfirmed: normalizedText(body.myConfirmed || "0"),
    myPending: normalizedText(body.myPending || "0"),
    theirConfirmed: normalizedText(body.theirConfirmed || "0"),
    theirPending: normalizedText(body.theirPending || "0"),
    nonce: normalizedText(body.nonce || "0"),
    source: normalizedText(body.source || ""),
  };
}

async function updatePaywallReadiness() {
  if (!state.lastPaymentChallenge) {
    return;
  }

  if (!state.connectedAddress) {
    updateDialogMessage("Connect wallet, then check pipe status. If no pipe exists, open one first.");
    setDialogActions({ allowOpenPipe: true, allowPay: true });
    return;
  }

  if (!state.config.counterpartyPrincipal) {
    updateDialogMessage("Counterparty principal is not available from the demo server.");
    setDialogActions({ allowOpenPipe: false, allowPay: false });
    return;
  }

  try {
    const pipe = await fetchPipeStatus();
    if (!pipe.hasPipe) {
      updateDialogMessage(
        "No open pipe found in stackflow-node for this account/counterparty. Open a pipe first, then sign and pay.",
      );
      setDialogActions({ allowOpenPipe: true, allowPay: false });
      return;
    }

    if (pipe.canPay) {
      updateDialogMessage(
        `Pipe ready via stackflow-node (my confirmed=${pipe.myConfirmed}, pending=${pipe.myPending}, source=${pipe.source || "unknown"}). Sign and pay to continue.`,
      );
      setDialogActions({ allowOpenPipe: true, allowPay: true });
      return;
    }

    updateDialogMessage(
      `Pipe observed but not spendable yet (my confirmed=${pipe.myConfirmed}, pending=${pipe.myPending}). Wait for confirmation from stacks-node observer, then sign and pay.`,
    );
    setDialogActions({ allowOpenPipe: true, allowPay: false });
  } catch (error) {
    updateDialogMessage(
      `Unable to check stackflow-node pipe status: ${error instanceof Error ? error.message : String(error)}`,
    );
    setDialogActions({ allowOpenPipe: true, allowPay: false });
  }
}

function buildPaymentProofPayload(intent, signature) {
  return {
    ...intent,
    theirSignature: signature,
  };
}

function buildStructuredMessage(intent) {
  const pair = canonicalPrincipals(intent.forPrincipal, intent.withPrincipal);
  const balance1 =
    pair.principal1 === intent.forPrincipal
      ? BigInt(intent.myBalance)
      : BigInt(intent.theirBalance);
  const balance2 =
    pair.principal1 === intent.forPrincipal
      ? BigInt(intent.theirBalance)
      : BigInt(intent.myBalance);

  const domain = Cl.tuple({
    name: Cl.stringAscii(intent.contractId),
    version: Cl.stringAscii(STACKFLOW_MESSAGE_VERSION),
    "chain-id": Cl.uint(CHAIN_IDS[state.config.network] || CHAIN_IDS.testnet),
  });

  const message = Cl.tuple({
    token: Cl.none(),
    "principal-1": Cl.principal(pair.principal1),
    "principal-2": Cl.principal(pair.principal2),
    "balance-1": Cl.uint(balance1),
    "balance-2": Cl.uint(balance2),
    nonce: Cl.uint(BigInt(intent.nonce)),
    action: Cl.uint(BigInt(intent.action)),
    actor: Cl.principal(intent.actor),
    "hashed-secret": Cl.none(),
    "valid-after": Cl.none(),
  });

  return { domain, message };
}

async function createPaymentIntent() {
  const response = await fetch("/demo/payment-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      withPrincipal: state.connectedAddress,
    }),
  });

  const { body, rawText } = await parseJsonResponse(response);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(
      describeFailure(response.status, body, rawText, "Failed to create payment intent"),
    );
  }

  if (!body.intent || typeof body.intent !== "object") {
    throw new Error("Payment intent response missing intent");
  }

  return body.intent;
}

async function fetchPaywalledStory(paymentProof = null) {
  const headers = {};
  if (paymentProof) {
    headers["x-x402-payment"] = toBase64UrlJson(paymentProof);
  }

  const response = await fetch("/paywalled-story", {
    method: "GET",
    headers,
  });

  const { body, rawText } = await parseJsonResponse(response);

  if (response.status === 402) {
    state.lastPaymentChallenge = body && typeof body === "object" ? body : {};
    const payment = body && typeof body === "object" ? body.payment : null;
    const amount = payment && typeof payment === "object" ? payment.amount : "?";
    const asset = payment && typeof payment === "object" ? payment.asset : "?";
    log(`Received 402 challenge: ${amount} ${asset} required.`);
    setResponseOutput(body || rawText || "Payment required");
    elements.paywallDialog.showModal();
    await updatePaywallReadiness();
    return;
  }

  if (!response.ok) {
    const details = describeFailure(response.status, body, rawText, "Request failed");
    throw new Error(details);
  }

  state.lastPaymentChallenge = null;
  setResponseOutput(body || rawText || "OK");
  log("Unlocked paywalled content.");
}

async function onConnectWallet() {
  try {
    await ensureConnectedWallet({ interactive: true });
    log(`Wallet connected: ${state.connectedAddress}`);
    await updatePaywallReadiness();
  } catch (error) {
    setWalletStatus(
      error instanceof Error ? error.message : "wallet connection failed",
      { error: true },
    );
    log(
      `Wallet connection failed: ${error instanceof Error ? error.message : String(error)}`,
      { error: true },
    );
  }
}

async function onOpenPipe() {
  try {
    await ensureConnectedWallet({ interactive: true });
    if (!state.config.counterpartyPrincipal) {
      throw new Error("counterparty principal unavailable");
    }

    const openAmount = parseOpenAmount();
    const pipeStatus = await fetchPipeStatus();
    const nonce = /^\d+$/.test(pipeStatus.nonce) ? BigInt(pipeStatus.nonce) : 0n;

    const response = await withPaywallDialogSuspended(() =>
      request("stx_callContract", {
        contract: state.config.contractId,
        functionName: "fund-pipe",
        functionArgs: [
          Cl.none(),
          Cl.uint(openAmount),
          Cl.principal(state.config.counterpartyPrincipal),
          Cl.uint(nonce),
        ],
        postConditions: [
          makeStxPostConditionForTransfer(state.connectedAddress, openAmount),
        ],
        postConditionMode: "deny",
        network: state.config.network,
      }),
    );

    const txid = extractTxid(response);
    log(
      txid
        ? `fund-pipe submitted: ${txid}`
        : "fund-pipe submitted (wallet response received).",
    );
    updateDialogMessage(
      "fund-pipe submitted. Waiting for stacks-node observer events to reach stackflow-node...",
    );
    setDialogActions({ allowOpenPipe: true, allowPay: false });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const nextStatus = await fetchPipeStatus();
      if (nextStatus.canPay) {
        log("Spendable pipe detected via stackflow-node observer state.");
        await updatePaywallReadiness();
        return;
      }
    }

    log(
      "Pipe is still not spendable in stackflow-node. Verify stacks-node observer config and wait for confirmations.",
      { error: true },
    );
    await updatePaywallReadiness();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Open pipe failed: ${message}`, { error: true });
    updateDialogMessage(`Open pipe failed: ${message}`);
  }
}

async function onSignAndPay() {
  try {
    await ensureConnectedWallet({ interactive: true });

    const pipe = await fetchPipeStatus();
    if (!pipe.hasPipe || !pipe.canPay) {
      updateDialogMessage(
        "Pipe is not spendable in stackflow-node yet. Open a pipe and wait for observer confirmation before signing.",
      );
      setDialogActions({ allowOpenPipe: true, allowPay: false });
      return;
    }

    const intent = await createPaymentIntent();
    const statePayload = buildStructuredMessage(intent);
    const signResponse = await withPaywallDialogSuspended(() =>
      request("stx_signStructuredMessage", {
        domain: statePayload.domain,
        message: statePayload.message,
      }),
    );

    const signature = extractSignature(signResponse);
    if (!signature) {
      throw new Error("Wallet did not return a signature");
    }

    const proof = buildPaymentProofPayload(intent, signature);
    await fetchPaywalledStory(proof);
    if (elements.paywallDialog.open) {
      elements.paywallDialog.close("paid");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Sign and pay failed: ${message}`, { error: true });
    updateDialogMessage(`Sign and pay failed: ${message}`);
  }
}

async function onPremiumLinkClick(event) {
  event.preventDefault();
  try {
    setResponseOutput("Requesting protected resource...");
    await fetchPaywalledStory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setResponseOutput(`Error: ${message}`);
    log(`Failed to fetch paywalled story: ${message}`, { error: true });
  }
}

function wireEvents() {
  elements.premiumLink.addEventListener("click", onPremiumLinkClick);
  elements.connectWallet.addEventListener("click", onConnectWallet);
  elements.openPipe.addEventListener("click", onOpenPipe);
  elements.payWallet.addEventListener("click", onSignAndPay);
  elements.openAmount.addEventListener("change", () => {
    persistOpenAmount();
  });
}

async function bootstrap() {
  wireEvents();
  loadStoredOpenAmount();

  try {
    await fetchDemoConfig();
    if (!normalizedText(elements.openAmount.value)) {
      elements.openAmount.value = state.config.openPipeAmount;
    }
    persistOpenAmount();
    log(
      `Demo config loaded: network=${state.config.network} contract=${state.config.contractId}`,
    );
  } catch (error) {
    log(
      `Failed to load demo config: ${error instanceof Error ? error.message : String(error)}`,
      { error: true },
    );
  }

  try {
    await ensureConnectedWallet({ interactive: false });
  } catch (error) {
    log(
      `Wallet session restore failed: ${error instanceof Error ? error.message : String(error)}`,
      { error: true },
    );
  }

  renderConnectedState();
  setDialogActions({ allowOpenPipe: true, allowPay: false });
  updateDialogMessage("Click the premium link to trigger the x402 challenge.");

  log("Ready.");
}

bootstrap().catch((error) => {
  log(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}`, {
    error: true,
  });
});
