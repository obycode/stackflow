import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { loadConfig } from './config.js';
import {
  MockDisputeExecutor,
  NoopDisputeExecutor,
  StacksDisputeExecutor,
} from './dispute-executor.js';
import {
  AcceptAllSignatureVerifier,
  ReadOnlySignatureVerifier,
  RejectAllSignatureVerifier,
} from './signature-verifier.js';
import {
  createCounterpartySigner,
  CounterpartyService,
  CounterpartyServiceError,
  type CounterpartySignRequest,
} from './counterparty-service.js';
import {
  ForwardingService,
  ForwardingServiceError,
} from './forwarding-service.js';
import { SqliteStateStore } from './state-store.js';
import { canonicalPipeKey } from './principal-utils.js';
import { normalizePipeId } from './observer-parser.js';
import type {
  DisputeExecutor,
  ForwardingPaymentRecord,
  PipeKey,
  SignatureVerifier,
  StackflowNodeStatus,
} from './types.js';
import {
  PrincipalNotWatchedError,
  SignatureValidationError,
  StackflowNode,
} from './stackflow-node.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const UI_ROOT = path.resolve(process.cwd(), 'server/ui');
const STACKS_NODE_COMPAT_ROUTES = new Set([
  '/new_mempool_tx',
  '/drop_mempool_tx',
  '/new_microblocks',
]);
const DEFAULT_STACKFLOW_CONTRACT_PATTERN = /\.stackflow(?:[-.].+)?$/i;
const RAW_EVENT_LOG_MAX_CHARS = 25_000;
const PEER_PROTOCOL_VERSION = '1';
const HEADER_PEER_PROTOCOL_VERSION = 'x-stackflow-protocol-version';
const HEADER_PEER_REQUEST_ID = 'x-stackflow-request-id';
const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';
const MAX_PROTOCOL_ID_LENGTH = 128;
const PROTOCOL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const WRITE_RATE_LIMIT_WINDOW_MS = 60_000;
const FORWARDING_REVEAL_RETRY_BATCH_SIZE = 25;

const UI_FILE_MAP: Record<string, { file: string; contentType: string }> = {
  '/app': {
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/app/': {
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/app/index.html': {
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/app/main.js': {
    file: 'main.js',
    contentType: 'application/javascript; charset=utf-8',
  },
  '/app/styles.css': {
    file: 'styles.css',
    contentType: 'text/css; charset=utf-8',
  },
};

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface PeerRequestMetadata {
  protocolVersion: string;
  requestId: string;
  idempotencyKey: string;
}

interface WriteRateLimitCounter {
  windowStartedAtMs: number;
  count: number;
}

interface ObserverIngressPolicy {
  localhostOnly: boolean;
  allowedIps: Set<string>;
}

interface SensitiveReadPolicy {
  adminToken: string | null;
  localhostOnlyWithoutToken: boolean;
  redactWithoutToken: boolean;
  trustProxy: boolean;
}

interface SensitiveReadAccess {
  allowed: boolean;
  fullAccess: boolean;
  sourceIp: string | null;
  statusCode: number;
  reason: string;
}

class PeerProtocolError extends Error {
  readonly statusCode: number;

  readonly reason: string;

  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

function readSingleHeader(
  request: IncomingMessage,
  headerName: string,
): string | null {
  const raw = request.headers[headerName];
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw[0] : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function validateProtocolId(value: string): boolean {
  if (value.length < 8 || value.length > MAX_PROTOCOL_ID_LENGTH) {
    return false;
  }
  return PROTOCOL_ID_PATTERN.test(value);
}

function parsePeerRequestMetadata(request: IncomingMessage): PeerRequestMetadata {
  const protocolVersion = readSingleHeader(request, HEADER_PEER_PROTOCOL_VERSION);
  if (!protocolVersion) {
    throw new PeerProtocolError(
      400,
      'missing-protocol-version',
      `${HEADER_PEER_PROTOCOL_VERSION} header is required`,
    );
  }
  if (protocolVersion !== PEER_PROTOCOL_VERSION) {
    throw new PeerProtocolError(
      400,
      'unsupported-protocol-version',
      `unsupported protocol version: ${protocolVersion}`,
    );
  }

  const requestId = readSingleHeader(request, HEADER_PEER_REQUEST_ID);
  if (!requestId) {
    throw new PeerProtocolError(
      400,
      'missing-request-id',
      `${HEADER_PEER_REQUEST_ID} header is required`,
    );
  }
  if (!validateProtocolId(requestId)) {
    throw new PeerProtocolError(
      400,
      'invalid-request-id',
      `${HEADER_PEER_REQUEST_ID} must be 8-128 chars [a-zA-Z0-9._:-]`,
    );
  }

  const idempotencyKey = readSingleHeader(request, HEADER_IDEMPOTENCY_KEY);
  if (!idempotencyKey) {
    throw new PeerProtocolError(
      400,
      'missing-idempotency-key',
      `${HEADER_IDEMPOTENCY_KEY} header is required`,
    );
  }
  if (!validateProtocolId(idempotencyKey)) {
    throw new PeerProtocolError(
      400,
      'invalid-idempotency-key',
      `${HEADER_IDEMPOTENCY_KEY} must be 8-128 chars [a-zA-Z0-9._:-]`,
    );
  }

  return {
    protocolVersion,
    requestId,
    idempotencyKey,
  };
}

function hashRequestPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function withPeerProtocolMeta(
  payload: Record<string, unknown>,
  metadata: PeerRequestMetadata,
): Record<string, unknown> {
  return {
    ...payload,
    protocolVersion: metadata.protocolVersion,
    requestId: metadata.requestId,
    idempotencyKey: metadata.idempotencyKey,
    processedAt: new Date().toISOString(),
  };
}

function normalizeIpAddress(value: string): string | null {
  let text = value.trim();
  if (!text) {
    return null;
  }

  if (text.startsWith('[') && text.endsWith(']')) {
    text = text.slice(1, -1);
  }

  const zoneSeparator = text.indexOf('%');
  if (zoneSeparator >= 0) {
    text = text.slice(0, zoneSeparator);
  }

  const mappedV4Match = text.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedV4Match) {
    const upper = Number.parseInt(mappedV4Match[1], 16);
    const lower = Number.parseInt(mappedV4Match[2], 16);
    return `${(upper >> 8) & 255}.${upper & 255}.${(lower >> 8) & 255}.${lower & 255}`;
  }

  if (text.toLowerCase().startsWith('::ffff:')) {
    const candidate = text.slice('::ffff:'.length);
    if (net.isIP(candidate) === 4) {
      return candidate;
    }
  }

  const ipVersion = net.isIP(text);
  if (ipVersion === 4) {
    return text;
  }

  if (ipVersion === 6) {
    try {
      const hostname = new URL(`http://[${text}]/`).hostname;
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return hostname.slice(1, -1).toLowerCase();
      }
    } catch {
      return text.toLowerCase();
    }
    return text.toLowerCase();
  }

  return null;
}

function getRemoteIp(request: IncomingMessage): string | null {
  const remote = request.socket.remoteAddress;
  if (!remote) {
    return null;
  }
  return normalizeIpAddress(remote);
}

function isLoopbackIp(ip: string): boolean {
  if (ip === '::1') {
    return true;
  }
  return net.isIP(ip) === 4 && ip.startsWith('127.');
}

function isPublicBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized === 'localhost') {
    return false;
  }

  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return true;
  }

  const asIp = normalizeIpAddress(normalized);
  if (asIp) {
    return !isLoopbackIp(asIp);
  }

  // Non-localhost hostnames are treated as public bind targets.
  return true;
}

function buildObserverIngressPolicy(args: {
  observerLocalhostOnly: boolean;
  observerAllowedIps: string[];
}): ObserverIngressPolicy {
  const allowedIps = new Set<string>();
  for (const candidate of args.observerAllowedIps) {
    const normalized = normalizeIpAddress(candidate);
    if (!normalized) {
      throw new Error(
        `STACKFLOW_NODE_OBSERVER_ALLOWED_IPS contains invalid IP: ${candidate}`,
      );
    }
    allowedIps.add(normalized);
  }

  return {
    localhostOnly: args.observerLocalhostOnly,
    allowedIps,
  };
}

function isObserverSourceAllowed(
  request: IncomingMessage,
  policy: ObserverIngressPolicy,
): { allowed: boolean; sourceIp: string | null } {
  const sourceIp = getRemoteIp(request);
  if (!sourceIp) {
    return { allowed: false, sourceIp: null };
  }

  if (policy.allowedIps.size > 0) {
    return {
      allowed: policy.allowedIps.has(sourceIp),
      sourceIp,
    };
  }

  if (policy.localhostOnly) {
    return {
      allowed: isLoopbackIp(sourceIp),
      sourceIp,
    };
  }

  return { allowed: true, sourceIp };
}

function normalizeForwardedIpCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const bracketed = trimmed.match(/^\[([^[\]]+)\](?::\d+)?$/);
  if (bracketed) {
    return normalizeIpAddress(bracketed[1]);
  }

  const v4WithPort = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) {
    return normalizeIpAddress(v4WithPort[1]);
  }

  return normalizeIpAddress(trimmed);
}

function extractClientIp(
  request: IncomingMessage,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const forwarded = readSingleHeader(request, 'x-forwarded-for');
    if (forwarded) {
      const firstHop = forwarded.split(',')[0] ?? '';
      const normalized = normalizeForwardedIpCandidate(firstHop);
      if (normalized) {
        return normalized;
      }
    }
  }

  return getRemoteIp(request);
}

function extractAdminToken(request: IncomingMessage): string | null {
  const authorization = readSingleHeader(request, 'authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice('bearer '.length).trim();
    if (token) {
      return token;
    }
  }

  const fallback = readSingleHeader(request, 'x-stackflow-admin-token');
  return fallback && fallback.trim() ? fallback.trim() : null;
}

function getSensitiveReadAccess(
  request: IncomingMessage,
  policy: SensitiveReadPolicy,
): SensitiveReadAccess {
  const sourceIp = extractClientIp(request, policy.trustProxy);
  const adminToken = extractAdminToken(request);

  if (policy.adminToken) {
    if (adminToken === policy.adminToken) {
      return {
        allowed: true,
        fullAccess: true,
        sourceIp,
        statusCode: 200,
        reason: 'admin-token',
      };
    }

    return {
      allowed: false,
      fullAccess: false,
      sourceIp,
      statusCode: 401,
      reason: 'invalid-admin-read-token',
    };
  }

  if (policy.localhostOnlyWithoutToken) {
    if (!sourceIp || !isLoopbackIp(sourceIp)) {
      return {
        allowed: false,
        fullAccess: false,
        sourceIp,
        statusCode: 403,
        reason: 'sensitive-read-localhost-only',
      };
    }
  }

  return {
    allowed: true,
    fullAccess: false,
    sourceIp,
    statusCode: 200,
    reason: 'redacted',
  };
}

function redactSignatureState(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...value,
    mySignature:
      typeof value.mySignature === 'string' ? '[redacted]' : value.mySignature,
    theirSignature:
      typeof value.theirSignature === 'string'
        ? '[redacted]'
        : value.theirSignature,
    secret: null,
  };
}

function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveObject(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      key === 'mySignature' ||
      key === 'theirSignature' ||
      key === 'counterpartySignature'
    ) {
      out[key] = typeof fieldValue === 'string' ? '[redacted]' : fieldValue;
      continue;
    }
    if (key === 'secret' || key === 'revealedSecret') {
      out[key] = null;
      continue;
    }
    out[key] = redactSensitiveObject(fieldValue);
  }
  return out;
}

function redactForwardingPayment(
  payment: ForwardingPaymentRecord | null,
): ForwardingPaymentRecord | null {
  if (!payment) {
    return null;
  }

  return {
    ...payment,
    revealedSecret: null,
    resultJson: (redactSensitiveObject(payment.resultJson) ||
      {}) as Record<string, unknown>,
  };
}

function extractPaymentId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.paymentId !== 'string') {
    return null;
  }
  const value = payload.paymentId.trim();
  return value.length > 0 ? value : null;
}

function extractForwardingHashedSecret(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.hashedSecret !== 'string') {
    return null;
  }
  const value = payload.hashedSecret.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

interface ForwardingPipeMetadata {
  contractId: string | null;
  pipeId: string | null;
  pipeNonce: string | null;
}

function deriveForwardingPipeMetadata(
  request: Pick<
    CounterpartySignRequest,
    'contractId' | 'forPrincipal' | 'withPrincipal' | 'token' | 'nonce'
  >,
): ForwardingPipeMetadata {
  const pipeKey = canonicalPipeKey(
    request.token,
    request.forPrincipal,
    request.withPrincipal,
  );
  const pipeId = normalizePipeId(pipeKey);
  if (!pipeId) {
    return {
      contractId: request.contractId,
      pipeId: null,
      pipeNonce: request.nonce,
    };
  }

  return {
    contractId: request.contractId,
    pipeId,
    pipeNonce: request.nonce,
  };
}

function summarizeNewBlockPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return 'payload=non-object';
  }

  const blockHeight =
    typeof payload.block_height === 'number' || typeof payload.block_height === 'string'
      ? String(payload.block_height)
      : typeof payload.blockHeight === 'number' || typeof payload.blockHeight === 'string'
        ? String(payload.blockHeight)
        : '?';

  const eventCount = Array.isArray(payload.events) ? payload.events.length : 0;
  const txCount = Array.isArray(payload.transactions) ? payload.transactions.length : 0;

  return `block=${blockHeight} events=${eventCount} txs=${txCount}`;
}

function parseUintLike(value: unknown): string | null {
  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString(10);
  }

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return value.trim();
  }

  return null;
}

function extractBurnBlockHeight(payload: unknown): string | null {
  const queue: unknown[] = [payload];
  const visited = new Set<object>();
  const keys = ['burn_block_height', 'burnBlockHeight', 'block_height', 'blockHeight'];

  while (queue.length > 0) {
    const current = queue.shift();

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const key of keys) {
      const value = parseUintLike(current[key]);
      if (value !== null) {
        return value;
      }
    }

    for (const value of Object.values(current)) {
      queue.push(value);
    }
  }

  return null;
}

function stringifyForLog(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= RAW_EVENT_LOG_MAX_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, RAW_EVENT_LOG_MAX_CHARS)}...[truncated]`;
  } catch {
    return '[unserializable-event]';
  }
}

function contractMatches(contractId: string, watchedContracts: string[]): boolean {
  if (watchedContracts.length > 0) {
    return watchedContracts.includes(contractId);
  }
  return DEFAULT_STACKFLOW_CONTRACT_PATTERN.test(contractId);
}

function extractRawStackflowPrintEventSamples(
  payload: unknown,
  watchedContracts: string[],
): Record<string, unknown>[] {
  const queue: unknown[] = [payload];
  const visited = new Set<object>();
  const samples: Record<string, unknown>[] = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const candidateEvents: Array<{
      envelope: Record<string, unknown>;
      event: Record<string, unknown>;
    }> = [];

    if (isRecord(current.contract_event)) {
      candidateEvents.push({ envelope: current, event: current.contract_event });
    }

    if (isRecord(current.contract_log)) {
      candidateEvents.push({ envelope: current, event: current.contract_log });
    }

    const hasValue =
      current.raw_value !== undefined ||
      current.rawValue !== undefined ||
      current.value !== undefined;
    const hasEventRef =
      current.txid !== undefined ||
      current.tx_id !== undefined ||
      current.event_index !== undefined ||
      current.eventIndex !== undefined;

    if (
      typeof current.contract_identifier === 'string' &&
      typeof current.topic === 'string' &&
      hasValue &&
      hasEventRef
    ) {
      candidateEvents.push({ envelope: current, event: current });
    }

    for (const candidate of candidateEvents) {
      const contractId = candidate.event.contract_identifier;
      const topic = candidate.event.topic;
      if (
        typeof contractId === 'string' &&
        topic === 'print' &&
        contractMatches(contractId, watchedContracts)
      ) {
        samples.push(candidate.envelope);
      }
    }

    for (const value of Object.values(current)) {
      queue.push(value);
    }
  }

  return samples;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });

    request.on('error', reject);
  });
}

function discardBody(request: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    request.on('data', () => {
      // Intentionally ignore body content for compatibility endpoints.
    });
    request.on('end', () => resolve());
    request.on('error', reject);
  });
}

function parseLimit(url: URL): number {
  const limit = url.searchParams.get('limit');
  if (!limit) {
    return 100;
  }

  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 100;
  }

  return Math.min(parsed, 500);
}

type MergedPipeRecord = {
  stateId: string;
  pipeId: string;
  contractId: string;
  pipeKey: PipeKey;
  balance1: string | null;
  balance2: string | null;
  pending1Amount: string | null;
  pending1BurnHeight: string | null;
  pending2Amount: string | null;
  pending2BurnHeight: string | null;
  expiresAt: string | null;
  nonce: string | null;
  closer: string | null;
  event: string;
  txid: string | null;
  blockHeight: string | null;
  updatedAt: string;
  source: 'onchain' | 'signature-state';
};

function nonceValue(value: string | null): bigint {
  if (!value) {
    return -1n;
  }

  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function shouldReplacePipe(existing: MergedPipeRecord, incoming: MergedPipeRecord): boolean {
  const existingNonce = nonceValue(existing.nonce);
  const incomingNonce = nonceValue(incoming.nonce);

  if (incomingNonce !== existingNonce) {
    return incomingNonce > existingNonce;
  }

  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt;
  }

  if (existing.source !== incoming.source) {
    return incoming.source === 'onchain';
  }

  return false;
}

function mergeAuthoritativePipes(
  status: StackflowNodeStatus,
  principal: string | null,
): MergedPipeRecord[] {
  const records = new Map<string, MergedPipeRecord>();

  for (const observed of status.observedPipes) {
    if (
      principal &&
      observed.pipeKey['principal-1'] !== principal &&
      observed.pipeKey['principal-2'] !== principal
    ) {
      continue;
    }

    records.set(observed.stateId, {
      ...observed,
      source: 'onchain',
    });
  }

  for (const signature of status.signatureStates) {
    const pipeKey = canonicalPipeKey(
      signature.token,
      signature.forPrincipal,
      signature.withPrincipal,
    );

    if (
      principal &&
      pipeKey['principal-1'] !== principal &&
      pipeKey['principal-2'] !== principal
    ) {
      continue;
    }

    const stateId = `${signature.contractId}|${signature.pipeId}`;
    const principal1IsSigner = pipeKey['principal-1'] === signature.forPrincipal;

    const candidate: MergedPipeRecord = {
      stateId,
      pipeId: signature.pipeId,
      contractId: signature.contractId,
      pipeKey,
      balance1: principal1IsSigner ? signature.myBalance : signature.theirBalance,
      balance2: principal1IsSigner ? signature.theirBalance : signature.myBalance,
      pending1Amount: null,
      pending1BurnHeight: null,
      pending2Amount: null,
      pending2BurnHeight: null,
      expiresAt: null,
      nonce: signature.nonce,
      closer: null,
      event: 'signature-state',
      txid: null,
      blockHeight: null,
      updatedAt: signature.updatedAt,
      source: 'signature-state',
    };

    const existing = records.get(stateId);
    if (!existing || shouldReplacePipe(existing, candidate)) {
      records.set(stateId, candidate);
    }
  }

  return [...records.values()].sort((left, right) => {
    const leftNonce = nonceValue(left.nonce);
    const rightNonce = nonceValue(right.nonce);
    if (leftNonce !== rightNonce) {
      return rightNonce > leftNonce ? 1 : -1;
    }

    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }

    return left.stateId.localeCompare(right.stateId);
  });
}

async function maybeServeUi(
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  const asset = UI_FILE_MAP[pathname];
  if (!asset) {
    return false;
  }

  try {
    const filePath = path.join(UI_ROOT, asset.file);
    const content = await readFile(filePath);
    response.writeHead(200, {
      'content-type': asset.contentType,
      'cache-control': 'no-store',
    });
    response.end(content);
  } catch {
    writeJson(response, 500, {
      ok: false,
      error: 'failed to load ui asset',
    });
  }

  return true;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ForwardingServiceError) {
    const reason =
      error.details && typeof error.details.reason === 'string'
        ? error.details.reason
        : null;
    return reason ? `${error.message} (${reason})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shouldPropagateReveal(payment: ForwardingPaymentRecord): boolean {
  return Boolean(payment.upstreamBaseUrl && payment.upstreamPaymentId);
}

function nextRetryAt(retryIntervalMs: number): string {
  return new Date(Date.now() + retryIntervalMs).toISOString();
}

async function propagateRevealForPayment({
  payment,
  secret,
  trigger,
  forwardingService,
  stateStore,
  retryIntervalMs,
  maxAttempts,
}: {
  payment: ForwardingPaymentRecord;
  secret: string;
  trigger: 'api' | 'retry';
  forwardingService: ForwardingService;
  stateStore: SqliteStateStore;
  retryIntervalMs: number;
  maxAttempts: number;
}): Promise<ForwardingPaymentRecord> {
  if (!shouldPropagateReveal(payment)) {
    const updated = {
      ...payment,
      revealPropagationStatus: 'not-applicable' as const,
      revealLastError: null,
      revealNextRetryAt: null,
      revealPropagatedAt: null,
      updatedAt: new Date().toISOString(),
    };
    stateStore.setForwardingPayment(updated);
    return updated;
  }

  if (payment.revealPropagationStatus === 'propagated') {
    return payment;
  }

  const attempt = payment.revealPropagationAttempts + 1;
  const attemptPrefix = `[stackflow-node] reveal propagation trigger=${trigger} paymentId=${payment.paymentId} attempt=${attempt}`;
  console.log(
    `${attemptPrefix} upstream=${payment.upstreamBaseUrl}${payment.upstreamRevealEndpoint || '/forwarding/reveal'} upstreamPaymentId=${payment.upstreamPaymentId}`,
  );

  try {
    await forwardingService.propagateRevealToUpstream({
      payment,
      secret,
      attempt,
    });

    const updatedAt = new Date().toISOString();
    const updated = {
      ...payment,
      revealPropagationStatus: 'propagated' as const,
      revealPropagationAttempts: attempt,
      revealLastError: null,
      revealNextRetryAt: null,
      revealPropagatedAt: updatedAt,
      updatedAt,
    };
    stateStore.setForwardingPayment(updated);
    console.log(`${attemptPrefix} result=propagated`);
    return updated;
  } catch (error) {
    const errorText = formatErrorMessage(error);
    const reachedLimit = attempt >= maxAttempts;
    const updatedAt = new Date().toISOString();
    const updated = {
      ...payment,
      revealPropagationStatus: reachedLimit ? ('failed' as const) : ('pending' as const),
      revealPropagationAttempts: attempt,
      revealLastError: errorText,
      revealNextRetryAt: reachedLimit ? null : nextRetryAt(retryIntervalMs),
      revealPropagatedAt: null,
      updatedAt,
    };
    stateStore.setForwardingPayment(updated);
    console.warn(
      `${attemptPrefix} result=${updated.revealPropagationStatus} error=${errorText} nextRetryAt=${updated.revealNextRetryAt ?? '-'}`,
    );
    return updated;
  }
}

function createHandler({
  stackflowNode,
  stateStore,
  counterpartyService,
  forwardingService,
  propagateReveal,
  startedAt,
  disputeEnabled,
  signerAddress,
  counterpartyEnabled,
  counterpartyPrincipal,
  stacksNetwork,
  watchedContracts,
  logRawEvents,
  peerWriteRateLimitPerMinute,
  trustProxy,
  observerIngressPolicy,
  sensitiveReadPolicy,
  forwardingAllowPrivateDestinations,
}: {
  stackflowNode: StackflowNode;
  stateStore: SqliteStateStore;
  counterpartyService: CounterpartyService;
  forwardingService: ForwardingService;
  propagateReveal: (args: {
    payment: ForwardingPaymentRecord;
    secret: string;
    trigger: 'api' | 'retry';
  }) => Promise<ForwardingPaymentRecord>;
  startedAt: string;
  disputeEnabled: boolean;
  signerAddress: string | null;
  counterpartyEnabled: boolean;
  counterpartyPrincipal: string | null;
  stacksNetwork: 'mainnet' | 'testnet' | 'devnet' | 'mocknet';
  watchedContracts: string[];
  logRawEvents: boolean;
  peerWriteRateLimitPerMinute: number;
  trustProxy: boolean;
  observerIngressPolicy: ObserverIngressPolicy;
  sensitiveReadPolicy: SensitiveReadPolicy;
  forwardingAllowPrivateDestinations: boolean;
}) {
  const writeRateLimitCounters = new Map<string, WriteRateLimitCounter>();

  const consumeWriteRateLimit = (
    request: IncomingMessage,
  ): { limited: false } | { limited: true; retryAfterSeconds: number } => {
    if (peerWriteRateLimitPerMinute <= 0) {
      return { limited: false };
    }

    const now = Date.now();
    if (writeRateLimitCounters.size > 10_000) {
      for (const [key, value] of writeRateLimitCounters.entries()) {
        if (now - value.windowStartedAtMs >= WRITE_RATE_LIMIT_WINDOW_MS) {
          writeRateLimitCounters.delete(key);
        }
      }
    }
    const clientIp = extractClientIp(request, trustProxy) ?? 'unknown';
    const existing = writeRateLimitCounters.get(clientIp);
    if (!existing || now - existing.windowStartedAtMs >= WRITE_RATE_LIMIT_WINDOW_MS) {
      writeRateLimitCounters.set(clientIp, {
        windowStartedAtMs: now,
        count: 1,
      });
      return { limited: false };
    }

    if (existing.count >= peerWriteRateLimitPerMinute) {
      const elapsed = now - existing.windowStartedAtMs;
      const retryAfterMs = Math.max(1_000, WRITE_RATE_LIMIT_WINDOW_MS - elapsed);
      return {
        limited: true,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
      };
    }

    existing.count += 1;
    return { limited: false };
  };

  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const method = request.method || 'GET';
    const url = new URL(request.url || '/', 'http://localhost');

    if (method === 'GET') {
      const served = await maybeServeUi(url.pathname, response);
      if (served) {
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/health') {
      const status = stackflowNode.status();

      writeJson(response, 200, {
        ok: true,
        startedAt,
        updatedAt: status.updatedAt,
        activeClosures: status.activeClosures.length,
        observedPipes: status.observedPipes.length,
        signatureStates: status.signatureStates.length,
        disputeEnabled,
        signerAddress,
        counterpartyEnabled,
        counterpartyPrincipal,
        forwardingEnabled: forwardingService.enabled,
        stacksNetwork,
        peerWriteRateLimitPerMinute,
        trustProxy,
        observerLocalhostOnly: observerIngressPolicy.localhostOnly,
        observerAllowedIps: [...observerIngressPolicy.allowedIps],
        adminReadTokenConfigured: Boolean(sensitiveReadPolicy.adminToken),
        adminReadLocalhostOnly: sensitiveReadPolicy.localhostOnlyWithoutToken,
        redactSensitiveReadData: sensitiveReadPolicy.redactWithoutToken,
        forwardingAllowPrivateDestinations,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/closures') {
      const status = stackflowNode.status();
      writeJson(response, 200, {
        ok: true,
        closures: status.activeClosures,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/signature-states') {
      const access = getSensitiveReadAccess(request, sensitiveReadPolicy);
      if (!access.allowed) {
        writeJson(
          response,
          access.statusCode,
          {
            ok: false,
            error: 'sensitive read not authorized',
            reason: access.reason,
          },
          access.statusCode === 401
            ? { 'www-authenticate': 'Bearer realm="stackflow-node-admin-read"' }
            : {},
        );
        return;
      }

      const status = stackflowNode.status();
      const limit = parseLimit(url);
      const signatureStates = status.signatureStates.slice(0, limit);
      const shouldRedact = sensitiveReadPolicy.redactWithoutToken && !access.fullAccess;

      writeJson(response, 200, {
        ok: true,
        redacted: shouldRedact,
        signatureStates: shouldRedact
          ? signatureStates.map((state) =>
              redactSignatureState(state as unknown as Record<string, unknown>),
            )
          : signatureStates,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/pipes') {
      const status = stackflowNode.status();
      const limit = parseLimit(url);
      const principal = url.searchParams.get('principal')?.trim() || null;
      const pipes = mergeAuthoritativePipes(status, principal);

      writeJson(response, 200, {
        ok: true,
        pipes: pipes.slice(0, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/dispute-attempts') {
      const status = stackflowNode.status();
      const limit = parseLimit(url);

      writeJson(response, 200, {
        ok: true,
        disputeAttempts: status.disputeAttempts.slice(0, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/events') {
      const status = stackflowNode.status();
      const limit = parseLimit(url);
      writeJson(response, 200, {
        ok: true,
        events: status.recentEvents.slice(0, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/forwarding/payments') {
      const access = getSensitiveReadAccess(request, sensitiveReadPolicy);
      if (!access.allowed) {
        writeJson(
          response,
          access.statusCode,
          {
            ok: false,
            error: 'sensitive read not authorized',
            reason: access.reason,
          },
          access.statusCode === 401
            ? { 'www-authenticate': 'Bearer realm="stackflow-node-admin-read"' }
            : {},
        );
        return;
      }

      const shouldRedact = sensitiveReadPolicy.redactWithoutToken && !access.fullAccess;
      const limit = parseLimit(url);
      const paymentId = url.searchParams.get('paymentId')?.trim();
      if (paymentId) {
        const payment = stateStore.getForwardingPayment(paymentId);
        writeJson(response, 200, {
          ok: true,
          redacted: shouldRedact,
          payment: shouldRedact ? redactForwardingPayment(payment) : payment,
        });
        return;
      }

      const payments = stateStore.listForwardingPayments(limit);
      writeJson(response, 200, {
        ok: true,
        redacted: shouldRedact,
        payments: shouldRedact
          ? payments.map((payment) => redactForwardingPayment(payment))
          : payments,
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/signature-states') {
      const rateLimit = consumeWriteRateLimit(request);
      if (rateLimit.limited) {
        writeJson(
          response,
          429,
          {
            ok: false,
            error: 'write rate limit exceeded',
            reason: 'rate-limit-exceeded',
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
          { 'retry-after': String(rateLimit.retryAfterSeconds) },
        );
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const result = await stackflowNode.upsertSignatureState(payload);

        if (!result.stored && result.reason === 'nonce-too-low') {
          const incomingNonce =
            isRecord(payload) &&
            (typeof payload.nonce === 'string' ||
              typeof payload.nonce === 'number' ||
              typeof payload.nonce === 'bigint')
              ? String(payload.nonce)
              : null;

          console.warn(
            `[stackflow-node] /signature-states rejected status=409 reason=nonce-too-low incomingNonce=${
              incomingNonce ?? '-'
            } existingNonce=${result.state.nonce} stateId=${result.state.stateId}`,
          );
          writeJson(response, 409, {
            ok: false,
            error: 'nonce-too-low',
            reason: 'nonce-too-low',
            incomingNonce,
            existingNonce: result.state.nonce,
            state: result.state,
          });
          return;
        }

        writeJson(response, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        if (error instanceof SignatureValidationError) {
          console.warn(
            `[stackflow-node] /signature-states rejected status=401 error=${error.message}`,
          );
          writeJson(response, 401, {
            ok: false,
            error: error.message,
          });
          return;
        }

        if (error instanceof PrincipalNotWatchedError) {
          console.warn(
            `[stackflow-node] /signature-states rejected status=403 error=${error.message}`,
          );
          writeJson(response, 403, {
            ok: false,
            error: error.message,
          });
          return;
        }

        console.warn(
          `[stackflow-node] /signature-states rejected status=400 error=${
            error instanceof Error ? error.message : 'failed to store signature state'
          }`,
        );
        writeJson(response, 400, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'failed to store signature state',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/counterparty/transfer') {
      let peerMetadata: PeerRequestMetadata;
      try {
        peerMetadata = parsePeerRequestMetadata(request);
      } catch (error) {
        if (error instanceof PeerProtocolError) {
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            reason: error.reason,
          });
          return;
        }
        writeJson(response, 400, {
          ok: false,
          error: 'invalid peer protocol headers',
          reason: 'invalid-peer-protocol',
        });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const requestHash = hashRequestPayload(payload);
        const existing = stateStore.getIdempotentResponse(
          url.pathname,
          peerMetadata.idempotencyKey,
        );

        if (existing) {
          if (existing.requestHash !== requestHash) {
            writeJson(
              response,
              409,
              withPeerProtocolMeta(
                {
                  ok: false,
                  error: 'idempotency key reuse with different payload',
                  reason: 'idempotency-key-reused',
                },
                peerMetadata,
              ),
            );
            return;
          }

          writeJson(
            response,
            existing.statusCode,
            existing.responseJson,
            { 'x-stackflow-idempotency-replay': 'true' },
          );
          return;
        }

        const rateLimit = consumeWriteRateLimit(request);
        if (rateLimit.limited) {
          writeJson(
            response,
            429,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'write rate limit exceeded',
                reason: 'rate-limit-exceeded',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
              },
              peerMetadata,
            ),
            { 'retry-after': String(rateLimit.retryAfterSeconds) },
          );
          return;
        }

        const result = await counterpartyService.signTransfer(payload);

        if (!result.upsert.stored && result.upsert.reason === 'nonce-too-low') {
          console.warn(
            `[stackflow-node] /counterparty/transfer rejected status=409 reason=nonce-too-low incomingNonce=${result.request.nonce} existingNonce=${result.upsert.state.nonce} stateId=${result.upsert.state.stateId}`,
          );
          const body = withPeerProtocolMeta(
            {
              ok: false,
              error: 'nonce-too-low',
              reason: 'nonce-too-low',
              incomingNonce: result.request.nonce,
              existingNonce: result.upsert.state.nonce,
              state: result.upsert.state,
            },
            peerMetadata,
          );
          stateStore.setIdempotentResponse({
            endpoint: url.pathname,
            idempotencyKey: peerMetadata.idempotencyKey,
            requestHash,
            statusCode: 409,
            responseJson: body,
            createdAt: new Date().toISOString(),
          });
          writeJson(response, 409, body);
          return;
        }

        const body = withPeerProtocolMeta(
          {
            ok: true,
            counterpartyPrincipal: result.request.forPrincipal,
            withPrincipal: result.request.withPrincipal,
            token: result.request.token,
            amount: result.request.amount,
            nonce: result.request.nonce,
            action: result.request.action,
            actor: result.request.actor,
            myBalance: result.request.myBalance,
            theirBalance: result.request.theirBalance,
            mySignature: result.mySignature,
            theirSignature: result.request.theirSignature,
            stored: result.upsert.stored,
            replaced: result.upsert.replaced,
            reason: result.upsert.reason,
          },
          peerMetadata,
        );
        stateStore.setIdempotentResponse({
          endpoint: url.pathname,
          idempotencyKey: peerMetadata.idempotencyKey,
          requestHash,
          statusCode: 200,
          responseJson: body,
          createdAt: new Date().toISOString(),
        });
        writeJson(response, 200, body);
      } catch (error) {
        if (error instanceof CounterpartyServiceError) {
          console.warn(
            `[stackflow-node] /counterparty/transfer rejected status=${error.statusCode} error=${error.message}`,
          );
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          const body = withPeerProtocolMeta(
            {
              ok: false,
              error: error.message,
              ...details,
            },
            peerMetadata,
          );
          writeJson(response, error.statusCode, body);
          return;
        }

        console.error(
          `[stackflow-node] /counterparty/transfer error: ${
            error instanceof Error ? error.message : 'failed to sign transfer'
          }`,
        );
        writeJson(response, 500, {
          ok: false,
          error:
            error instanceof Error ? error.message : 'failed to sign transfer',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/counterparty/signature-request') {
      let peerMetadata: PeerRequestMetadata;
      try {
        peerMetadata = parsePeerRequestMetadata(request);
      } catch (error) {
        if (error instanceof PeerProtocolError) {
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            reason: error.reason,
          });
          return;
        }
        writeJson(response, 400, {
          ok: false,
          error: 'invalid peer protocol headers',
          reason: 'invalid-peer-protocol',
        });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const requestHash = hashRequestPayload(payload);
        const existing = stateStore.getIdempotentResponse(
          url.pathname,
          peerMetadata.idempotencyKey,
        );

        if (existing) {
          if (existing.requestHash !== requestHash) {
            writeJson(
              response,
              409,
              withPeerProtocolMeta(
                {
                  ok: false,
                  error: 'idempotency key reuse with different payload',
                  reason: 'idempotency-key-reused',
                },
                peerMetadata,
              ),
            );
            return;
          }

          writeJson(
            response,
            existing.statusCode,
            existing.responseJson,
            { 'x-stackflow-idempotency-replay': 'true' },
          );
          return;
        }

        const rateLimit = consumeWriteRateLimit(request);
        if (rateLimit.limited) {
          writeJson(
            response,
            429,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'write rate limit exceeded',
                reason: 'rate-limit-exceeded',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
              },
              peerMetadata,
            ),
            { 'retry-after': String(rateLimit.retryAfterSeconds) },
          );
          return;
        }

        const result = await counterpartyService.signSignatureRequest(payload);

        if (!result.upsert.stored && result.upsert.reason === 'nonce-too-low') {
          console.warn(
            `[stackflow-node] /counterparty/signature-request rejected status=409 reason=nonce-too-low incomingNonce=${result.request.nonce} existingNonce=${result.upsert.state.nonce} stateId=${result.upsert.state.stateId}`,
          );
          const body = withPeerProtocolMeta(
            {
              ok: false,
              error: 'nonce-too-low',
              reason: 'nonce-too-low',
              incomingNonce: result.request.nonce,
              existingNonce: result.upsert.state.nonce,
              state: result.upsert.state,
            },
            peerMetadata,
          );
          stateStore.setIdempotentResponse({
            endpoint: url.pathname,
            idempotencyKey: peerMetadata.idempotencyKey,
            requestHash,
            statusCode: 409,
            responseJson: body,
            createdAt: new Date().toISOString(),
          });
          writeJson(response, 409, body);
          return;
        }

        const body = withPeerProtocolMeta(
          {
            ok: true,
            counterpartyPrincipal: result.request.forPrincipal,
            withPrincipal: result.request.withPrincipal,
            token: result.request.token,
            amount: result.request.amount,
            nonce: result.request.nonce,
            action: result.request.action,
            actor: result.request.actor,
            myBalance: result.request.myBalance,
            theirBalance: result.request.theirBalance,
            mySignature: result.mySignature,
            theirSignature: result.request.theirSignature,
            stored: result.upsert.stored,
            replaced: result.upsert.replaced,
            reason: result.upsert.reason,
          },
          peerMetadata,
        );
        stateStore.setIdempotentResponse({
          endpoint: url.pathname,
          idempotencyKey: peerMetadata.idempotencyKey,
          requestHash,
          statusCode: 200,
          responseJson: body,
          createdAt: new Date().toISOString(),
        });
        writeJson(response, 200, body);
      } catch (error) {
        if (error instanceof CounterpartyServiceError) {
          console.warn(
            `[stackflow-node] /counterparty/signature-request rejected status=${error.statusCode} error=${error.message}`,
          );
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          const body = withPeerProtocolMeta(
            {
              ok: false,
              error: error.message,
              ...details,
            },
            peerMetadata,
          );
          writeJson(response, error.statusCode, body);
          return;
        }

        console.error(
          `[stackflow-node] /counterparty/signature-request error: ${
            error instanceof Error ? error.message : 'failed to sign request'
          }`,
        );
        writeJson(response, 500, {
          ok: false,
          error:
            error instanceof Error ? error.message : 'failed to sign request',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/forwarding/transfer') {
      let peerMetadata: PeerRequestMetadata;
      try {
        peerMetadata = parsePeerRequestMetadata(request);
      } catch (error) {
        if (error instanceof PeerProtocolError) {
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            reason: error.reason,
          });
          return;
        }
        writeJson(response, 400, {
          ok: false,
          error: 'invalid peer protocol headers',
          reason: 'invalid-peer-protocol',
        });
        return;
      }

      let payload: unknown = null;
      try {
        payload = await readJsonBody(request);
        const requestHash = hashRequestPayload(payload);
        const existing = stateStore.getIdempotentResponse(
          url.pathname,
          peerMetadata.idempotencyKey,
        );

        if (existing) {
          if (existing.requestHash !== requestHash) {
            writeJson(
              response,
              409,
              withPeerProtocolMeta(
                {
                  ok: false,
                  error: 'idempotency key reuse with different payload',
                  reason: 'idempotency-key-reused',
                },
                peerMetadata,
              ),
            );
            return;
          }

          writeJson(
            response,
            existing.statusCode,
            existing.responseJson,
            { 'x-stackflow-idempotency-replay': 'true' },
          );
          return;
        }

        const rateLimit = consumeWriteRateLimit(request);
        if (rateLimit.limited) {
          writeJson(
            response,
            429,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'write rate limit exceeded',
                reason: 'rate-limit-exceeded',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
              },
              peerMetadata,
            ),
            { 'retry-after': String(rateLimit.retryAfterSeconds) },
          );
          return;
        }

        const result = await forwardingService.processTransfer(payload);
        const responseBody = withPeerProtocolMeta(
          {
            ok: true,
            paymentId: result.paymentId,
            incomingAmount: result.incomingAmount,
            outgoingAmount: result.outgoingAmount,
            feeAmount: result.feeAmount,
            hashedSecret: result.hashedSecret,
            nextHopBaseUrl: result.nextHopBaseUrl,
            nextHopEndpoint: result.nextHopEndpoint,
            revealUpstream:
              result.upstreamBaseUrl && result.upstreamPaymentId
                ? {
                    baseUrl: result.upstreamBaseUrl,
                    revealEndpoint: result.upstreamRevealEndpoint,
                    paymentId: result.upstreamPaymentId,
                  }
                : null,
            upstream: {
              counterpartyPrincipal: result.incomingResult.request.forPrincipal,
              withPrincipal: result.incomingResult.request.withPrincipal,
              nonce: result.incomingResult.request.nonce,
              mySignature: result.incomingResult.mySignature,
              theirSignature: result.incomingResult.request.theirSignature,
              stored: result.incomingResult.upsert.stored,
              replaced: result.incomingResult.upsert.replaced,
            },
            downstream: result.nextHopResponse,
          },
          peerMetadata,
        );

        const now = new Date().toISOString();
        const pipeMetadata = deriveForwardingPipeMetadata(result.incomingResult.request);
        stateStore.setForwardingPayment({
          paymentId: result.paymentId,
          contractId: pipeMetadata.contractId,
          pipeId: pipeMetadata.pipeId,
          pipeNonce: pipeMetadata.pipeNonce,
          status: 'completed',
          incomingAmount: result.incomingAmount,
          outgoingAmount: result.outgoingAmount,
          feeAmount: result.feeAmount,
          hashedSecret: result.hashedSecret,
          revealedSecret: null,
          revealedAt: null,
          upstreamBaseUrl: result.upstreamBaseUrl,
          upstreamRevealEndpoint: result.upstreamRevealEndpoint,
          upstreamPaymentId: result.upstreamPaymentId,
          revealPropagationStatus:
            result.upstreamBaseUrl && result.upstreamPaymentId
              ? 'pending'
              : 'not-applicable',
          revealPropagationAttempts: 0,
          revealLastError: null,
          revealNextRetryAt: null,
          revealPropagatedAt: null,
          nextHopBaseUrl: result.nextHopBaseUrl,
          nextHopEndpoint: result.nextHopEndpoint,
          resultJson: responseBody,
          error: null,
          createdAt: now,
          updatedAt: now,
        });

        stateStore.setIdempotentResponse({
          endpoint: url.pathname,
          idempotencyKey: peerMetadata.idempotencyKey,
          requestHash,
          statusCode: 200,
          responseJson: responseBody,
          createdAt: now,
        });
        writeJson(response, 200, responseBody);
      } catch (error) {
        if (error instanceof ForwardingServiceError) {
          console.warn(
            `[stackflow-node] /forwarding/transfer rejected status=${error.statusCode} error=${error.message}`,
          );
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          const body = withPeerProtocolMeta(
            {
              ok: false,
              error: error.message,
              ...details,
            },
            peerMetadata,
          );

          const paymentId = extractPaymentId(payload);
          if (paymentId) {
            const now = new Date().toISOString();
            const incomingAmount =
              isRecord(payload) && typeof payload.incomingAmount !== 'undefined'
                ? String(payload.incomingAmount)
                : '0';
            const outgoingAmount =
              isRecord(payload) && typeof payload.outgoingAmount !== 'undefined'
                ? String(payload.outgoingAmount)
                : '0';
            const feeAmount =
              /^\d+$/.test(incomingAmount) && /^\d+$/.test(outgoingAmount)
                ? (BigInt(incomingAmount) - BigInt(outgoingAmount)).toString(10)
                : '0';
            const outgoing = isRecord(payload) && isRecord(payload.outgoing)
              ? payload.outgoing
              : null;
            stateStore.setForwardingPayment({
              paymentId,
              contractId: null,
              pipeId: null,
              pipeNonce: null,
              status: 'failed',
              incomingAmount,
              outgoingAmount,
              feeAmount,
              hashedSecret: extractForwardingHashedSecret(payload),
              revealedSecret: null,
              revealedAt: null,
              upstreamBaseUrl: null,
              upstreamRevealEndpoint: null,
              upstreamPaymentId: null,
              revealPropagationStatus: 'not-applicable',
              revealPropagationAttempts: 0,
              revealLastError: null,
              revealNextRetryAt: null,
              revealPropagatedAt: null,
              nextHopBaseUrl:
                outgoing && typeof outgoing.baseUrl === 'string'
                  ? outgoing.baseUrl
                  : '-',
              nextHopEndpoint:
                outgoing && typeof outgoing.endpoint === 'string'
                  ? outgoing.endpoint
                  : '/counterparty/transfer',
              resultJson: body,
              error: error.message,
              createdAt: now,
              updatedAt: now,
            });
          }

          writeJson(response, error.statusCode, body);
          return;
        }

        console.error(
          `[stackflow-node] /forwarding/transfer error: ${
            error instanceof Error ? error.message : 'failed to process forwarding transfer'
          }`,
        );
        writeJson(response, 500, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'failed to process forwarding transfer',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/forwarding/reveal') {
      let peerMetadata: PeerRequestMetadata;
      try {
        peerMetadata = parsePeerRequestMetadata(request);
      } catch (error) {
        if (error instanceof PeerProtocolError) {
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            reason: error.reason,
          });
          return;
        }
        writeJson(response, 400, {
          ok: false,
          error: 'invalid peer protocol headers',
          reason: 'invalid-peer-protocol',
        });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const requestHash = hashRequestPayload(payload);
        const existing = stateStore.getIdempotentResponse(
          url.pathname,
          peerMetadata.idempotencyKey,
        );

        if (existing) {
          if (existing.requestHash !== requestHash) {
            writeJson(
              response,
              409,
              withPeerProtocolMeta(
                {
                  ok: false,
                  error: 'idempotency key reuse with different payload',
                  reason: 'idempotency-key-reused',
                },
                peerMetadata,
              ),
            );
            return;
          }

          writeJson(
            response,
            existing.statusCode,
            existing.responseJson,
            { 'x-stackflow-idempotency-replay': 'true' },
          );
          return;
        }

        const rateLimit = consumeWriteRateLimit(request);
        if (rateLimit.limited) {
          writeJson(
            response,
            429,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'write rate limit exceeded',
                reason: 'rate-limit-exceeded',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
              },
              peerMetadata,
            ),
            { 'retry-after': String(rateLimit.retryAfterSeconds) },
          );
          return;
        }

        if (!isRecord(payload)) {
          writeJson(
            response,
            400,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'payload must be an object',
                reason: 'invalid-payload',
              },
              peerMetadata,
            ),
          );
          return;
        }

        const paymentId =
          typeof payload.paymentId === 'string' ? payload.paymentId.trim() : '';
        if (!paymentId) {
          writeJson(
            response,
            400,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'paymentId is required',
                reason: 'missing-payment-id',
              },
              peerMetadata,
            ),
          );
          return;
        }

        const existingPayment = stateStore.getForwardingPayment(paymentId);
        if (!existingPayment) {
          writeJson(
            response,
            404,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'forwarding payment not found',
                reason: 'payment-not-found',
              },
              peerMetadata,
            ),
          );
          return;
        }

        if (!existingPayment.hashedSecret) {
          writeJson(
            response,
            409,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'payment does not use hashed secret',
                reason: 'payment-without-hashed-secret',
              },
              peerMetadata,
            ),
          );
          return;
        }

        const reveal = forwardingService.verifyRevealSecret({
          hashedSecret: existingPayment.hashedSecret,
          secret: payload.secret,
        });

        if (
          existingPayment.revealedSecret &&
          existingPayment.revealedSecret !== reveal.secret
        ) {
          writeJson(
            response,
            409,
            withPeerProtocolMeta(
              {
                ok: false,
                error: 'payment already revealed with a different secret',
                reason: 'reveal-secret-mismatch',
              },
              peerMetadata,
            ),
          );
          return;
        }

        const now = new Date().toISOString();
        stateStore.setForwardingPayment({
          ...existingPayment,
          revealedSecret: reveal.secret,
          revealedAt: now,
          updatedAt: now,
        });

        const propagatedPayment = await propagateReveal({
          payment: {
            ...existingPayment,
            revealedSecret: reveal.secret,
            revealedAt: now,
            updatedAt: now,
          },
          secret: reveal.secret,
          trigger: 'api',
        });

        const responseBody = withPeerProtocolMeta(
          {
            ok: true,
            paymentId,
            hashedSecret: reveal.hashedSecret,
            secretRevealed: true,
            revealedAt: now,
            revealPropagationStatus: propagatedPayment.revealPropagationStatus,
            revealPropagationAttempts: propagatedPayment.revealPropagationAttempts,
            revealNextRetryAt: propagatedPayment.revealNextRetryAt,
            revealLastError: propagatedPayment.revealLastError,
            revealPropagatedAt: propagatedPayment.revealPropagatedAt,
          },
          peerMetadata,
        );

        stateStore.setIdempotentResponse({
          endpoint: url.pathname,
          idempotencyKey: peerMetadata.idempotencyKey,
          requestHash,
          statusCode: 200,
          responseJson: responseBody,
          createdAt: now,
        });
        writeJson(response, 200, responseBody);
      } catch (error) {
        if (error instanceof ForwardingServiceError) {
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          writeJson(
            response,
            error.statusCode,
            withPeerProtocolMeta(
              {
                ok: false,
                error: error.message,
                ...details,
              },
              peerMetadata,
            ),
          );
          return;
        }

        writeJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'failed to reveal secret',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/new_block') {
      const sourceCheck = isObserverSourceAllowed(request, observerIngressPolicy);
      if (!sourceCheck.allowed) {
        console.warn(
          `[stackflow-node] /new_block rejected status=403 reason=observer-source-not-allowed sourceIp=${
            sourceCheck.sourceIp ?? '-'
          }`,
        );
        writeJson(response, 403, {
          ok: false,
          error: 'observer source not allowed',
          reason: 'observer-source-not-allowed',
        });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        console.log(
          `[stackflow-node] /new_block received ${summarizeNewBlockPayload(payload)}`,
        );
        if (logRawEvents) {
          const samples = extractRawStackflowPrintEventSamples(
            payload,
            watchedContracts,
          );
          console.log(
            `[stackflow-node] /new_block raw stackflow events count=${samples.length}`,
          );
          for (const [index, sample] of samples.entries()) {
            console.log(
              `[stackflow-node] /new_block raw stackflow event[${index}] ${stringifyForLog(sample)}`,
            );
          }
        }
        const result = await stackflowNode.ingest(payload, url.pathname);
        console.log(
          `[stackflow-node] /new_block processed observedEvents=${result.observedEvents} activeClosures=${result.activeClosures}`,
        );
        writeJson(response, 200, { ok: true, ...result });
      } catch (error) {
        console.error(
          `[stackflow-node] /new_block error: ${
            error instanceof Error ? error.message : 'failed to ingest payload'
          }`,
        );
        writeJson(response, 400, {
          ok: false,
          error:
            error instanceof Error ? error.message : 'failed to ingest payload',
        });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/new_burn_block') {
      const sourceCheck = isObserverSourceAllowed(request, observerIngressPolicy);
      if (!sourceCheck.allowed) {
        console.warn(
          `[stackflow-node] /new_burn_block rejected status=403 reason=observer-source-not-allowed sourceIp=${
            sourceCheck.sourceIp ?? '-'
          }`,
        );
        writeJson(response, 403, {
          ok: false,
          error: 'observer source not allowed',
          reason: 'observer-source-not-allowed',
        });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const burnBlockHeight = extractBurnBlockHeight(payload);

        if (!burnBlockHeight) {
          console.warn('[stackflow-node] /new_burn_block ignored: missing burn block height');
          writeJson(response, 200, {
            ok: true,
            ignored: true,
            route: url.pathname,
            reason: 'missing-burn-block-height',
          });
          return;
        }

        const result = await stackflowNode.ingestBurnBlock(burnBlockHeight, url.pathname);
        writeJson(response, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        console.error(
          `[stackflow-node] /new_burn_block error: ${
            error instanceof Error ? error.message : 'failed to process burn block'
          }`,
        );
        writeJson(response, 200, {
          ok: false,
          ignored: true,
          route: url.pathname,
          error:
            error instanceof Error
              ? error.message
              : 'failed to process burn block',
        });
      }
      return;
    }

    if (method === 'POST' && STACKS_NODE_COMPAT_ROUTES.has(url.pathname)) {
      try {
        await discardBody(request);
      } catch {
        // Keep compatibility responses permissive to avoid observer retries.
      }

      writeJson(response, 200, {
        ok: true,
        ignored: true,
        route: url.pathname,
      });
      return;
    }

    writeJson(response, 404, {
      ok: false,
      error: 'route not found',
    });
  };
}

async function start(): Promise<void> {
  const config = loadConfig();
  const stateStore = new SqliteStateStore({
    dbFile: config.dbFile,
    maxRecentEvents: config.maxRecentEvents,
  });

  stateStore.load();

  const disputeExecutor: DisputeExecutor = (() => {
    if (config.disputeExecutorMode === 'noop') {
      return new NoopDisputeExecutor();
    }

    if (config.disputeExecutorMode === 'mock') {
      return new MockDisputeExecutor();
    }

    return config.disputeSignerKey
      ? new StacksDisputeExecutor(config)
      : new NoopDisputeExecutor();
  })();

  const signatureVerifier: SignatureVerifier = (() => {
    if (config.signatureVerifierMode === 'accept-all') {
      return new AcceptAllSignatureVerifier();
    }

    if (config.signatureVerifierMode === 'reject-all') {
      return new RejectAllSignatureVerifier();
    }

    return new ReadOnlySignatureVerifier(config);
  })();

  const counterpartySigner = createCounterpartySigner(config);
  await counterpartySigner.ensureReady();
  const effectiveWatchedPrincipals = (() => {
    const counterpartyPrincipal = counterpartySigner.counterpartyPrincipal;
    if (config.watchedPrincipals.length === 0) {
      return counterpartyPrincipal ? [counterpartyPrincipal] : [];
    }

    if (!counterpartyPrincipal) {
      return config.watchedPrincipals;
    }

    return Array.from(
      new Set([...config.watchedPrincipals, counterpartyPrincipal]),
    );
  })();

  const stackflowNode = new StackflowNode({
    stateStore,
    watchedContracts: config.watchedContracts,
    watchedPrincipals: effectiveWatchedPrincipals,
    disputeExecutor,
    disputeOnlyBeneficial: config.disputeOnlyBeneficial,
    signatureVerifier,
  });
  const counterpartyService = new CounterpartyService({
    stackflowNode,
    signer: counterpartySigner,
  });
  const forwardingService = new ForwardingService({
    counterpartyService,
    config: {
      enabled: config.forwardingEnabled,
      minFee: config.forwardingMinFee,
      timeoutMs: config.forwardingTimeoutMs,
      allowPrivateDestinations: config.forwardingAllowPrivateDestinations,
      allowedBaseUrls: config.forwardingAllowedBaseUrls,
    },
  });

  const propagateReveal = async ({
    payment,
    secret,
    trigger,
  }: {
    payment: ForwardingPaymentRecord;
    secret: string;
    trigger: 'api' | 'retry';
  }): Promise<ForwardingPaymentRecord> =>
    propagateRevealForPayment({
      payment,
      secret,
      trigger,
      forwardingService,
      stateStore,
      retryIntervalMs: config.forwardingRevealRetryIntervalMs,
      maxAttempts: config.forwardingRevealRetryMaxAttempts,
    });

  const observerIngressPolicy = buildObserverIngressPolicy({
    observerLocalhostOnly: config.observerLocalhostOnly,
    observerAllowedIps: config.observerAllowedIps,
  });
  const sensitiveReadPolicy: SensitiveReadPolicy = {
    adminToken: config.adminReadToken,
    localhostOnlyWithoutToken: config.adminReadLocalhostOnly,
    redactWithoutToken: config.redactSensitiveReadData,
    trustProxy: config.trustProxy,
  };

  const startedAt = new Date().toISOString();
  const server = http.createServer(
    createHandler({
      stackflowNode,
      stateStore,
      counterpartyService,
      forwardingService,
      propagateReveal,
      startedAt,
      disputeEnabled: disputeExecutor.enabled,
      signerAddress: disputeExecutor.signerAddress,
      counterpartyEnabled: counterpartyService.enabled,
      counterpartyPrincipal: counterpartyService.counterpartyPrincipal,
      stacksNetwork: config.stacksNetwork,
      watchedContracts: config.watchedContracts,
      logRawEvents: config.logRawEvents,
      peerWriteRateLimitPerMinute: config.peerWriteRateLimitPerMinute,
      trustProxy: config.trustProxy,
      observerIngressPolicy,
      sensitiveReadPolicy,
      forwardingAllowPrivateDestinations: config.forwardingAllowPrivateDestinations,
    }),
  );

  let retryPassRunning = false;
  const runRevealRetryPass = async (): Promise<void> => {
    if (retryPassRunning) {
      return;
    }
    retryPassRunning = true;
    try {
      const nowIso = new Date().toISOString();
      const due = stateStore.listForwardingRevealRetriesDue(
        nowIso,
        FORWARDING_REVEAL_RETRY_BATCH_SIZE,
      );
      if (due.length === 0) {
        return;
      }

      console.log(
        `[stackflow-node] reveal retry pass due=${due.length} intervalMs=${config.forwardingRevealRetryIntervalMs}`,
      );
      for (const payment of due) {
        if (!payment.revealedSecret) {
          const updated = {
            ...payment,
            revealPropagationStatus: 'failed' as const,
            revealPropagationAttempts: payment.revealPropagationAttempts + 1,
            revealLastError: 'missing revealed secret',
            revealNextRetryAt: null,
            revealPropagatedAt: null,
            updatedAt: new Date().toISOString(),
          };
          stateStore.setForwardingPayment(updated);
          console.warn(
            `[stackflow-node] reveal retry paymentId=${payment.paymentId} failed: missing revealed secret`,
          );
          continue;
        }

        await propagateReveal({
          payment,
          secret: payment.revealedSecret,
          trigger: 'retry',
        });
      }
    } finally {
      retryPassRunning = false;
    }
  };

  const retryInterval = setInterval(() => {
    void runRevealRetryPass().catch((error) => {
      console.error(
        `[stackflow-node] reveal retry pass error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, config.forwardingRevealRetryIntervalMs);
  retryInterval.unref();
  setTimeout(() => {
    void runRevealRetryPass().catch((error) => {
      console.error(
        `[stackflow-node] reveal startup retry pass error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, 200).unref();

  server.listen(config.port, config.host, () => {
    const watchedContracts =
      config.watchedContracts.length > 0
        ? config.watchedContracts.join(', ')
        : '[auto: any *.stackflow* contract]';
    const watchedPrincipals =
      effectiveWatchedPrincipals.length > 0
        ? effectiveWatchedPrincipals.join(', ')
        : '[auto: any principal]';
    const observerPolicyDescription =
      observerIngressPolicy.allowedIps.size > 0
        ? `allowlist(${[...observerIngressPolicy.allowedIps].join(',')})`
        : observerIngressPolicy.localhostOnly
          ? 'localhost-only'
          : 'unrestricted';
    const adminReadPolicyDescription = config.adminReadToken
      ? 'token-required'
      : config.adminReadLocalhostOnly
        ? 'localhost-only'
        : 'unrestricted';
    const publicBind = isPublicBindHost(config.host);

    console.log(
      `[stackflow-node] listening on http://${config.host}:${config.port} ` +
        `contracts=${watchedContracts} db=${config.dbFile} ` +
        `principals=${watchedPrincipals} disputes=${disputeExecutor.enabled ? 'enabled' : 'disabled'} ` +
        `dispute-mode=${config.disputeExecutorMode} verifier-mode=${config.signatureVerifierMode} ` +
        `counterparty-signer-mode=${config.counterpartySignerMode} ` +
        `peer-write-rpm=${config.peerWriteRateLimitPerMinute} trust-proxy=${config.trustProxy} ` +
        `public-bind=${publicBind} ` +
        `observer-source-policy=${observerPolicyDescription} ` +
        `admin-read-policy=${adminReadPolicyDescription} admin-read-redaction=${config.redactSensitiveReadData} ` +
        `forwarding=${forwardingService.enabled ? 'enabled' : 'disabled'} forwarding-min-fee=${config.forwardingMinFee} forwarding-allow-private=${config.forwardingAllowPrivateDestinations} ` +
        `forwarding-reveal-retry-ms=${config.forwardingRevealRetryIntervalMs} forwarding-reveal-max-attempts=${config.forwardingRevealRetryMaxAttempts} ` +
        `counterparty-signing=${counterpartyService.enabled ? 'enabled' : 'disabled'} counterparty-principal=${
          counterpartyService.counterpartyPrincipal ?? '-'
        }`,
    );

    if (config.signatureVerifierMode !== 'readonly') {
      console.warn(
        `[stackflow-node] non-readonly signature verifier mode active: ${config.signatureVerifierMode}`,
      );
    }

    if (config.disputeExecutorMode !== 'auto') {
      console.warn(
        `[stackflow-node] non-auto dispute executor mode active: ${config.disputeExecutorMode}`,
      );
    }

    if (config.logRawEvents) {
      console.warn('[stackflow-node] raw stackflow event logging is enabled');
    }

    if (publicBind) {
      console.warn(
        '[stackflow-node] public bind host in use; require TLS termination, authentication, and source/IP controls at ingress',
      );
      if (!config.adminReadToken && !config.adminReadLocalhostOnly) {
        console.warn(
          '[stackflow-node] sensitive read endpoints are unrestricted on a public bind host; configure STACKFLOW_NODE_ADMIN_READ_TOKEN or localhost-only mode',
        );
      }
      if (!config.observerLocalhostOnly && observerIngressPolicy.allowedIps.size === 0) {
        console.warn(
          '[stackflow-node] observer endpoints are unrestricted on a public bind host; configure STACKFLOW_NODE_OBSERVER_ALLOWED_IPS',
        );
      }
    }

    if (config.trustProxy) {
      console.warn(
        '[stackflow-node] trust-proxy mode enabled; x-forwarded-for is used for rate-limit and admin-localhost checks',
      );
    }

    if (config.adminReadToken) {
      console.warn(
        '[stackflow-node] admin read token configured for sensitive inspection endpoints',
      );
    }

    if (counterpartySigner.counterpartyPrincipal) {
      if (config.watchedPrincipals.length === 0) {
        console.warn(
          `[stackflow-node] STACKFLOW_NODE_PRINCIPALS is empty; restricting watchlist to counterparty principal ${counterpartySigner.counterpartyPrincipal}`,
        );
      } else if (!config.watchedPrincipals.includes(counterpartySigner.counterpartyPrincipal)) {
        console.warn(
          `[stackflow-node] added counterparty principal to watchlist: ${counterpartySigner.counterpartyPrincipal}`,
        );
      }
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`[stackflow-node] received ${signal}, shutting down`);
    clearInterval(retryInterval);
    server.close(() => {
      stateStore.close();
      console.log('[stackflow-node] shutdown complete');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[stackflow-node] forced shutdown timeout reached');
      stateStore.close();
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  console.error(
    `[stackflow-node] fatal startup error: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
