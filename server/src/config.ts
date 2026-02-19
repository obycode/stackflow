import path from 'node:path';

import { parsePrincipal } from './principal-utils.js';
import type {
  DisputeExecutorMode,
  CounterpartySignerMode,
  SignatureVerifierMode,
  StackflowNodeConfig,
} from './types.js';
import process from 'node:process';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_RECENT_EVENTS = 500;
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
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

  return fallback;
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
    port: parseInteger(env.STACKFLOW_NODE_PORT, DEFAULT_PORT),
    dbFile,
    maxRecentEvents: parseInteger(
      env.STACKFLOW_NODE_MAX_RECENT_EVENTS,
      DEFAULT_MAX_RECENT_EVENTS,
    ),
    logRawEvents: parseBoolean(env.STACKFLOW_NODE_LOG_RAW_EVENTS, false),
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
    ),
  };
}
