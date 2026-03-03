import 'dotenv/config';

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';

const DEFAULT_GATEWAY_HOST = '127.0.0.1';
const DEFAULT_GATEWAY_PORT = 8790;
const DEFAULT_UPSTREAM_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_STACKFLOW_NODE_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_PROTECTED_PATH = '/paid-content';
const DEFAULT_PRICE_AMOUNT = '1000';
const DEFAULT_PRICE_ASSET = 'STX';
const DEFAULT_STACKFLOW_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_PROOF_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INDIRECT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_INDIRECT_POLL_INTERVAL_MS = 1_000;
const PEER_PROTOCOL_VERSION = '1';
const HEADER_X402_PAYMENT = 'x-x402-payment';
const HEADER_PEER_PROTOCOL_VERSION = 'x-stackflow-protocol-version';
const HEADER_PEER_REQUEST_ID = 'x-stackflow-request-id';
const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';
const MAX_PROTOCOL_ID_LENGTH = 128;
const PROTOCOL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface GatewayConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  stackflowNodeBaseUrl: string;
  protectedPath: string;
  priceAmount: string;
  priceAsset: string;
  stackflowTimeoutMs: number;
  upstreamTimeoutMs: number;
  proofReplayTtlMs: number;
  indirectWaitTimeoutMs: number;
  indirectPollIntervalMs: number;
  stackflowAdminReadToken: string | null;
}

interface PeerRequestMetadata {
  requestId: string;
  idempotencyKey: string;
}

interface CounterpartyTransferProof {
  contractId: string;
  forPrincipal: string;
  withPrincipal: string;
  token: string | null;
  amount: string;
  myBalance: string;
  theirBalance: string;
  theirSignature: string;
  nonce: string;
  action: string;
  actor: string;
  hashedSecret: string | null;
  validAfter: string | null;
  beneficialOnly: boolean;
}

interface DirectGatewayPaymentProof {
  mode: 'direct';
  proof: CounterpartyTransferProof;
}

interface IndirectGatewayPaymentProof {
  mode: 'indirect';
  paymentId: string;
  secret: string;
  expectedFromPrincipal: string;
}

type GatewayPaymentProof = DirectGatewayPaymentProof | IndirectGatewayPaymentProof;

interface StackflowResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

interface ForwardingPaymentLookup {
  paymentId: string;
  status: 'completed' | 'failed';
  hashedSecret: string | null;
  revealedSecret: string | null;
  upstreamWithPrincipal: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseUintString(value: unknown, fieldName: string): string {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${fieldName} must be a uint string`);
  }
  return text;
}

function parsePaymentId(value: unknown, fieldName: string): string {
  const text = String(value ?? '').trim();
  if (
    text.length < 8 ||
    text.length > MAX_PROTOCOL_ID_LENGTH ||
    !PROTOCOL_ID_PATTERN.test(text)
  ) {
    throw new Error(`${fieldName} must be 8-128 chars [a-zA-Z0-9._:-]`);
  }
  return text;
}

function parseHex32(value: unknown, fieldName: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  const normalized = text.startsWith('0x') ? text : `0x${text}`;
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} must be 32-byte hex`);
  }
  return normalized;
}

function normalizeBaseUrl(input: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must use http/https`);
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalizePath(input: string, fieldName: string): string {
  const text = input.trim();
  if (!text.startsWith('/')) {
    throw new Error(`${fieldName} must start with /`);
  }
  return text;
}

function normalizeProtocolId(value: string, fallbackPrefix: string): string {
  const candidate = value.trim();
  if (
    candidate.length >= 8 &&
    candidate.length <= MAX_PROTOCOL_ID_LENGTH &&
    PROTOCOL_ID_PATTERN.test(candidate)
  ) {
    return candidate;
  }

  const generated = `${fallbackPrefix}-${randomUUID().replace(/-/g, '')}`.slice(
    0,
    MAX_PROTOCOL_ID_LENGTH,
  );
  return generated;
}

function readHeaderValue(request: IncomingMessage, headerName: string): string | null {
  const value = request.headers[headerName];
  if (Array.isArray(value)) {
    return value.find((item) => item.trim().length > 0)?.trim() || null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parsePaymentProofHeader(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${HEADER_X402_PAYMENT} is empty`);
  }

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  return JSON.parse(decodeBase64Url(trimmed));
}

function toOptionalStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') {
    return true;
  }
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') {
    return false;
  }
  return fallback;
}

function buildCounterpartyTransferProof(
  value: unknown,
  config: GatewayConfig,
): CounterpartyTransferProof {
  if (!isRecord(value)) {
    throw new Error('payment proof must be a JSON object');
  }

  const contractId = String(value.contractId ?? '').trim();
  const forPrincipal = String(value.forPrincipal ?? '').trim();
  const withPrincipal = String(value.withPrincipal ?? '').trim();
  const actor = String(value.actor ?? '').trim();
  const theirSignature = String(
    (value.theirSignature ?? value.counterpartySignature) ?? '',
  ).trim();
  const amount = parseUintString(value.amount, 'amount');

  if (!contractId) {
    throw new Error('contractId is required');
  }
  if (!forPrincipal) {
    throw new Error('forPrincipal is required');
  }
  if (!withPrincipal) {
    throw new Error('withPrincipal is required');
  }
  if (!actor) {
    throw new Error('actor is required');
  }
  if (!theirSignature) {
    throw new Error('theirSignature is required');
  }

  if (BigInt(amount) < BigInt(config.priceAmount)) {
    throw new Error(
      `amount must be >= configured price (${config.priceAmount} ${config.priceAsset})`,
    );
  }

  const action =
    value.action === undefined || value.action === null || value.action === ''
      ? '1'
      : parseUintString(value.action, 'action');
  if (action !== '1') {
    throw new Error('direct x402 payment proof must use action=1');
  }

  const token = toOptionalStringOrNull(value.token);
  const hashedSecret = toOptionalStringOrNull(value.hashedSecret);
  const validAfter = toOptionalStringOrNull(value.validAfter);

  return {
    contractId,
    forPrincipal,
    withPrincipal,
    token,
    amount,
    myBalance: parseUintString(value.myBalance, 'myBalance'),
    theirBalance: parseUintString(value.theirBalance, 'theirBalance'),
    theirSignature,
    nonce: parseUintString(value.nonce, 'nonce'),
    action,
    actor,
    hashedSecret,
    validAfter,
    beneficialOnly: toBoolean(value.beneficialOnly, false),
  };
}

function parseExpectedFromPrincipal(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error('expectedFromPrincipal is required');
  }
  return text;
}

function buildGatewayPaymentProof(
  value: unknown,
  config: GatewayConfig,
): GatewayPaymentProof {
  if (!isRecord(value)) {
    throw new Error('payment proof must be a JSON object');
  }

  const mode = String(value.mode ?? '').trim().toLowerCase();
  if (mode === 'indirect') {
    return {
      mode: 'indirect',
      paymentId: parsePaymentId(value.paymentId, 'paymentId'),
      secret: parseHex32(value.secret, 'secret'),
      expectedFromPrincipal: parseExpectedFromPrincipal(
        value.expectedFromPrincipal ?? value.fromPrincipal,
      ),
    };
  }

  const directSource =
    mode === 'direct' && isRecord(value.proof) ? value.proof : value;
  return {
    mode: 'direct',
    proof: buildCounterpartyTransferProof(directSource, config),
  };
}

function buildStackflowTransferPayload(proof: CounterpartyTransferProof): Record<string, unknown> {
  return {
    contractId: proof.contractId,
    forPrincipal: proof.forPrincipal,
    withPrincipal: proof.withPrincipal,
    token: proof.token,
    amount: proof.amount,
    myBalance: proof.myBalance,
    theirBalance: proof.theirBalance,
    theirSignature: proof.theirSignature,
    nonce: proof.nonce,
    action: proof.action,
    actor: proof.actor,
    hashedSecret: proof.hashedSecret,
    validAfter: proof.validAfter,
    beneficialOnly: proof.beneficialOnly,
  };
}

function buildProofHash(
  method: string,
  routeBinding: string,
  proof: GatewayPaymentProof,
): string {
  const proofPayload =
    proof.mode === 'direct'
      ? {
          mode: proof.mode,
          proof: buildStackflowTransferPayload(proof.proof),
        }
      : {
          mode: proof.mode,
          paymentId: proof.paymentId,
          secret: proof.secret,
          expectedFromPrincipal: proof.expectedFromPrincipal,
        };
  return createHash('sha256')
    .update(method.toUpperCase())
    .update('\n')
    .update(routeBinding)
    .update('\n')
    .update(JSON.stringify(proofPayload))
    .digest('hex');
}

function buildPeerMetadata(
  request: IncomingMessage,
  proofHash: string,
  suffix: string,
): PeerRequestMetadata {
  const requestIdHeader = readHeaderValue(request, HEADER_PEER_REQUEST_ID);
  const requestId = normalizeProtocolId(
    requestIdHeader || '',
    `x402-gw-${suffix}-req-${proofHash.slice(0, 12)}`,
  );
  const idempotencyKey = normalizeProtocolId(
    `x402-gw-${suffix}-idem-${proofHash.slice(0, 64)}`,
    `x402-gw-${suffix}-idem`,
  );
  return { requestId, idempotencyKey };
}

function filterRequestHeaders(
  request: IncomingMessage,
  proofHash: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalizedKey) ||
      normalizedKey === 'host' ||
      normalizedKey === 'content-length' ||
      normalizedKey === HEADER_X402_PAYMENT
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0) {
        headers[key] = value.join(', ');
      }
      continue;
    }
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }

  headers['x-stackflow-x402-verified'] = 'true';
  headers['x-stackflow-x402-proof-hash'] = proofHash;
  return headers;
}

function filterResponseHeaders(upstreamResponse: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headers[key] = value;
  });

  const withSetCookie = upstreamResponse.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookie = withSetCookie.getSetCookie?.();
  if (setCookie && setCookie.length > 0) {
    headers['set-cookie'] = setCookie;
  }
  return headers;
}

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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function formatX402AuthenticateHeader(config: GatewayConfig): string {
  return `X402 realm="stackflow", amount="${config.priceAmount}", asset="${config.priceAsset}", path="${config.protectedPath}"`;
}

function writePaymentRequired(
  response: ServerResponse,
  config: GatewayConfig,
  reason: string,
  details: string,
): void {
  writeJson(
    response,
    402,
    {
      ok: false,
      error: 'payment required',
      reason,
      details,
      payment: {
        scheme: 'x402-stackflow-v1',
        header: HEADER_X402_PAYMENT,
        amount: config.priceAmount,
        asset: config.priceAsset,
        protectedPath: config.protectedPath,
        modes: {
          direct: {
            action: '1',
            requiredFields: [
              'contractId',
              'forPrincipal',
              'withPrincipal',
              'amount',
              'myBalance',
              'theirBalance',
              'theirSignature',
              'nonce',
              'actor',
            ],
          },
          indirect: {
            requiredFields: ['mode', 'paymentId', 'secret', 'expectedFromPrincipal'],
          },
        },
      },
    },
    {
      'www-authenticate': formatX402AuthenticateHeader(config),
    },
  );
}

async function callStackflowCounterpartyTransfer(args: {
  config: GatewayConfig;
  payload: Record<string, unknown>;
  peer: PeerRequestMetadata;
}): Promise<StackflowResponse> {
  const { config, payload, peer } = args;
  const url = `${config.stackflowNodeBaseUrl}/counterparty/transfer`;
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      [HEADER_PEER_PROTOCOL_VERSION]: PEER_PROTOCOL_VERSION,
      [HEADER_PEER_REQUEST_ID]: peer.requestId,
      [HEADER_IDEMPOTENCY_KEY]: peer.idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.stackflowTimeoutMs),
  });

  const body = await response
    .json()
    .catch(() => ({ ok: false, error: 'stackflow node returned non-json response' }));

  return {
    statusCode: response.status,
    body: isRecord(body)
      ? body
      : { ok: false, error: 'stackflow node returned invalid JSON body' },
  };
}

function buildStackflowAdminHeaders(
  stackflowAdminReadToken: string | null,
): Record<string, string> {
  if (!stackflowAdminReadToken) {
    return {};
  }
  return {
    authorization: `Bearer ${stackflowAdminReadToken}`,
    'x-stackflow-admin-token': stackflowAdminReadToken,
  };
}

function extractForwardingPaymentLookup(value: unknown): ForwardingPaymentLookup | null {
  if (!isRecord(value)) {
    return null;
  }

  const paymentId = typeof value.paymentId === 'string' ? value.paymentId : null;
  const status = value.status;
  if (
    !paymentId ||
    (status !== 'completed' && status !== 'failed')
  ) {
    return null;
  }

  const resultJson = isRecord(value.resultJson) ? value.resultJson : null;
  const upstream = resultJson && isRecord(resultJson.upstream) ? resultJson.upstream : null;
  const upstreamWithPrincipal =
    upstream && typeof upstream.withPrincipal === 'string'
      ? upstream.withPrincipal
      : null;

  return {
    paymentId,
    status,
    hashedSecret: typeof value.hashedSecret === 'string' ? value.hashedSecret : null,
    revealedSecret: typeof value.revealedSecret === 'string' ? value.revealedSecret : null,
    upstreamWithPrincipal,
  };
}

async function fetchForwardingPayment(args: {
  config: GatewayConfig;
  paymentId: string;
}): Promise<ForwardingPaymentLookup | null> {
  const { config, paymentId } = args;
  const query = new URLSearchParams({ paymentId });
  const response = await fetch(
    `${config.stackflowNodeBaseUrl}/forwarding/payments?${query.toString()}`,
    {
      method: 'GET',
      redirect: 'error',
      headers: {
        ...buildStackflowAdminHeaders(config.stackflowAdminReadToken),
      },
      signal: AbortSignal.timeout(config.stackflowTimeoutMs),
    },
  );

  const body = await response
    .json()
    .catch(() => ({ ok: false, error: 'stackflow node returned non-json response' }));

  if (!response.ok) {
    const bodyError =
      isRecord(body) && typeof body.error === 'string' ? body.error : 'lookup failed';
    throw new Error(
      `forwarding payment lookup failed (status=${response.status}, error=${bodyError})`,
    );
  }

  if (!isRecord(body)) {
    throw new Error('forwarding payment lookup returned invalid JSON body');
  }

  return extractForwardingPaymentLookup(body.payment);
}

async function callStackflowForwardingReveal(args: {
  config: GatewayConfig;
  paymentId: string;
  secret: string;
  peer: PeerRequestMetadata;
}): Promise<StackflowResponse> {
  const { config, paymentId, secret, peer } = args;
  const url = `${config.stackflowNodeBaseUrl}/forwarding/reveal`;
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      [HEADER_PEER_PROTOCOL_VERSION]: PEER_PROTOCOL_VERSION,
      [HEADER_PEER_REQUEST_ID]: peer.requestId,
      [HEADER_IDEMPOTENCY_KEY]: peer.idempotencyKey,
    },
    body: JSON.stringify({
      paymentId,
      secret,
    }),
    signal: AbortSignal.timeout(config.stackflowTimeoutMs),
  });

  const body = await response
    .json()
    .catch(() => ({ ok: false, error: 'stackflow node returned non-json response' }));

  return {
    statusCode: response.status,
    body: isRecord(body)
      ? body
      : { ok: false, error: 'stackflow node returned invalid JSON body' },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForIndirectPayment(args: {
  config: GatewayConfig;
  proof: IndirectGatewayPaymentProof;
}): Promise<ForwardingPaymentLookup> {
  const { config, proof } = args;
  const deadline = Date.now() + config.indirectWaitTimeoutMs;
  let lastError: string | null = null;

  while (Date.now() <= deadline) {
    let payment: ForwardingPaymentLookup | null = null;
    try {
      payment = await fetchForwardingPayment({ config, paymentId: proof.paymentId });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (Date.now() <= deadline) {
        await sleep(config.indirectPollIntervalMs);
      }
      continue;
    }

    if (!payment) {
      await sleep(config.indirectPollIntervalMs);
      continue;
    }

    if (payment.status === 'failed') {
      throw new Error('indirect payment exists but is marked failed');
    }

    if (!payment.upstreamWithPrincipal) {
      throw new Error('indirect payment missing upstream payer metadata');
    }
    if (payment.upstreamWithPrincipal !== proof.expectedFromPrincipal) {
      throw new Error(
        `indirect payment came from ${payment.upstreamWithPrincipal}, expected ${proof.expectedFromPrincipal}`,
      );
    }
    if (!payment.hashedSecret) {
      throw new Error('indirect payment does not include a hashed secret');
    }

    return payment;
  }

  throw new Error(
    `timed out waiting for indirect payment ${proof.paymentId}${
      lastError ? ` (last-error=${lastError})` : ''
    }`,
  );
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = (env.STACKFLOW_X402_GATEWAY_HOST || DEFAULT_GATEWAY_HOST).trim();
  const port = Math.max(
    1,
    parseInteger(env.STACKFLOW_X402_GATEWAY_PORT, DEFAULT_GATEWAY_PORT),
  );
  const upstreamBaseUrl = normalizeBaseUrl(
    env.STACKFLOW_X402_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL,
    'STACKFLOW_X402_UPSTREAM_BASE_URL',
  );
  const stackflowNodeBaseUrl = normalizeBaseUrl(
    env.STACKFLOW_X402_STACKFLOW_NODE_BASE_URL || DEFAULT_STACKFLOW_NODE_BASE_URL,
    'STACKFLOW_X402_STACKFLOW_NODE_BASE_URL',
  );
  const protectedPath = normalizePath(
    env.STACKFLOW_X402_PROTECTED_PATH || DEFAULT_PROTECTED_PATH,
    'STACKFLOW_X402_PROTECTED_PATH',
  );
  const priceAmount = parseUintString(
    env.STACKFLOW_X402_PRICE_AMOUNT || DEFAULT_PRICE_AMOUNT,
    'STACKFLOW_X402_PRICE_AMOUNT',
  );
  const priceAsset = String(env.STACKFLOW_X402_PRICE_ASSET || DEFAULT_PRICE_ASSET).trim();
  if (priceAsset.length === 0) {
    throw new Error('STACKFLOW_X402_PRICE_ASSET must not be empty');
  }
  const stackflowAdminReadToken =
    env.STACKFLOW_X402_STACKFLOW_ADMIN_READ_TOKEN?.trim() ||
    env.STACKFLOW_NODE_ADMIN_READ_TOKEN?.trim() ||
    null;

  return {
    host,
    port,
    upstreamBaseUrl,
    stackflowNodeBaseUrl,
    protectedPath,
    priceAmount,
    priceAsset,
    stackflowTimeoutMs: Math.max(
      1_000,
      parseInteger(env.STACKFLOW_X402_STACKFLOW_TIMEOUT_MS, DEFAULT_STACKFLOW_TIMEOUT_MS),
    ),
    upstreamTimeoutMs: Math.max(
      1_000,
      parseInteger(env.STACKFLOW_X402_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),
    ),
    proofReplayTtlMs: Math.max(
      1_000,
      parseInteger(env.STACKFLOW_X402_PROOF_REPLAY_TTL_MS, DEFAULT_PROOF_REPLAY_TTL_MS),
    ),
    indirectWaitTimeoutMs: Math.max(
      1_000,
      parseInteger(
        env.STACKFLOW_X402_INDIRECT_WAIT_TIMEOUT_MS,
        DEFAULT_INDIRECT_WAIT_TIMEOUT_MS,
      ),
    ),
    indirectPollIntervalMs: Math.max(
      200,
      parseInteger(
        env.STACKFLOW_X402_INDIRECT_POLL_INTERVAL_MS,
        DEFAULT_INDIRECT_POLL_INTERVAL_MS,
      ),
    ),
    stackflowAdminReadToken,
  };
}

async function proxyToUpstream(args: {
  request: IncomingMessage;
  response: ServerResponse;
  config: GatewayConfig;
  proofHash: string;
}): Promise<void> {
  const { request, response, config, proofHash } = args;
  const method = (request.method || 'GET').toUpperCase();
  const path = request.url || '/';
  const targetUrl = new URL(path, config.upstreamBaseUrl);

  const bodyAllowed = method !== 'GET' && method !== 'HEAD';
  const body = bodyAllowed ? await readBody(request) : undefined;
  const headers = filterRequestHeaders(request, proofHash);

  const upstreamResponse = await fetch(targetUrl, {
    method,
    redirect: 'manual',
    headers,
    body,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(upstreamResponse.status, filterResponseHeaders(upstreamResponse));
  response.end(responseBody);
}

async function proxyWithoutPayment(args: {
  request: IncomingMessage;
  response: ServerResponse;
  config: GatewayConfig;
}): Promise<void> {
  const { request, response, config } = args;
  const method = (request.method || 'GET').toUpperCase();
  const path = request.url || '/';
  const targetUrl = new URL(path, config.upstreamBaseUrl);
  const bodyAllowed = method !== 'GET' && method !== 'HEAD';
  const body = bodyAllowed ? await readBody(request) : undefined;
  const headers = filterRequestHeaders(request, 'unpaid-route');
  delete headers['x-stackflow-x402-verified'];
  delete headers['x-stackflow-x402-proof-hash'];

  const upstreamResponse = await fetch(targetUrl, {
    method,
    redirect: 'manual',
    headers,
    body,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(upstreamResponse.status, filterResponseHeaders(upstreamResponse));
  response.end(responseBody);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const consumedProofs = new Map<string, number>();

  const pruneConsumedProofs = (): void => {
    const now = Date.now();
    for (const [key, expiresAt] of consumedProofs.entries()) {
      if (expiresAt <= now) {
        consumedProofs.delete(key);
      }
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      pruneConsumedProofs();
      const method = (request.method || 'GET').toUpperCase();
      const url = new URL(request.url || '/', 'http://localhost');
      const routeBinding = `${url.pathname}${url.search}`;

      if (method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, { ok: true, service: 'x402-gateway' });
        return;
      }

      if (url.pathname !== config.protectedPath) {
        await proxyWithoutPayment({ request, response, config });
        return;
      }

      const paymentHeader = readHeaderValue(request, HEADER_X402_PAYMENT);
      if (!paymentHeader) {
        writePaymentRequired(
          response,
          config,
          'payment-header-missing',
          `${HEADER_X402_PAYMENT} header is required`,
        );
        return;
      }

      let paymentProof: GatewayPaymentProof;
      try {
        const parsed = parsePaymentProofHeader(paymentHeader);
        paymentProof = buildGatewayPaymentProof(parsed, config);
      } catch (error) {
        writePaymentRequired(
          response,
          config,
          'invalid-payment-proof',
          error instanceof Error ? error.message : 'invalid payment proof',
        );
        return;
      }

      const proofHash = buildProofHash(method, routeBinding, paymentProof);
      const consumedUntil = consumedProofs.get(proofHash);
      if (typeof consumedUntil === 'number' && consumedUntil > Date.now()) {
        writePaymentRequired(
          response,
          config,
          'payment-proof-already-used',
          'this payment proof has already been consumed for this route/method',
        );
        return;
      }

      if (paymentProof.mode === 'direct') {
        const stackflowPayload = buildStackflowTransferPayload(paymentProof.proof);
        const peer = buildPeerMetadata(request, proofHash, 'direct');
        const stackflowResult = await callStackflowCounterpartyTransfer({
          config,
          payload: stackflowPayload,
          peer,
        });

        const stackflowAccepted =
          stackflowResult.statusCode >= 200 &&
          stackflowResult.statusCode < 300 &&
          stackflowResult.body.ok === true;
        if (!stackflowAccepted) {
          const stackflowReason =
            typeof stackflowResult.body.reason === 'string'
              ? stackflowResult.body.reason
              : typeof stackflowResult.body.error === 'string'
                ? stackflowResult.body.error
                : 'unknown';
          writePaymentRequired(
            response,
            config,
            'payment-rejected',
            `stackflow rejected direct proof (status=${stackflowResult.statusCode}, reason=${stackflowReason})`,
          );
          return;
        }
      } else {
        await waitForIndirectPayment({
          config,
          proof: paymentProof,
        });

        const revealPeer = buildPeerMetadata(request, proofHash, 'indirect-reveal');
        const revealResult = await callStackflowForwardingReveal({
          config,
          paymentId: paymentProof.paymentId,
          secret: paymentProof.secret,
          peer: revealPeer,
        });
        const revealAccepted =
          revealResult.statusCode >= 200 &&
          revealResult.statusCode < 300 &&
          revealResult.body.ok === true;
        if (!revealAccepted) {
          const revealReason =
            typeof revealResult.body.reason === 'string'
              ? revealResult.body.reason
              : typeof revealResult.body.error === 'string'
                ? revealResult.body.error
                : 'unknown';
          writePaymentRequired(
            response,
            config,
            'payment-rejected',
            `stackflow rejected indirect reveal (status=${revealResult.statusCode}, reason=${revealReason})`,
          );
          return;
        }
      }

      await proxyToUpstream({ request, response, config, proofHash });
      consumedProofs.set(proofHash, Date.now() + config.proofReplayTtlMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'gateway error';
      console.error(`[x402-gateway] request failed: ${message}`);
      writeJson(response, 502, {
        ok: false,
        error: 'x402 gateway request failed',
        details: message,
      });
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `[x402-gateway] listening on http://${config.host}:${config.port} protected-path=${config.protectedPath} ` +
        `price=${config.priceAmount} ${config.priceAsset} stackflow-node=${config.stackflowNodeBaseUrl} upstream=${config.upstreamBaseUrl} ` +
        `indirect-wait-timeout-ms=${config.indirectWaitTimeoutMs} indirect-poll-interval-ms=${config.indirectPollIntervalMs}`,
    );
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[x402-gateway] fatal error: ${message}`);
  process.exit(1);
});
