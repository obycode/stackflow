import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

import {
  isValidHex,
  normalizeHex,
  parsePrincipal,
  parseUInt,
  splitContractId,
} from './principal-utils.js';
import {
  CounterpartyService,
  CounterpartyServiceError,
  type CounterpartySignResult,
} from './counterparty-service.js';
import type { ForwardingPaymentRecord } from './types.js';

const PEER_PROTOCOL_VERSION = '1';
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const NEXT_HOP_TRANSFER_ENDPOINT = '/counterparty/transfer';
const UPSTREAM_REVEAL_ENDPOINT = '/forwarding/reveal';
const TRANSFER_PAYLOAD_ALLOWED_FIELDS = new Set([
  'contractId',
  'forPrincipal',
  'withPrincipal',
  'token',
  'amount',
  'myBalance',
  'theirBalance',
  'theirSignature',
  'counterpartySignature',
  'nonce',
  'action',
  'actor',
  'hashedSecret',
  'secret',
  'validAfter',
  'beneficialOnly',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new ForwardingServiceError(400, 'invalid-next-hop-base-url', {
      reason: 'invalid-next-hop-base-url',
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ForwardingServiceError(400, 'invalid-next-hop-base-url', {
      reason: 'invalid-next-hop-base-url',
    });
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalizeEndpoint(input: unknown): string {
  if (input === undefined || input === null || input === '') {
    return NEXT_HOP_TRANSFER_ENDPOINT;
  }
  if (typeof input !== 'string') {
    throw new ForwardingServiceError(400, 'invalid-next-hop-endpoint', {
      reason: 'invalid-next-hop-endpoint',
    });
  }
  const value = input.trim();
  if (!value.startsWith('/')) {
    throw new ForwardingServiceError(400, 'invalid-next-hop-endpoint', {
      reason: 'invalid-next-hop-endpoint',
    });
  }
  if (value !== NEXT_HOP_TRANSFER_ENDPOINT) {
    throw new ForwardingServiceError(400, 'unsupported-next-hop-endpoint', {
      reason: 'unsupported-next-hop-endpoint',
      endpoint: value,
      supportedEndpoint: NEXT_HOP_TRANSFER_ENDPOINT,
    });
  }
  return value;
}

function normalizeRevealEndpoint(input: unknown): string {
  if (input === undefined || input === null || input === '') {
    return UPSTREAM_REVEAL_ENDPOINT;
  }
  if (typeof input !== 'string') {
    throw new ForwardingServiceError(400, 'invalid-upstream-reveal-endpoint', {
      reason: 'invalid-upstream-reveal-endpoint',
    });
  }
  const value = input.trim();
  if (!value.startsWith('/')) {
    throw new ForwardingServiceError(400, 'invalid-upstream-reveal-endpoint', {
      reason: 'invalid-upstream-reveal-endpoint',
    });
  }
  if (value !== UPSTREAM_REVEAL_ENDPOINT) {
    throw new ForwardingServiceError(400, 'unsupported-upstream-reveal-endpoint', {
      reason: 'unsupported-upstream-reveal-endpoint',
      endpoint: value,
      supportedEndpoint: UPSTREAM_REVEAL_ENDPOINT,
    });
  }
  return value;
}

function normalizeId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ForwardingServiceError(400, `${fieldName} must be a string`, {
      reason: `invalid-${fieldName}`,
    });
  }
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > MAX_ID_LENGTH ||
    !ID_PATTERN.test(normalized)
  ) {
    throw new ForwardingServiceError(
      400,
      `${fieldName} must be 8-128 chars [a-zA-Z0-9._:-]`,
      { reason: `invalid-${fieldName}` },
    );
  }
  return normalized;
}

function parseAmount(value: unknown, field: string): string {
  try {
    return parseUInt(value);
  } catch {
    throw new ForwardingServiceError(400, `${field} must be a uint`, {
      reason: `invalid-${field}`,
    });
  }
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

function isPrivateOrNonPublicIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      return true;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
    if (a === 198 && (b === 18 || b === 19)) {
      return true;
    }
    if (a >= 224) {
      return true;
    }
    return false;
  }

  if (net.isIP(ip) === 6) {
    if (ip === '::' || ip === '::1') {
      return true;
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return true;
    }
    if (
      ip.startsWith('fe8') ||
      ip.startsWith('fe9') ||
      ip.startsWith('fea') ||
      ip.startsWith('feb')
    ) {
      return true;
    }
    if (ip.startsWith('ff')) {
      return true;
    }
    return false;
  }

  return true;
}

async function resolveHostnameIps(hostname: string): Promise<string[]> {
  const direct = normalizeIpAddress(hostname);
  if (direct) {
    return [direct];
  }

  const resolved = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  const unique = new Set<string>();
  for (const entry of resolved) {
    const normalized = normalizeIpAddress(entry.address);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

async function enforcePublicDestination(
  baseUrl: string,
  allowPrivateDestinations: boolean,
  destinationLabel: 'next-hop' | 'upstream-reveal',
): Promise<void> {
  if (allowPrivateDestinations) {
    return;
  }

  const parsed = new URL(baseUrl);
  if (parsed.hostname.toLowerCase() === 'localhost') {
    throw new ForwardingServiceError(403, `${destinationLabel} destination must be public`, {
      reason: `${destinationLabel}-private-destination`,
    });
  }

  let ips: string[];
  try {
    ips = await resolveHostnameIps(parsed.hostname);
  } catch {
    throw new ForwardingServiceError(502, `${destinationLabel} hostname resolution failed`, {
      reason: `${destinationLabel}-dns-failed`,
    });
  }

  if (ips.length === 0) {
    throw new ForwardingServiceError(502, `${destinationLabel} hostname resolution failed`, {
      reason: `${destinationLabel}-dns-failed`,
    });
  }

  if (ips.some((ip) => isPrivateOrNonPublicIp(ip))) {
    throw new ForwardingServiceError(403, `${destinationLabel} destination must be public`, {
      reason: `${destinationLabel}-private-destination`,
    });
  }
}

function validateTransferPayloadShape(
  payload: Record<string, unknown>,
  label: string,
): void {
  for (const key of Object.keys(payload)) {
    if (!TRANSFER_PAYLOAD_ALLOWED_FIELDS.has(key)) {
      throw new ForwardingServiceError(400, `${label} contains unsupported field: ${key}`, {
        reason: 'invalid-transfer-payload',
      });
    }
  }

  if (typeof payload.contractId !== 'string' || payload.contractId.trim() === '') {
    throw new ForwardingServiceError(400, `${label}.contractId is required`, {
      reason: 'invalid-transfer-payload',
    });
  }
  try {
    splitContractId(payload.contractId.trim());
  } catch {
    throw new ForwardingServiceError(400, `${label}.contractId is invalid`, {
      reason: 'invalid-transfer-payload',
    });
  }

  try {
    parsePrincipal(payload.forPrincipal, `${label}.forPrincipal`);
    parsePrincipal(payload.withPrincipal, `${label}.withPrincipal`);
    parsePrincipal(payload.actor, `${label}.actor`);
  } catch (error) {
    throw new ForwardingServiceError(
      400,
      error instanceof Error ? error.message : `${label} has invalid principal fields`,
      { reason: 'invalid-transfer-payload' },
    );
  }

  parseAmount(payload.myBalance, `${label}.myBalance`);
  parseAmount(payload.theirBalance, `${label}.theirBalance`);
  parseAmount(payload.nonce, `${label}.nonce`);

  const action = parseAmount(
    payload.action === undefined ? '1' : payload.action,
    `${label}.action`,
  );
  if (action !== '1') {
    throw new ForwardingServiceError(400, `${label}.action must be 1`, {
      reason: 'invalid-transfer-payload',
    });
  }

  if (payload.amount !== undefined) {
    parseAmount(payload.amount, `${label}.amount`);
  }
  if (payload.validAfter !== undefined && payload.validAfter !== null && payload.validAfter !== '') {
    parseAmount(payload.validAfter, `${label}.validAfter`);
  }
  if (payload.token !== undefined && payload.token !== null && payload.token !== '') {
    try {
      parsePrincipal(payload.token, `${label}.token`);
    } catch (error) {
      throw new ForwardingServiceError(
        400,
        error instanceof Error ? error.message : `${label}.token is invalid`,
        { reason: 'invalid-transfer-payload' },
      );
    }
  }

  const signatureValue =
    typeof payload.theirSignature === 'string'
      ? payload.theirSignature
      : payload.counterpartySignature;
  if (typeof signatureValue !== 'string' || !isValidHex(signatureValue, 65)) {
    throw new ForwardingServiceError(400, `${label}.theirSignature must be 65-byte hex`, {
      reason: 'invalid-transfer-payload',
    });
  }
}

function buildProtocolSeed(paymentId: string): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${paymentId.slice(0, 32)}-${timestamp}-${rand}`.slice(0, MAX_ID_LENGTH);
}

interface ForwardTransferRequest {
  paymentId: string;
  incomingAmount: string;
  outgoingAmount: string;
  hashedSecret: string;
  nextHopBaseUrl: string;
  nextHopEndpoint: string;
  nextHopPayload: Record<string, unknown>;
  incomingPayload: Record<string, unknown>;
  upstreamBaseUrl: string | null;
  upstreamRevealEndpoint: string | null;
  upstreamPaymentId: string | null;
}

export interface ForwardTransferResult {
  paymentId: string;
  incomingAmount: string;
  outgoingAmount: string;
  feeAmount: string;
  hashedSecret: string;
  nextHopBaseUrl: string;
  nextHopEndpoint: string;
  upstreamBaseUrl: string | null;
  upstreamRevealEndpoint: string | null;
  upstreamPaymentId: string | null;
  incomingResult: CounterpartySignResult;
  nextHopResponse: Record<string, unknown>;
}

function normalizeHashedSecret(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ForwardingServiceError(400, 'hashedSecret is required', {
      reason: 'missing-hashed-secret',
    });
  }

  const normalized = normalizeHex(value);
  if (!isValidHex(normalized, 32)) {
    throw new ForwardingServiceError(400, 'hashedSecret must be 32-byte hex', {
      reason: 'invalid-hashed-secret',
    });
  }
  return normalized;
}

function sha256Hex(hexValue: string): string {
  const bytes = Buffer.from(normalizeHex(hexValue).slice(2), 'hex');
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

interface ForwardingServiceConfig {
  enabled: boolean;
  minFee: string;
  timeoutMs: number;
  allowPrivateDestinations: boolean;
  allowedBaseUrls: string[];
}

export class ForwardingService {
  private readonly counterpartyService: CounterpartyService;

  private readonly enabledValue: boolean;

  private readonly minFee: bigint;

  private readonly timeoutMs: number;

  private readonly allowPrivateDestinations: boolean;

  private readonly allowedBaseUrls: Set<string>;

  constructor({
    counterpartyService,
    config,
  }: {
    counterpartyService: CounterpartyService;
    config: ForwardingServiceConfig;
  }) {
    this.counterpartyService = counterpartyService;
    this.enabledValue = config.enabled;
    this.minFee = BigInt(config.minFee);
    this.timeoutMs = config.timeoutMs;
    this.allowPrivateDestinations = config.allowPrivateDestinations;
    this.allowedBaseUrls = new Set(config.allowedBaseUrls.map(normalizeBaseUrl));
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  async processTransfer(payload: unknown): Promise<ForwardTransferResult> {
    if (!this.enabledValue) {
      throw new ForwardingServiceError(404, 'forwarding is not enabled', {
        reason: 'forwarding-disabled',
      });
    }

    if (!this.counterpartyService.enabled || !this.counterpartyService.counterpartyPrincipal) {
      throw new ForwardingServiceError(503, 'counterparty signing is not configured', {
        reason: 'counterparty-signing-disabled',
      });
    }

    const request = this.parseRequest(payload);
    const incomingAmount = BigInt(request.incomingAmount);
    const outgoingAmount = BigInt(request.outgoingAmount);
    if (outgoingAmount > incomingAmount) {
      throw new ForwardingServiceError(403, 'forwarding fee would be negative', {
        reason: 'negative-forwarding-fee',
      });
    }
    const feeAmount = incomingAmount - outgoingAmount;
    if (feeAmount < this.minFee) {
      throw new ForwardingServiceError(403, 'forwarding fee below minimum', {
        reason: 'forwarding-fee-too-low',
        feeAmount: feeAmount.toString(10),
        minFee: this.minFee.toString(10),
      });
    }

    if (
      this.allowedBaseUrls.size > 0 &&
      !this.allowedBaseUrls.has(request.nextHopBaseUrl)
    ) {
      throw new ForwardingServiceError(403, 'next hop base url is not allowed', {
        reason: 'next-hop-not-allowed',
      });
    }

    const nextHopResponse = await this.requestNextHopSignature(request);
    const incomingResult = await this.counterpartyService.signTransfer(
      request.incomingPayload,
    );

    return {
      paymentId: request.paymentId,
      incomingAmount: request.incomingAmount,
      outgoingAmount: request.outgoingAmount,
      feeAmount: feeAmount.toString(10),
      hashedSecret: request.hashedSecret,
      nextHopBaseUrl: request.nextHopBaseUrl,
      nextHopEndpoint: request.nextHopEndpoint,
      upstreamBaseUrl: request.upstreamBaseUrl,
      upstreamRevealEndpoint: request.upstreamRevealEndpoint,
      upstreamPaymentId: request.upstreamPaymentId,
      incomingResult,
      nextHopResponse,
    };
  }

  private parseRequest(payload: unknown): ForwardTransferRequest {
    if (!isRecord(payload)) {
      throw new ForwardingServiceError(400, 'payload must be an object', {
        reason: 'invalid-payload',
      });
    }

    const paymentId = normalizeId(payload.paymentId, 'payment-id');
    const incomingAmount = parseAmount(payload.incomingAmount, 'incomingAmount');
    const outgoingAmount = parseAmount(payload.outgoingAmount, 'outgoingAmount');
    const hashedSecret = normalizeHashedSecret(payload.hashedSecret);

    const incoming = payload.incoming;
    if (!isRecord(incoming)) {
      throw new ForwardingServiceError(400, 'incoming payload is required', {
        reason: 'invalid-incoming-payload',
      });
    }

    const outgoing = payload.outgoing;
    if (!isRecord(outgoing)) {
      throw new ForwardingServiceError(400, 'outgoing payload is required', {
        reason: 'invalid-outgoing-payload',
      });
    }

    if (!isRecord(outgoing.payload)) {
      throw new ForwardingServiceError(400, 'outgoing.payload must be an object', {
        reason: 'invalid-outgoing-payload',
      });
    }

    const upstream = payload.upstream;
    let upstreamBaseUrl: string | null = null;
    let upstreamRevealEndpoint: string | null = null;
    let upstreamPaymentId: string | null = null;
    if (upstream !== undefined && upstream !== null) {
      if (!isRecord(upstream)) {
        throw new ForwardingServiceError(400, 'upstream must be an object', {
          reason: 'invalid-upstream',
        });
      }

      if (typeof upstream.baseUrl !== 'string' || upstream.baseUrl.trim() === '') {
        throw new ForwardingServiceError(400, 'upstream.baseUrl is required', {
          reason: 'invalid-upstream-base-url',
        });
      }
      upstreamBaseUrl = normalizeBaseUrl(upstream.baseUrl);
      upstreamRevealEndpoint = normalizeRevealEndpoint(upstream.revealEndpoint);
      upstreamPaymentId = normalizeId(
        upstream.paymentId,
        'upstream-payment-id',
      );
    }

    const normalizePayload = (
      value: Record<string, unknown>,
      label: string,
    ): Record<string, unknown> => {
      const out = { ...value };
      const providedHashed =
        typeof out.hashedSecret === 'string' && out.hashedSecret.trim() !== ''
          ? normalizeHashedSecret(out.hashedSecret)
          : null;
      const providedSecret =
        typeof out.secret === 'string' && out.secret.trim() !== ''
          ? normalizeHex(out.secret)
          : null;

      if (providedHashed && providedHashed !== hashedSecret) {
        throw new ForwardingServiceError(400, `${label}.hashedSecret mismatch`, {
          reason: 'hashed-secret-mismatch',
        });
      }

      if (providedSecret && providedSecret !== hashedSecret) {
        throw new ForwardingServiceError(400, `${label}.secret must equal hashedSecret`, {
          reason: 'hashed-secret-mismatch',
        });
      }

      out.hashedSecret = hashedSecret;
      out.secret = hashedSecret;
      validateTransferPayloadShape(out, label);
      return out;
    };

    return {
      paymentId,
      incomingAmount,
      outgoingAmount,
      hashedSecret,
      nextHopBaseUrl: normalizeBaseUrl(String(outgoing.baseUrl || '')),
      nextHopEndpoint: normalizeEndpoint(outgoing.endpoint),
      nextHopPayload: normalizePayload(outgoing.payload, 'outgoing.payload'),
      incomingPayload: normalizePayload(incoming, 'incoming'),
      upstreamBaseUrl,
      upstreamRevealEndpoint,
      upstreamPaymentId,
    };
  }

  private async requestNextHopSignature(
    request: ForwardTransferRequest,
  ): Promise<Record<string, unknown>> {
    const seed = buildProtocolSeed(request.paymentId);
    const url = `${request.nextHopBaseUrl}${request.nextHopEndpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await enforcePublicDestination(
        request.nextHopBaseUrl,
        this.allowPrivateDestinations,
        'next-hop',
      );

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-stackflow-protocol-version': PEER_PROTOCOL_VERSION,
          'x-stackflow-request-id': `fwd-req-${seed}`.slice(0, MAX_ID_LENGTH),
          'idempotency-key': `fwd-idem-${seed}`.slice(0, MAX_ID_LENGTH),
        },
        body: JSON.stringify(request.nextHopPayload),
        signal: controller.signal,
      });

      const body = await response.json().catch(() => ({}));
      if (!isRecord(body)) {
        throw new ForwardingServiceError(502, 'next hop returned invalid body', {
          reason: 'next-hop-invalid-body',
          statusCode: response.status,
        });
      }

      if (!response.ok) {
        throw new ForwardingServiceError(502, 'next hop rejected forwarding transfer', {
          reason: 'next-hop-rejected',
          statusCode: response.status,
        });
      }

      if (typeof body.mySignature !== 'string') {
        throw new ForwardingServiceError(502, 'next hop did not return mySignature', {
          reason: 'next-hop-missing-signature',
          statusCode: response.status,
        });
      }

      return body;
    } catch (error) {
      if (error instanceof ForwardingServiceError) {
        throw error;
      }
      if (error instanceof CounterpartyServiceError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ForwardingServiceError(504, 'next hop request timed out', {
          reason: 'next-hop-timeout',
        });
      }
      throw new ForwardingServiceError(502, 'failed to reach next hop', {
        reason: 'next-hop-unreachable',
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  verifyRevealSecret(args: {
    hashedSecret: string;
    secret: unknown;
  }): { secret: string; hashedSecret: string } {
    const hashedSecret = normalizeHashedSecret(args.hashedSecret);
    const secret = normalizeHashedSecret(args.secret);
    const computed = sha256Hex(secret);
    if (computed !== hashedSecret) {
      throw new ForwardingServiceError(400, 'secret does not match hashedSecret', {
        reason: 'invalid-secret-preimage',
      });
    }
    return { secret, hashedSecret };
  }

  async propagateRevealToUpstream(args: {
    payment: ForwardingPaymentRecord;
    secret: string;
    attempt: number;
  }): Promise<Record<string, unknown>> {
    const payment = args.payment;
    if (!payment.upstreamBaseUrl || !payment.upstreamPaymentId) {
      throw new ForwardingServiceError(
        400,
        'upstream payment route is not configured',
        { reason: 'upstream-route-missing' },
      );
    }

    const revealEndpoint = payment.upstreamRevealEndpoint || '/forwarding/reveal';
    const secret = normalizeHashedSecret(args.secret);
    const url = `${payment.upstreamBaseUrl}${revealEndpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const stableSeed = normalizeId(payment.paymentId, 'payment-id')
      .toLowerCase()
      .replace(/[^a-z0-9._:-]/g, '-')
      .slice(0, 80);
    const idempotencyKey = `reveal-${stableSeed}`.slice(0, MAX_ID_LENGTH);
    const requestId = `reveal-${stableSeed}-${Math.max(1, args.attempt)}`.slice(
      0,
      MAX_ID_LENGTH,
    );

    try {
      await enforcePublicDestination(
        payment.upstreamBaseUrl,
        this.allowPrivateDestinations,
        'upstream-reveal',
      );

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-stackflow-protocol-version': PEER_PROTOCOL_VERSION,
          'x-stackflow-request-id': requestId,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          paymentId: payment.upstreamPaymentId,
          secret,
        }),
        signal: controller.signal,
      });

      const body = await response.json().catch(() => ({}));
      if (!isRecord(body)) {
        throw new ForwardingServiceError(502, 'upstream reveal returned invalid body', {
          reason: 'upstream-reveal-invalid-body',
          statusCode: response.status,
        });
      }

      if (!response.ok) {
        throw new ForwardingServiceError(502, 'upstream reveal rejected', {
          reason: 'upstream-reveal-rejected',
          statusCode: response.status,
        });
      }

      return body;
    } catch (error) {
      if (error instanceof ForwardingServiceError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ForwardingServiceError(504, 'upstream reveal request timed out', {
          reason: 'upstream-reveal-timeout',
        });
      }
      throw new ForwardingServiceError(502, 'failed to reach upstream reveal endpoint', {
        reason: 'upstream-reveal-unreachable',
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ForwardingServiceError extends Error {
  readonly statusCode: number;

  readonly details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ForwardingServiceError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
