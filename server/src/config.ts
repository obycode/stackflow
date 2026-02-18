import path from 'node:path';

import { parsePrincipal } from './principal-utils.js';
import type {
  DisputeExecutorMode,
  ProducerSignerMode,
  SignatureVerifierMode,
  WatchtowerConfig,
} from './types.js';
import process from 'node:process';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_RECENT_EVENTS = 500;
const MAX_WATCHED_PRINCIPALS = 100;
const DEFAULT_DB_FILE = path.resolve(
  process.cwd(),
  'server/data/watchtower-state.db',
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
    parsePrincipal(principal, 'WATCHTOWER_PRINCIPALS'),
  );

  if (principals.length > MAX_WATCHED_PRINCIPALS) {
    throw new Error(
      `WATCHTOWER_PRINCIPALS exceeds max of ${MAX_WATCHED_PRINCIPALS} entries`,
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
    'WATCHTOWER_SIGNATURE_VERIFIER_MODE must be readonly, accept-all, or reject-all',
  );
}

function parseDisputeExecutorMode(value: unknown): DisputeExecutorMode {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'noop' || normalized === 'mock') {
    return normalized;
  }

  throw new Error(
    'WATCHTOWER_DISPUTE_EXECUTOR_MODE must be auto, noop, or mock',
  );
}

function parseProducerSignerMode(value: unknown): ProducerSignerMode {
  const normalized = String(value || 'local-key').trim().toLowerCase();
  if (normalized === 'local-key' || normalized === 'kms') {
    return normalized;
  }

  throw new Error(
    'WATCHTOWER_PRODUCER_SIGNER_MODE must be local-key or kms',
  );
}

function parseStackflowMessageVersion(value: unknown): string {
  const text = String(value || '0.6.0').trim();
  if (text.length === 0) {
    throw new Error('WATCHTOWER_STACKFLOW_MESSAGE_VERSION must not be empty');
  }
  if (!/^[\x20-\x7E]+$/.test(text)) {
    throw new Error('WATCHTOWER_STACKFLOW_MESSAGE_VERSION must be ASCII');
  }
  return text;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatchtowerConfig {
  const dbFile =
    env.WATCHTOWER_DB_FILE?.trim() ||
    env.WATCHTOWER_STATE_FILE?.trim() ||
    DEFAULT_DB_FILE;

  return {
    host: env.WATCHTOWER_HOST?.trim() || DEFAULT_HOST,
    port: parseInteger(env.WATCHTOWER_PORT, DEFAULT_PORT),
    dbFile,
    maxRecentEvents: parseInteger(
      env.WATCHTOWER_MAX_RECENT_EVENTS,
      DEFAULT_MAX_RECENT_EVENTS,
    ),
    logRawEvents: parseBoolean(env.WATCHTOWER_LOG_RAW_EVENTS, false),
    watchedContracts: parseCsv(env.STACKFLOW_CONTRACTS),
    watchedPrincipals: parsePrincipalCsv(env.WATCHTOWER_PRINCIPALS),
    stacksNetwork: parseNetwork(env.STACKS_NETWORK),
    stacksApiUrl: env.STACKS_API_URL?.trim() || null,
    signerKey: env.WATCHTOWER_SIGNER_KEY?.trim() || null,
    producerKey:
      env.WATCHTOWER_PRODUCER_KEY?.trim() || env.WATCHTOWER_SIGNER_KEY?.trim() || null,
    producerPrincipal: env.WATCHTOWER_PRODUCER_PRINCIPAL?.trim() || null,
    producerSignerMode: parseProducerSignerMode(
      env.WATCHTOWER_PRODUCER_SIGNER_MODE,
    ),
    stackflowMessageVersion: parseStackflowMessageVersion(
      env.WATCHTOWER_STACKFLOW_MESSAGE_VERSION,
    ),
    signatureVerifierMode: parseSignatureVerifierMode(
      env.WATCHTOWER_SIGNATURE_VERIFIER_MODE,
    ),
    disputeExecutorMode: parseDisputeExecutorMode(
      env.WATCHTOWER_DISPUTE_EXECUTOR_MODE,
    ),
    disputeOnlyBeneficial: parseBoolean(
      env.WATCHTOWER_DISPUTE_ONLY_BENEFICIAL,
      false,
    ),
  };
}
