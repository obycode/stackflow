import path from 'node:path';

import { parsePrincipal } from './principal-utils.js';
import type {
  DisputeExecutorMode,
  CounterpartySignerMode,
  SignatureVerifierMode,
  StackflowNodeConfig,
} from './types.js';
import process from 'node:process';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_RECENT_EVENTS = 500;
const DEFAULT_PEER_WRITE_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_TRUST_PROXY = false;
const DEFAULT_OBSERVER_LOCALHOST_ONLY = true;
const DEFAULT_ADMIN_READ_LOCALHOST_ONLY = true;
const DEFAULT_REDACT_SENSITIVE_READ_DATA = true;
const DEFAULT_FORWARDING_TIMEOUT_MS = 10_000;
const DEFAULT_FORWARDING_REVEAL_RETRY_INTERVAL_MS = 15_000;
const DEFAULT_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS = 20;
const MAX_WATCHED_PRINCIPALS = 100;
const DEFAULT_DB_FILE = path.resolve(
  process.cwd(),
  'server/data/stackflow-node-state.db',
);

function parseInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePort(value: unknown): number {
  const parsed = parseInteger(value, DEFAULT_PORT);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('STACKFLOW_NODE_PORT must be an integer between 1 and 65535');
  }
  return parsed;
}

function parseMaxRecentEvents(value: unknown): number {
  return Math.max(1, parseInteger(value, DEFAULT_MAX_RECENT_EVENTS));
}

function parseCsv(value: unknown): string[] {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePrincipalCsv(value: unknown): string[] {
  const principals = parseCsv(value).map((principal) =>
    parsePrincipal(principal, 'STACKFLOW_NODE_PRINCIPALS'),
  );

  if (principals.length > MAX_WATCHED_PRINCIPALS) {
    throw new Error(
      `STACKFLOW_NODE_PRINCIPALS exceeds max of ${MAX_WATCHED_PRINCIPALS} entries`,
    );
  }

  return [...new Set(principals)];
}

function parseBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`${key} must be a boolean (true/false, 1/0, yes/no, on/off)`);
}

function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`invalid forwarding base url: ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`forwarding base url must use http/https: ${input}`);
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function parseNetwork(value: unknown): 'mainnet' | 'testnet' | 'devnet' | 'mocknet' {
  const normalized = String(value || 'devnet').trim().toLowerCase();
  if (normalized === 'mainnet' || normalized === 'testnet' || normalized === 'mocknet') {
    return normalized;
  }
  return 'devnet';
}

function parseSignatureVerifierMode(value: unknown): SignatureVerifierMode {
  const normalized = String(value || 'readonly').trim().toLowerCase();
  if (
    normalized === 'readonly' ||
    normalized === 'accept-all' ||
    normalized === 'reject-all'
  ) {
    return normalized;
  }

  throw new Error(
    'STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE must be readonly, accept-all, or reject-all',
  );
}

function parseDisputeExecutorMode(value: unknown): DisputeExecutorMode {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'noop' || normalized === 'mock') {
    return normalized;
  }

  throw new Error(
    'STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE must be auto, noop, or mock',
  );
}

function parseCounterpartySignerMode(value: unknown): CounterpartySignerMode {
  const normalized = String(value || 'local-key').trim().toLowerCase();
  if (normalized === 'local-key' || normalized === 'kms') {
    return normalized;
  }

  throw new Error(
    'STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE must be local-key or kms',
  );
}

function parseStackflowMessageVersion(value: unknown): string {
  const text = String(value || '0.6.0').trim();
  if (text.length === 0) {
    throw new Error('STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION must not be empty');
  }
  if (!/^[\x20-\x7E]+$/.test(text)) {
    throw new Error('STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION must be ASCII');
  }
  return text;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StackflowNodeConfig {
  const dbFile = env.STACKFLOW_NODE_DB_FILE?.trim() || DEFAULT_DB_FILE;
  const disputeSignerKey = env.STACKFLOW_NODE_DISPUTE_SIGNER_KEY?.trim() || null;

  return {
    host: env.STACKFLOW_NODE_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.STACKFLOW_NODE_PORT),
    dbFile,
    maxRecentEvents: parseMaxRecentEvents(env.STACKFLOW_NODE_MAX_RECENT_EVENTS),
    logRawEvents: parseBoolean(
      env.STACKFLOW_NODE_LOG_RAW_EVENTS,
      false,
      'STACKFLOW_NODE_LOG_RAW_EVENTS',
    ),
    watchedContracts: parseCsv(env.STACKFLOW_CONTRACTS),
    watchedPrincipals: parsePrincipalCsv(env.STACKFLOW_NODE_PRINCIPALS),
    stacksNetwork: parseNetwork(env.STACKS_NETWORK),
    stacksApiUrl: env.STACKS_API_URL?.trim() || null,
    disputeSignerKey,
    counterpartyKey:
      env.STACKFLOW_NODE_COUNTERPARTY_KEY?.trim() ||
      disputeSignerKey ||
      null,
    counterpartyPrincipal: env.STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL?.trim() || null,
    counterpartySignerMode: parseCounterpartySignerMode(
      env.STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE,
    ),
    counterpartyKmsKeyId:
      env.STACKFLOW_NODE_COUNTERPARTY_KMS_KEY_ID?.trim() ||
      env.KMS_KEY_ID?.trim() ||
      null,
    counterpartyKmsRegion:
      env.STACKFLOW_NODE_COUNTERPARTY_KMS_REGION?.trim() ||
      env.AWS_REGION?.trim() ||
      null,
    counterpartyKmsEndpoint: env.STACKFLOW_NODE_COUNTERPARTY_KMS_ENDPOINT?.trim() || null,
    stackflowMessageVersion: parseStackflowMessageVersion(
      env.STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION,
    ),
    signatureVerifierMode: parseSignatureVerifierMode(
      env.STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE,
    ),
    disputeExecutorMode: parseDisputeExecutorMode(
      env.STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE,
    ),
    disputeOnlyBeneficial: parseBoolean(
      env.STACKFLOW_NODE_DISPUTE_ONLY_BENEFICIAL,
      false,
      'STACKFLOW_NODE_DISPUTE_ONLY_BENEFICIAL',
    ),
    peerWriteRateLimitPerMinute: Math.max(
      0,
      parseInteger(
        env.STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE,
        DEFAULT_PEER_WRITE_RATE_LIMIT_PER_MINUTE,
      ),
    ),
    trustProxy: parseBoolean(
      env.STACKFLOW_NODE_TRUST_PROXY,
      DEFAULT_TRUST_PROXY,
      'STACKFLOW_NODE_TRUST_PROXY',
    ),
    observerLocalhostOnly: parseBoolean(
      env.STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY,
      DEFAULT_OBSERVER_LOCALHOST_ONLY,
      'STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY',
    ),
    observerAllowedIps: parseCsv(env.STACKFLOW_NODE_OBSERVER_ALLOWED_IPS),
    adminReadToken: env.STACKFLOW_NODE_ADMIN_READ_TOKEN?.trim() || null,
    adminReadLocalhostOnly: parseBoolean(
      env.STACKFLOW_NODE_ADMIN_READ_LOCALHOST_ONLY,
      DEFAULT_ADMIN_READ_LOCALHOST_ONLY,
      'STACKFLOW_NODE_ADMIN_READ_LOCALHOST_ONLY',
    ),
    redactSensitiveReadData: parseBoolean(
      env.STACKFLOW_NODE_REDACT_SENSITIVE_READ_DATA,
      DEFAULT_REDACT_SENSITIVE_READ_DATA,
      'STACKFLOW_NODE_REDACT_SENSITIVE_READ_DATA',
    ),
    forwardingEnabled: parseBoolean(
      env.STACKFLOW_NODE_FORWARDING_ENABLED,
      false,
      'STACKFLOW_NODE_FORWARDING_ENABLED',
    ),
    forwardingMinFee: Math.max(
      0,
      parseInteger(env.STACKFLOW_NODE_FORWARDING_MIN_FEE, 0),
    ).toString(10),
    forwardingTimeoutMs: Math.max(
      1_000,
      parseInteger(
        env.STACKFLOW_NODE_FORWARDING_TIMEOUT_MS,
        DEFAULT_FORWARDING_TIMEOUT_MS,
      ),
    ),
    forwardingAllowPrivateDestinations: parseBoolean(
      env.STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS,
      false,
      'STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS',
    ),
    forwardingAllowedBaseUrls: parseCsv(
      env.STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS,
    ).map(normalizeBaseUrl),
    forwardingRevealRetryIntervalMs: Math.max(
      1_000,
      parseInteger(
        env.STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_INTERVAL_MS,
        DEFAULT_FORWARDING_REVEAL_RETRY_INTERVAL_MS,
      ),
    ),
    forwardingRevealRetryMaxAttempts: Math.max(
      1,
      parseInteger(
        env.STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS,
        DEFAULT_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS,
      ),
    ),
  };
}
