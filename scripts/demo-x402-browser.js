import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const STACKFLOW_ENTRY = path.join(ROOT, "server", "dist", "index.js");
const GATEWAY_ENTRY = path.join(ROOT, "server", "dist", "x402-gateway.js");
const WEB_ROOT = path.join(ROOT, "demo", "x402-browser");
const DEFAULT_CONFIG_PATH = path.join(WEB_ROOT, "config.json");
const DEFAULT_DEVNET_DISPUTE_SIGNER_KEY =
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801";

function buildRandomCounterpartyKey() {
  // 32-byte secp256k1 private key + compressed-pubkey marker (01), matching
  // the format used by STACKFLOW_NODE_COUNTERPARTY_KEY in this repo.
  return `0x${randomBytes(32).toString("hex")}01`;
}

function selectDisputeSignerKey({ network, counterpartySignerKey }) {
  const explicit = process.env.DEMO_X402_DISPUTE_SIGNER_KEY?.trim();
  if (explicit) {
    return {
      disputeSignerKey: explicit,
      source: "env",
    };
  }
  if (network === "devnet") {
    return {
      disputeSignerKey: DEFAULT_DEVNET_DISPUTE_SIGNER_KEY,
      source: "clarinet-devnet-default",
    };
  }
  return {
    disputeSignerKey: counterpartySignerKey,
    source: "counterparty-fallback",
  };
}

function cleanupDbFiles(dbFile) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbFile}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStacksPrincipal(value) {
  return typeof value === "string" && /^S[PMT][A-Z0-9]{38,42}$/i.test(value);
}

function isContractId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [address, name] = parts;
  return isStacksPrincipal(address) && /^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(name);
}

function parseUintString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${fieldName} must be an unsigned integer string`);
  }
  return text;
}

function parseHost(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty host`);
  }
  return text;
}

function parsePort(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parseNetwork(value) {
  const network = String(value ?? "").trim().toLowerCase();
  if (network === "devnet" || network === "testnet" || network === "mainnet") {
    return network;
  }
  throw new Error("stacksNetwork must be one of devnet, testnet, mainnet");
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseCsv(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalHttpUrl(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http/https`);
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function parseObserverAddress(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("stacksNodeEventsObserver must be formatted as host:port");
  }
  const parts = text.split(":");
  if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) {
    throw new Error("stacksNodeEventsObserver must be formatted as host:port");
  }
  const port = Number.parseInt(parts[1], 10);
  if (port < 1 || port > 65535) {
    throw new Error("stacksNodeEventsObserver port must be between 1 and 65535");
  }
  return text;
}

function parseAssetName(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 20) {
    throw new Error("priceAsset must be a short non-empty string");
  }
  return text;
}

function loadDemoConfig() {
  const configPath = process.env.DEMO_X402_CONFIG_FILE?.trim() || DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse demo config JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`demo config at ${configPath} must be a JSON object`);
  }

  const config = {
    configPath,
    stacksNetwork: parseNetwork(parsed.stacksNetwork),
    stacksApiUrl: parseOptionalHttpUrl(parsed.stacksApiUrl, "stacksApiUrl"),
    contractId: String(parsed.contractId || "").trim(),
    priceAmount: parseUintString(parsed.priceAmount, "priceAmount"),
    priceAsset: parseAssetName(parsed.priceAsset),
    openPipeAmount: parseUintString(parsed.openPipeAmount, "openPipeAmount"),
    stackflowNodeHost: parseHost(parsed.stackflowNodeHost, "stackflowNodeHost"),
    stackflowNodePort: parsePort(parsed.stackflowNodePort, "stackflowNodePort"),
    stacksNodeEventsObserver: parseObserverAddress(parsed.stacksNodeEventsObserver),
    observerLocalhostOnly: parseBoolean(parsed.observerLocalhostOnly, true),
    observerAllowedIps: parseCsv(parsed.observerAllowedIps),
  };

  if (!isContractId(config.contractId)) {
    throw new Error("contractId must be a valid contract principal");
  }

  return config;
}

function extractCounterpartyPrincipal(healthBody) {
  if (!isRecord(healthBody)) {
    return null;
  }
  return typeof healthBody.counterpartyPrincipal === "string"
    ? healthBody.counterpartyPrincipal
    : null;
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function text(response, statusCode, body, contentType) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(body);
}

function parseUnsignedBigInt(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function selectBestPipeFromNode({
  pipes,
  principal,
  counterpartyPrincipal,
  contractId,
}) {
  if (!Array.isArray(pipes)) {
    return null;
  }

  let best = null;
  let bestNonce = -1n;
  let bestUpdatedAt = "";

  for (const candidate of pipes) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (candidate.contractId !== contractId) {
      continue;
    }

    const pipeKey = isRecord(candidate.pipeKey) ? candidate.pipeKey : null;
    if (!pipeKey) {
      continue;
    }

    const principal1 = typeof pipeKey["principal-1"] === "string" ? pipeKey["principal-1"] : null;
    const principal2 = typeof pipeKey["principal-2"] === "string" ? pipeKey["principal-2"] : null;
    if (!principal1 || !principal2) {
      continue;
    }

    const samePair =
      (principal1 === principal && principal2 === counterpartyPrincipal) ||
      (principal1 === counterpartyPrincipal && principal2 === principal);
    if (!samePair) {
      continue;
    }

    const nonce = parseUnsignedBigInt(typeof candidate.nonce === "string" ? candidate.nonce : "0") ?? 0n;
    const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : "";

    if (!best || nonce > bestNonce || (nonce === bestNonce && updatedAt > bestUpdatedAt)) {
      best = candidate;
      bestNonce = nonce;
      bestUpdatedAt = updatedAt;
    }
  }

  if (!best) {
    return null;
  }

  const pipeKey = best.pipeKey;
  const principal1 = String(pipeKey["principal-1"]);
  const useBalance1 = principal1 === principal;

  const balance1 = parseUnsignedBigInt(String(best.balance1 ?? "0")) ?? 0n;
  const balance2 = parseUnsignedBigInt(String(best.balance2 ?? "0")) ?? 0n;
  const pending1 = parseUnsignedBigInt(String(best.pending1Amount ?? "0")) ?? 0n;
  const pending2 = parseUnsignedBigInt(String(best.pending2Amount ?? "0")) ?? 0n;

  const myConfirmed = useBalance1 ? balance1 : balance2;
  const myPending = useBalance1 ? pending1 : pending2;
  const theirConfirmed = useBalance1 ? balance2 : balance1;
  const theirPending = useBalance1 ? pending2 : pending1;

  return {
    hasPipe: true,
    canPay: myConfirmed > 0n,
    myConfirmed,
    myPending,
    theirConfirmed,
    theirPending,
    nonce: parseUnsignedBigInt(String(best.nonce ?? "0")) ?? 0n,
    source: typeof best.source === "string" ? best.source : null,
    event: typeof best.event === "string" ? best.event : null,
    updatedAt: typeof best.updatedAt === "string" ? best.updatedAt : null,
    principal1,
    principal2: String(pipeKey["principal-2"]),
    balance1,
    balance2,
  };
}

function toPipeStatusJson(pipe) {
  if (!pipe) {
    return {
      hasPipe: false,
      canPay: false,
      myConfirmed: "0",
      myPending: "0",
      theirConfirmed: "0",
      theirPending: "0",
      nonce: "0",
      source: null,
      event: null,
      updatedAt: null,
    };
  }

  return {
    hasPipe: pipe.hasPipe,
    canPay: pipe.canPay,
    myConfirmed: pipe.myConfirmed.toString(10),
    myPending: pipe.myPending.toString(10),
    theirConfirmed: pipe.theirConfirmed.toString(10),
    theirPending: pipe.theirPending.toString(10),
    nonce: pipe.nonce.toString(10),
    source: pipe.source,
    event: pipe.event,
    updatedAt: pipe.updatedAt,
  };
}

async function waitForHealth(baseUrl, label, child, logsRef) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before health check.\n${logsRef.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} health timeout.\n${logsRef.join("")}`);
}

async function startChildProcess({ label, entry, env, baseUrl, streamLogs = true }) {
  const logsRef = [];
  const child = spawn("node", [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logsRef.push(text);
    if (streamLogs) {
      process.stdout.write(`[${label}] ${text}`);
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logsRef.push(text);
    if (streamLogs) {
      process.stderr.write(`[${label}] ${text}`);
    }
  });

  await waitForHealth(baseUrl, label, child, logsRef);

  return {
    logs: logsRef,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

function loadWebAssets() {
  return {
    indexHtml: fs.readFileSync(path.join(WEB_ROOT, "index.html"), "utf8"),
    appJs: fs.readFileSync(path.join(WEB_ROOT, "app.js"), "utf8"),
    stylesCss: fs.readFileSync(path.join(WEB_ROOT, "styles.css"), "utf8"),
  };
}

function createDemoSiteServer({
  port,
  stackflowBaseUrl,
  counterpartyPrincipal,
  demoConfig,
}) {
  const assets = loadWebAssets();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          ok: true,
          service: "x402-browser-demo-site",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        text(response, 200, assets.indexHtml, "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/app.js") {
        text(response, 200, assets.appJs, "application/javascript; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/styles.css") {
        text(response, 200, assets.stylesCss, "text/css; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/demo/config") {
        json(response, 200, {
          ok: true,
          network: demoConfig.stacksNetwork,
          contractId: demoConfig.contractId,
          counterpartyPrincipal,
          priceAmount: demoConfig.priceAmount,
          priceAsset: demoConfig.priceAsset,
          openPipeAmount: demoConfig.openPipeAmount,
          stacksNodeEventsObserver: demoConfig.stacksNodeEventsObserver,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/demo/pipe-status") {
        const body = await parseJsonBody(request);
        const principal = isRecord(body) ? String(body.principal || "").trim() : "";
        if (!isStacksPrincipal(principal)) {
          json(response, 400, {
            ok: false,
            error: "principal must be a valid STX address",
          });
          return;
        }

        const pipesResponse = await fetch(
          `${stackflowBaseUrl}/pipes?principal=${encodeURIComponent(principal)}&limit=200`,
        );
        const pipesBody = await pipesResponse.json().catch(() => null);

        if (pipesResponse.status !== 200 || !isRecord(pipesBody)) {
          json(response, 502, {
            ok: false,
            error: "failed to query stackflow-node pipes",
          });
          return;
        }

        const selectedPipe = selectBestPipeFromNode({
          pipes: pipesBody.pipes,
          principal,
          counterpartyPrincipal,
          contractId: demoConfig.contractId,
        });

        json(response, 200, {
          ok: true,
          principal,
          counterpartyPrincipal,
          contractId: demoConfig.contractId,
          ...toPipeStatusJson(selectedPipe),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/paywalled-story") {
        json(response, 200, {
          ok: true,
          title: "The Paywalled Story",
          body: "You unlocked this page via x402 payment flow.",
          verifiedByGateway: request.headers["x-stackflow-x402-verified"] === "true",
          proofHash:
            typeof request.headers["x-stackflow-x402-proof-hash"] === "string"
              ? request.headers["x-stackflow-x402-proof-hash"]
              : null,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/demo/payment-intent") {
        const body = await parseJsonBody(request);
        const withPrincipal = isRecord(body) ? String(body.withPrincipal || "").trim() : "";

        if (!isStacksPrincipal(withPrincipal)) {
          json(response, 400, {
            ok: false,
            error: "withPrincipal must be a valid STX address",
          });
          return;
        }

        if (withPrincipal === counterpartyPrincipal) {
          json(response, 409, {
            ok: false,
            error:
              "connected wallet matches the server counterparty principal; use a different wallet account",
            reason: "payer-matches-counterparty",
          });
          return;
        }

        const pipesResponse = await fetch(
          `${stackflowBaseUrl}/pipes?principal=${encodeURIComponent(withPrincipal)}&limit=200`,
        );
        const pipesBody = await pipesResponse.json().catch(() => null);
        if (pipesResponse.status !== 200 || !isRecord(pipesBody)) {
          json(response, 502, {
            ok: false,
            error: "failed to query stackflow-node pipes",
            reason: "pipes-query-failed",
          });
          return;
        }

        const pipe = selectBestPipeFromNode({
          pipes: pipesBody.pipes,
          principal: withPrincipal,
          counterpartyPrincipal,
          contractId: demoConfig.contractId,
        });
        if (!pipe || !pipe.hasPipe) {
          json(response, 409, {
            ok: false,
            error: "no pipe found between connected wallet and counterparty",
            reason: "pipe-not-found",
          });
          return;
        }
        if (!pipe.canPay) {
          json(response, 409, {
            ok: false,
            error: "pipe exists but payer has no confirmed balance available yet",
            reason: "pipe-not-ready",
            myConfirmed: pipe.myConfirmed.toString(10),
            myPending: pipe.myPending.toString(10),
          });
          return;
        }

        const priceAmount = BigInt(demoConfig.priceAmount);
        if (pipe.myConfirmed < priceAmount) {
          json(response, 409, {
            ok: false,
            error: "insufficient confirmed pipe balance for payment",
            reason: "insufficient-pipe-balance",
            payerBalance: pipe.myConfirmed.toString(10),
            requiredAmount: priceAmount.toString(10),
          });
          return;
        }

        const counterpartyBalance = pipe.principal1 === counterpartyPrincipal
          ? pipe.balance1
          : pipe.balance2;
        const totalBalance = pipe.balance1 + pipe.balance2;
        const nextNonce = pipe.nonce + 1n;
        const nextMyBalance = counterpartyBalance + priceAmount;
        const nextTheirBalance = totalBalance - nextMyBalance;

        json(response, 200, {
          ok: true,
          intent: {
            contractId: demoConfig.contractId,
            forPrincipal: counterpartyPrincipal,
            withPrincipal,
            token: null,
            amount: priceAmount.toString(10),
            myBalance: nextMyBalance.toString(10),
            theirBalance: nextTheirBalance.toString(10),
            nonce: nextNonce.toString(10),
            action: "1",
            actor: withPrincipal,
            hashedSecret: null,
            validAfter: null,
            beneficialOnly: false,
          },
        });
        return;
      }

      json(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      json(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "internal server error",
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: async () => {
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          });
        },
      });
    });
    server.on("error", reject);
  });
}

async function getStackflowRuntimeInfo(stackflowBaseUrl) {
  const response = await fetch(`${stackflowBaseUrl}/health`);
  if (response.status !== 200) {
    throw new Error(`stackflow health failed with status ${response.status}`);
  }
  const body = await response.json();
  const principal = extractCounterpartyPrincipal(body);
  if (!principal) {
    throw new Error("stackflow did not report counterpartyPrincipal");
  }
  const disputeEnabled = isRecord(body) ? body.disputeEnabled === true : false;
  const signerAddress =
    isRecord(body) && typeof body.signerAddress === "string" ? body.signerAddress : null;
  return {
    counterpartyPrincipal: principal,
    disputeEnabled,
    signerAddress,
  };
}

function healthHostForBindHost(host) {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  return host;
}

async function main() {
  const demoConfig = loadDemoConfig();
  const streamChildLogs = parseBoolean(process.env.DEMO_X402_SHOW_CHILD_LOGS, true);

  console.log("[browser-demo] config loaded");
  console.log(`[browser-demo] config file: ${demoConfig.configPath}`);
  console.log(`[browser-demo] network=${demoConfig.stacksNetwork} contract=${demoConfig.contractId}`);
  console.log(
    `[browser-demo] stacks-node observer target: ${demoConfig.stacksNodeEventsObserver}`,
  );
  console.log(
    `[browser-demo] stacks-node config: stacks_node_events_observers = [\"${demoConfig.stacksNodeEventsObserver}\"]`,
  );

  console.log("[browser-demo] building stackflow-node artifacts...");
  execFileSync("npm", ["run", "-s", "build:stackflow-node"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const stackflowHost = demoConfig.stackflowNodeHost;
  const stackflowPort = demoConfig.stackflowNodePort;
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const counterpartySignerKey =
    process.env.DEMO_X402_COUNTERPARTY_KEY?.trim() || buildRandomCounterpartyKey();
  const disputeSigner = selectDisputeSignerKey({
    network: demoConfig.stacksNetwork,
    counterpartySignerKey,
  });
  const disputeSignerKey = disputeSigner.disputeSignerKey;
  const dbFile = path.join(
    os.tmpdir(),
    `stackflow-x402-browser-demo-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );

  const stackflowBaseUrl = `http://${healthHostForBindHost(stackflowHost)}:${stackflowPort}`;
  const stackflowEnv = {
    STACKFLOW_NODE_HOST: stackflowHost,
    STACKFLOW_NODE_PORT: String(stackflowPort),
    STACKFLOW_NODE_DB_FILE: dbFile,
    STACKFLOW_CONTRACTS: demoConfig.contractId,
    STACKS_NETWORK: demoConfig.stacksNetwork,
    STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: "accept-all",
    STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: "auto",
    STACKFLOW_NODE_DISPUTE_SIGNER_KEY: disputeSignerKey,
    STACKFLOW_NODE_COUNTERPARTY_KEY: counterpartySignerKey,
    STACKFLOW_NODE_FORWARDING_ENABLED: "false",
    STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY: demoConfig.observerLocalhostOnly
      ? "true"
      : "false",
  };
  if (demoConfig.observerAllowedIps.length > 0) {
    stackflowEnv.STACKFLOW_NODE_OBSERVER_ALLOWED_IPS = demoConfig.observerAllowedIps.join(",");
  }
  if (demoConfig.stacksApiUrl) {
    stackflowEnv.STACKS_API_URL = demoConfig.stacksApiUrl;
  }

  const stackflow = await startChildProcess({
    label: "stackflow-node",
    entry: STACKFLOW_ENTRY,
    baseUrl: stackflowBaseUrl,
    env: stackflowEnv,
    streamLogs: streamChildLogs,
  });

  let site = null;
  let gateway = null;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("\n[browser-demo] shutting down...");
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
    if (site) {
      await site.stop().catch(() => {});
    }
    await stackflow.stop().catch(() => {});
    cleanupDbFiles(dbFile);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const runtimeInfo = await getStackflowRuntimeInfo(stackflowBaseUrl);
    const counterpartyPrincipal = runtimeInfo.counterpartyPrincipal;
    console.log(`[browser-demo] counterparty principal: ${counterpartyPrincipal}`);
    console.log(
      `[browser-demo] disputes enabled: ${runtimeInfo.disputeEnabled} signer=${runtimeInfo.signerAddress || "-"}`,
    );
    console.log(`[browser-demo] dispute signer source: ${disputeSigner.source}`);
    console.log(
      "[browser-demo] note: pipe state is read only from observer-fed stackflow-node /pipes",
    );

    site = await createDemoSiteServer({
      port: upstreamPort,
      stackflowBaseUrl,
      counterpartyPrincipal,
      demoConfig,
    });

    const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
    gateway = await startChildProcess({
      label: "x402-gateway",
      entry: GATEWAY_ENTRY,
      baseUrl: gatewayBaseUrl,
      streamLogs: streamChildLogs,
      env: {
        STACKFLOW_X402_GATEWAY_HOST: "127.0.0.1",
        STACKFLOW_X402_GATEWAY_PORT: String(gatewayPort),
        STACKFLOW_X402_UPSTREAM_BASE_URL: site.baseUrl,
        STACKFLOW_X402_STACKFLOW_NODE_BASE_URL: stackflowBaseUrl,
        STACKFLOW_X402_PROTECTED_PATH: "/paywalled-story",
        STACKFLOW_X402_PRICE_AMOUNT: demoConfig.priceAmount,
        STACKFLOW_X402_PRICE_ASSET: demoConfig.priceAsset,
      },
    });

    console.log("[browser-demo] ready");
    console.log(`[browser-demo] open in browser: ${gatewayBaseUrl}/`);
    console.log("[browser-demo] click \"Read premium story\" to trigger the 402 flow");
    console.log("[browser-demo] press Ctrl+C to stop");
  } catch (error) {
    console.error(
      `[browser-demo] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await shutdown();
  }
}

main().catch((error) => {
  console.error(
    `[browser-demo] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
