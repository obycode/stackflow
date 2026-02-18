import { createHash } from 'node:crypto';

import { createNetwork } from '@stacks/network';
import {
  ClarityType,
  bufferCV,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  noneCV,
  principalCV,
  signStructuredData,
  someCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';

import {
  canonicalPipeKey,
  hexToBytes,
  isValidHex,
  normalizeHex,
  parseOptionalUInt,
  parsePrincipal,
  parseUInt,
  splitContractId,
} from './principal-utils.js';
import { normalizePipeId } from './observer-parser.js';
import { describeStackflowContractError } from './signature-verifier.js';
import type {
  ProducerSignerMode,
  SignatureStateUpsertResult,
  SignatureVerificationResult,
  SignatureVerifierMode,
  WatchtowerConfig,
} from './types.js';
import {
  PrincipalNotWatchedError,
  SignatureValidationError,
  Watchtower,
} from './watchtower.js';

const ACTION_CLOSE = '0';
const ACTION_TRANSFER = '1';
const ACTION_DEPOSIT = '2';
const ACTION_WITHDRAWAL = '3';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContractId(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ProducerServiceError(400, 'contractId must be a non-empty string');
  }

  const contractId = input.trim();
  try {
    splitContractId(contractId);
  } catch {
    throw new ProducerServiceError(400, 'invalid contractId');
  }
  return contractId;
}

function normalizeToken(input: unknown): string | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  try {
    return parsePrincipal(input, 'token');
  } catch (error) {
    throw new ProducerServiceError(
      400,
      error instanceof Error ? error.message : 'token must be a principal',
    );
  }
}

function normalizeHexBuff(input: unknown, bytes: number, fieldName: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ProducerServiceError(400, `${fieldName} must be a hex string`);
  }

  const value = input.trim().toLowerCase();
  if (!isValidHex(value, bytes)) {
    throw new ProducerServiceError(400, `${fieldName} must be ${bytes} bytes of hex`);
  }

  return value.startsWith('0x') ? value : `0x${value}`;
}

function normalizeOptionalHexBuff(
  input: unknown,
  bytes: number,
  fieldName: string,
): string | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  return normalizeHexBuff(input, bytes, fieldName);
}

function normalizeBool(input: unknown, fallback: boolean): boolean {
  if (input === undefined || input === null || input === '') {
    return fallback;
  }

  if (typeof input === 'boolean') {
    return input;
  }

  const normalized = String(input).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new ProducerServiceError(400, 'beneficialOnly must be a boolean');
}

function chainIdForNetwork(network: WatchtowerConfig['stacksNetwork']): bigint {
  if (network === 'mainnet') {
    return 1n;
  }
  return 2_147_483_648n;
}

function senderAddressForPrincipal(principal: string): string {
  if (principal.includes('.')) {
    return splitContractId(principal).address;
  }
  return principal;
}

function parsePrincipalField(value: unknown, fieldName: string): string {
  try {
    return parsePrincipal(value, fieldName);
  } catch (error) {
    throw new ProducerServiceError(
      400,
      error instanceof Error
        ? error.message
        : `${fieldName} must be a principal string`,
    );
  }
}

function parseUIntField(value: unknown, fieldName: string): string {
  try {
    return parseUInt(value);
  } catch {
    throw new ProducerServiceError(400, `${fieldName} must be a uint`);
  }
}

function parseOptionalUIntField(value: unknown, fieldName: string): string | null {
  try {
    return parseOptionalUInt(value);
  } catch {
    throw new ProducerServiceError(400, `${fieldName} must be a uint`);
  }
}

type ProducerStateSource = 'onchain' | 'signature-state';

interface ProducerStateBaseline {
  source: ProducerStateSource;
  nonce: string;
  nonceValue: bigint;
  myBalance: string;
  myBalanceValue: bigint;
  theirBalance: string;
  theirBalanceValue: bigint;
  updatedAt: string;
}

function parseUnsignedBigInt(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function shouldReplaceBaseline(
  existing: ProducerStateBaseline,
  incoming: ProducerStateBaseline,
): boolean {
  if (incoming.nonceValue !== existing.nonceValue) {
    return incoming.nonceValue > existing.nonceValue;
  }

  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt;
  }

  if (incoming.source !== existing.source) {
    return incoming.source === 'onchain';
  }

  return false;
}

export interface ProducerSignRequest {
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
  secret: string | null;
  validAfter: string | null;
  beneficialOnly: boolean;
}

interface ParseProducerSignRequestOptions {
  producerPrincipal: string;
  allowedActions: Set<string>;
  defaultAction: string | null;
}

function parseProducerSignRequest(
  input: unknown,
  options: ParseProducerSignRequestOptions,
): ProducerSignRequest {
  if (!isRecord(input)) {
    throw new ProducerServiceError(400, 'payload must be an object');
  }

  const data = input;
  const forPrincipalInput = data.forPrincipal;
  if (forPrincipalInput !== undefined && forPrincipalInput !== null && forPrincipalInput !== '') {
    const parsedForPrincipal = parsePrincipalField(forPrincipalInput, 'forPrincipal');
    if (parsedForPrincipal !== options.producerPrincipal) {
      throw new ProducerServiceError(
        400,
        `forPrincipal must match producer principal ${options.producerPrincipal}`,
      );
    }
  }

  const actionInput =
    data.action !== undefined && data.action !== null && data.action !== ''
      ? data.action
      : options.defaultAction;
  if (actionInput === null) {
    throw new ProducerServiceError(400, 'action is required');
  }

  const action = parseUIntField(actionInput, 'action');
  if (!options.allowedActions.has(action)) {
    throw new ProducerServiceError(
      400,
      `action ${action} is not allowed for this endpoint`,
    );
  }

  const amount =
    action === ACTION_DEPOSIT || action === ACTION_WITHDRAWAL
      ? parseUIntField(data.amount, 'amount')
      : parseOptionalUIntField(data.amount, 'amount') || '0';

  return {
    contractId: normalizeContractId(data.contractId),
    forPrincipal: options.producerPrincipal,
    withPrincipal: parsePrincipalField(data.withPrincipal, 'withPrincipal'),
    token: normalizeToken(data.token),
    amount,
    myBalance: parseUIntField(data.myBalance, 'myBalance'),
    theirBalance: parseUIntField(data.theirBalance, 'theirBalance'),
    theirSignature: normalizeHexBuff(
      data.theirSignature ?? data.counterpartySignature,
      65,
      'theirSignature',
    ),
    nonce: parseUIntField(data.nonce, 'nonce'),
    action,
    actor: parsePrincipalField(data.actor, 'actor'),
    secret: normalizeOptionalHexBuff(data.secret, 32, 'secret'),
    validAfter: parseOptionalUIntField(data.validAfter, 'validAfter'),
    beneficialOnly: normalizeBool(data.beneficialOnly, false),
  };
}

export interface ProducerSigner {
  readonly enabled: boolean;
  readonly producerPrincipal: string | null;
  readonly signerAddress: string | null;
  verifyCounterpartySignature(
    request: ProducerSignRequest,
  ): Promise<SignatureVerificationResult>;
  signMySignature(request: ProducerSignRequest): string;
}

export class ProducerStateSigner implements ProducerSigner {
  readonly enabled: boolean;

  readonly producerPrincipal: string | null;

  readonly signerAddress: string | null;

  private readonly producerKey: string | null;

  private readonly network: ReturnType<typeof createNetwork>;

  private readonly signatureVerifierMode: SignatureVerifierMode;

  private readonly stackflowMessageVersion: string;

  private readonly stacksNetwork: WatchtowerConfig['stacksNetwork'];

  constructor(
    config: Pick<
      WatchtowerConfig,
      | 'stacksNetwork'
      | 'stacksApiUrl'
      | 'signatureVerifierMode'
      | 'producerKey'
      | 'producerPrincipal'
      | 'stackflowMessageVersion'
    >,
  ) {
    this.network = createNetwork({
      network: config.stacksNetwork,
      client: config.stacksApiUrl ? { baseUrl: config.stacksApiUrl } : undefined,
    });

    this.signatureVerifierMode = config.signatureVerifierMode;
    this.stackflowMessageVersion = config.stackflowMessageVersion;
    this.stacksNetwork = config.stacksNetwork;
    this.producerKey = config.producerKey
      ? normalizeHex(config.producerKey).slice(2)
      : null;
    this.signerAddress = this.producerKey
      ? getAddressFromPrivateKey(this.producerKey, this.network)
      : null;
    this.enabled = Boolean(this.producerKey);

    if (!this.enabled) {
      this.producerPrincipal = null;
      return;
    }

    if (config.producerPrincipal?.trim()) {
      const parsedProducerPrincipal = parsePrincipal(
        config.producerPrincipal,
        'WATCHTOWER_PRODUCER_PRINCIPAL',
      );
      if (
        !parsedProducerPrincipal.includes('.') &&
        parsedProducerPrincipal !== this.signerAddress
      ) {
        throw new Error(
          `WATCHTOWER_PRODUCER_PRINCIPAL (${parsedProducerPrincipal}) does not match producer key address (${this.signerAddress})`,
        );
      }
      this.producerPrincipal = parsedProducerPrincipal;
      return;
    }

    this.producerPrincipal = this.signerAddress;
  }

  async verifyCounterpartySignature(
    request: ProducerSignRequest,
  ): Promise<SignatureVerificationResult> {
    if (!this.enabled || !this.producerPrincipal) {
      return { valid: false, reason: 'producer signing is not configured' };
    }

    if (request.forPrincipal !== this.producerPrincipal) {
      return {
        valid: false,
        reason: `forPrincipal must be ${this.producerPrincipal}`,
      };
    }

    if (this.signatureVerifierMode === 'accept-all') {
      return { valid: true, reason: null };
    }
    if (this.signatureVerifierMode === 'reject-all') {
      return { valid: false, reason: 'invalid-signature' };
    }

    const contract = splitContractId(request.contractId);
    const pipeKey = canonicalPipeKey(
      request.token,
      request.forPrincipal,
      request.withPrincipal,
    );
    const balance1 =
      pipeKey['principal-1'] === request.forPrincipal
        ? request.myBalance
        : request.theirBalance;
    const balance2 =
      pipeKey['principal-1'] === request.forPrincipal
        ? request.theirBalance
        : request.myBalance;

    const tokenArg = request.token ? someCV(principalCV(request.token)) : noneCV();
    const secretArg = request.secret
      ? someCV(bufferCV(hexToBytes(request.secret)))
      : noneCV();
    const validAfterArg = request.validAfter
      ? someCV(uintCV(BigInt(request.validAfter)))
      : noneCV();

    const response = await fetchCallReadOnlyFunction({
      network: this.network,
      senderAddress: senderAddressForPrincipal(this.producerPrincipal),
      contractAddress: contract.address,
      contractName: contract.name,
      functionName: 'verify-signature-request',
      functionArgs: [
        bufferCV(hexToBytes(request.theirSignature)),
        principalCV(request.withPrincipal),
        tupleCV({
          token: tokenArg,
          'principal-1': principalCV(pipeKey['principal-1']),
          'principal-2': principalCV(pipeKey['principal-2']),
        }),
        uintCV(BigInt(balance1)),
        uintCV(BigInt(balance2)),
        uintCV(BigInt(request.nonce)),
        uintCV(BigInt(request.action)),
        principalCV(request.actor),
        secretArg,
        validAfterArg,
        uintCV(BigInt(request.amount)),
      ],
    });

    if (response.type === ClarityType.ResponseErr) {
      if (response.value.type === ClarityType.UInt) {
        return {
          valid: false,
          reason: describeStackflowContractError(response.value.value),
        };
      }
      return { valid: false, reason: 'contract error' };
    }

    if (response.type !== ClarityType.ResponseOk) {
      return { valid: false, reason: 'unexpected-readonly-response' };
    }

    return { valid: true, reason: null };
  }

  signMySignature(request: ProducerSignRequest): string {
    if (!this.enabled || !this.producerKey || !this.producerPrincipal) {
      throw new ProducerServiceError(503, 'producer signing is not configured');
    }

    const pipeKey = canonicalPipeKey(
      request.token,
      request.forPrincipal,
      request.withPrincipal,
    );
    const balance1 =
      pipeKey['principal-1'] === request.forPrincipal
        ? request.myBalance
        : request.theirBalance;
    const balance2 =
      pipeKey['principal-1'] === request.forPrincipal
        ? request.theirBalance
        : request.myBalance;

    const hashedSecret = request.secret
      ? someCV(bufferCV(createHash('sha256').update(hexToBytes(request.secret)).digest()))
      : noneCV();
    const validAfter = request.validAfter
      ? someCV(uintCV(BigInt(request.validAfter)))
      : noneCV();
    const token = request.token ? someCV(principalCV(request.token)) : noneCV();

    const message = tupleCV({
      token,
      'principal-1': principalCV(pipeKey['principal-1']),
      'principal-2': principalCV(pipeKey['principal-2']),
      'balance-1': uintCV(BigInt(balance1)),
      'balance-2': uintCV(BigInt(balance2)),
      nonce: uintCV(BigInt(request.nonce)),
      action: uintCV(BigInt(request.action)),
      actor: principalCV(request.actor),
      'hashed-secret': hashedSecret,
      'valid-after': validAfter,
    });

    const domain = tupleCV({
      name: stringAsciiCV(request.contractId),
      version: stringAsciiCV(this.stackflowMessageVersion),
      'chain-id': uintCV(chainIdForNetwork(this.stacksNetwork)),
    });

    const signature = signStructuredData({
      message,
      domain,
      privateKey: this.producerKey,
    });
    return normalizeHex(signature);
  }
}

class UnsupportedProducerSigner implements ProducerSigner {
  readonly enabled = false;

  readonly producerPrincipal = null;

  readonly signerAddress = null;

  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async verifyCounterpartySignature(
    _request: ProducerSignRequest,
  ): Promise<SignatureVerificationResult> {
    return {
      valid: false,
      reason: this.reason,
    };
  }

  signMySignature(_request: ProducerSignRequest): string {
    throw new ProducerServiceError(503, this.reason);
  }
}

export function createProducerSigner(
  config: Pick<
    WatchtowerConfig,
    | 'stacksNetwork'
    | 'stacksApiUrl'
    | 'signatureVerifierMode'
    | 'producerKey'
    | 'producerPrincipal'
    | 'producerSignerMode'
    | 'stackflowMessageVersion'
  >,
): ProducerSigner {
  const mode = (config.producerSignerMode || 'local-key') as ProducerSignerMode;

  if (mode === 'kms') {
    return new UnsupportedProducerSigner(
      'WATCHTOWER_PRODUCER_SIGNER_MODE=kms is not implemented yet',
    );
  }

  return new ProducerStateSigner(config);
}

export interface ProducerSignResult {
  request: ProducerSignRequest;
  mySignature: string;
  upsert: SignatureStateUpsertResult;
}

export class ProducerService {
  private readonly watchtower: Watchtower;

  private readonly signer: ProducerSigner;

  constructor({ watchtower, signer }: { watchtower: Watchtower; signer: ProducerSigner }) {
    this.watchtower = watchtower;
    this.signer = signer;
  }

  get enabled(): boolean {
    return this.signer.enabled;
  }

  get producerPrincipal(): string | null {
    return this.signer.producerPrincipal;
  }

  async signTransfer(payload: unknown): Promise<ProducerSignResult> {
    return this.signState(payload, new Set([ACTION_TRANSFER]), ACTION_TRANSFER);
  }

  async signSignatureRequest(payload: unknown): Promise<ProducerSignResult> {
    return this.signState(
      payload,
      new Set([ACTION_CLOSE, ACTION_DEPOSIT, ACTION_WITHDRAWAL]),
      null,
    );
  }

  private resolveCurrentBaseline(
    request: ProducerSignRequest,
  ): ProducerStateBaseline | null {
    const pipeKey = canonicalPipeKey(
      request.token,
      request.forPrincipal,
      request.withPrincipal,
    );
    const pipeId = normalizePipeId(pipeKey);
    if (!pipeId) {
      return null;
    }

    const status = this.watchtower.status();
    let best: ProducerStateBaseline | null = null;

    const consider = (candidate: ProducerStateBaseline): void => {
      if (!best || shouldReplaceBaseline(best, candidate)) {
        best = candidate;
      }
    };

    for (const observed of status.observedPipes) {
      if (observed.contractId !== request.contractId || observed.pipeId !== pipeId) {
        continue;
      }

      const principal1IsProducer = observed.pipeKey['principal-1'] === request.forPrincipal;
      const myBalance = principal1IsProducer ? observed.balance1 : observed.balance2;
      const theirBalance = principal1IsProducer ? observed.balance2 : observed.balance1;
      const nonceValue = parseUnsignedBigInt(observed.nonce);
      const myBalanceValue = parseUnsignedBigInt(myBalance);
      const theirBalanceValue = parseUnsignedBigInt(theirBalance);
      if (
        nonceValue === null ||
        myBalanceValue === null ||
        theirBalanceValue === null
      ) {
        continue;
      }

      consider({
        source: 'onchain',
        nonce: observed.nonce as string,
        nonceValue,
        myBalance: myBalance as string,
        myBalanceValue,
        theirBalance: theirBalance as string,
        theirBalanceValue,
        updatedAt: observed.updatedAt,
      });
    }

    for (const signature of status.signatureStates) {
      if (
        signature.contractId !== request.contractId ||
        signature.pipeId !== pipeId ||
        signature.forPrincipal !== request.forPrincipal
      ) {
        continue;
      }

      const nonceValue = parseUnsignedBigInt(signature.nonce);
      const myBalanceValue = parseUnsignedBigInt(signature.myBalance);
      const theirBalanceValue = parseUnsignedBigInt(signature.theirBalance);
      if (
        nonceValue === null ||
        myBalanceValue === null ||
        theirBalanceValue === null
      ) {
        continue;
      }

      consider({
        source: 'signature-state',
        nonce: signature.nonce,
        nonceValue,
        myBalance: signature.myBalance,
        myBalanceValue,
        theirBalance: signature.theirBalance,
        theirBalanceValue,
        updatedAt: signature.updatedAt,
      });
    }

    return best;
  }

  private enforceSigningPolicy(request: ProducerSignRequest): void {
    const baseline = this.resolveCurrentBaseline(request);
    if (!baseline) {
      throw new ProducerServiceError(409, 'unknown-pipe-state', {
        reason: 'unknown-pipe-state',
      });
    }

    const incomingNonce = BigInt(request.nonce);
    if (incomingNonce <= baseline.nonceValue) {
      throw new ProducerServiceError(409, 'nonce-too-low', {
        reason: 'nonce-too-low',
        incomingNonce: request.nonce,
        existingNonce: baseline.nonce,
        state: {
          source: baseline.source,
          nonce: baseline.nonce,
          myBalance: baseline.myBalance,
          theirBalance: baseline.theirBalance,
          updatedAt: baseline.updatedAt,
        },
      });
    }

    const requestedMyBalance = BigInt(request.myBalance);
    const requestedTheirBalance = BigInt(request.theirBalance);

    if (requestedMyBalance < baseline.myBalanceValue) {
      throw new ProducerServiceError(403, 'producer-balance-decrease-not-allowed', {
        reason: 'producer-balance-decrease',
        currentMyBalance: baseline.myBalance,
        requestedMyBalance: request.myBalance,
      });
    }

    if (request.action === ACTION_TRANSFER) {
      const currentTotal = baseline.myBalanceValue + baseline.theirBalanceValue;
      const requestedTotal = requestedMyBalance + requestedTheirBalance;
      if (requestedTotal !== currentTotal) {
        throw new ProducerServiceError(403, 'invalid-transfer-total', {
          reason: 'invalid-transfer-total',
          currentTotal: currentTotal.toString(10),
          requestedTotal: requestedTotal.toString(10),
        });
      }

      if (requestedMyBalance <= baseline.myBalanceValue) {
        throw new ProducerServiceError(403, 'transfer-not-beneficial-for-producer', {
          reason: 'transfer-not-beneficial',
          currentMyBalance: baseline.myBalance,
          requestedMyBalance: request.myBalance,
        });
      }
    }
  }

  private async signState(
    payload: unknown,
    allowedActions: Set<string>,
    defaultAction: string | null,
  ): Promise<ProducerSignResult> {
    if (!this.signer.producerPrincipal) {
      throw new ProducerServiceError(503, 'producer signing is not configured');
    }

    const request = parseProducerSignRequest(payload, {
      producerPrincipal: this.signer.producerPrincipal,
      allowedActions,
      defaultAction,
    });

    this.enforceSigningPolicy(request);

    const verification = await this.signer.verifyCounterpartySignature(request);
    if (!verification.valid) {
      throw new ProducerServiceError(
        401,
        verification.reason || 'counterparty signature invalid',
      );
    }

    const mySignature = this.signer.signMySignature(request);

    try {
      const upsert = await this.watchtower.upsertSignatureState({
        contractId: request.contractId,
        forPrincipal: request.forPrincipal,
        withPrincipal: request.withPrincipal,
        token: request.token,
        amount: request.amount,
        myBalance: request.myBalance,
        theirBalance: request.theirBalance,
        mySignature,
        theirSignature: request.theirSignature,
        nonce: request.nonce,
        action: request.action,
        actor: request.actor,
        secret: request.secret,
        validAfter: request.validAfter,
        beneficialOnly: request.beneficialOnly,
      }, {
        skipVerification: true,
      });

      return {
        request,
        mySignature,
        upsert,
      };
    } catch (error) {
      if (error instanceof SignatureValidationError) {
        throw new ProducerServiceError(401, error.message);
      }

      if (error instanceof PrincipalNotWatchedError) {
        throw new ProducerServiceError(403, error.message);
      }

      throw error;
    }
  }
}

export class ProducerServiceError extends Error {
  readonly statusCode: number;

  readonly details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ProducerServiceError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
