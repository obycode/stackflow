import { createHash, createPublicKey } from 'node:crypto';

import { createNetwork } from '@stacks/network';
import {
  ClarityType,
  bufferCV,
  encodeStructuredDataBytes,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  noneCV,
  principalCV,
  PubKeyEncoding,
  publicKeyFromSignatureVrs,
  publicKeyToAddressSingleSig,
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
  CounterpartySignerMode,
  SignatureStateUpsertResult,
  SignatureVerificationResult,
  SignatureVerifierMode,
  StackflowNodeConfig,
} from './types.js';
import {
  PrincipalNotWatchedError,
  SignatureValidationError,
  StackflowNode,
} from './stackflow-node.js';

const ACTION_CLOSE = '0';
const ACTION_TRANSFER = '1';
const ACTION_DEPOSIT = '2';
const ACTION_WITHDRAWAL = '3';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContractId(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CounterpartyServiceError(400, 'contractId must be a non-empty string');
  }

  const contractId = input.trim();
  try {
    splitContractId(contractId);
  } catch {
    throw new CounterpartyServiceError(400, 'invalid contractId');
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
    throw new CounterpartyServiceError(
      400,
      error instanceof Error ? error.message : 'token must be a principal',
    );
  }
}

function normalizeHexBuff(input: unknown, bytes: number, fieldName: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CounterpartyServiceError(400, `${fieldName} must be a hex string`);
  }

  const value = input.trim().toLowerCase();
  if (!isValidHex(value, bytes)) {
    throw new CounterpartyServiceError(400, `${fieldName} must be ${bytes} bytes of hex`);
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

  throw new CounterpartyServiceError(400, 'beneficialOnly must be a boolean');
}

function chainIdForNetwork(network: StackflowNodeConfig['stacksNetwork']): bigint {
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
    throw new CounterpartyServiceError(
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
    throw new CounterpartyServiceError(400, `${fieldName} must be a uint`);
  }
}

function parseOptionalUIntField(value: unknown, fieldName: string): string | null {
  try {
    return parseOptionalUInt(value);
  } catch {
    throw new CounterpartyServiceError(400, `${fieldName} must be a uint`);
  }
}

type CounterpartyStateSource = 'onchain' | 'signature-state';

interface CounterpartyStateBaseline {
  source: CounterpartyStateSource;
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
  existing: CounterpartyStateBaseline,
  incoming: CounterpartyStateBaseline,
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

interface CounterpartySigningContext {
  pipeKey: ReturnType<typeof canonicalPipeKey>;
  balance1: string;
  balance2: string;
  tokenArg: ReturnType<typeof noneCV> | ReturnType<typeof someCV>;
  secretArg: ReturnType<typeof noneCV> | ReturnType<typeof someCV>;
  validAfterArg: ReturnType<typeof noneCV> | ReturnType<typeof someCV>;
}

const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

type KmsSdkModule = {
  KMSClient: new (config?: Record<string, unknown>) => {
    send(command: unknown): Promise<unknown>;
  };
  SignCommand: new (input: Record<string, unknown>) => unknown;
  GetPublicKeyCommand: new (input: Record<string, unknown>) => unknown;
  SigningAlgorithmSpec?: {
    ECDSA_SHA_256?: string;
  };
};

let kmsSdkPromise: Promise<KmsSdkModule> | null = null;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function normalizeDerInt(value: Uint8Array): Buffer {
  let bytes = Buffer.from(value);
  while (bytes.length > 0 && bytes[0] === 0) {
    bytes = bytes.subarray(1);
  }

  if (bytes.length > 32) {
    throw new CounterpartyServiceError(503, 'invalid KMS signature component length');
  }

  if (bytes.length === 32) {
    return bytes;
  }

  const out = Buffer.alloc(32);
  bytes.copy(out, 32 - bytes.length);
  return out;
}

function parseDerSignature(
  derSignature: Uint8Array,
): { r: Buffer; s: Buffer } {
  const bytes = Buffer.from(derSignature);
  let offset = 0;

  if (bytes[offset] !== 0x30) {
    throw new CounterpartyServiceError(503, 'invalid DER signature from KMS');
  }
  offset += 1;

  const totalLength = bytes[offset];
  offset += 1;
  if (totalLength !== bytes.length - offset) {
    throw new CounterpartyServiceError(503, 'invalid DER signature length from KMS');
  }

  if (bytes[offset] !== 0x02) {
    throw new CounterpartyServiceError(503, 'invalid DER signature (missing r)');
  }
  offset += 1;

  const rLength = bytes[offset];
  offset += 1;
  const rBytes = bytes.subarray(offset, offset + rLength);
  offset += rLength;

  if (bytes[offset] !== 0x02) {
    throw new CounterpartyServiceError(503, 'invalid DER signature (missing s)');
  }
  offset += 1;

  const sLength = bytes[offset];
  offset += 1;
  const sBytes = bytes.subarray(offset, offset + sLength);

  return {
    r: normalizeDerInt(rBytes),
    s: normalizeDerInt(sBytes),
  };
}

function ensureLowS(s: Buffer): Buffer {
  const sValue = BigInt(`0x${s.toString('hex')}`);
  if (sValue <= SECP256K1_HALF_N) {
    return s;
  }

  const normalized = SECP256K1_N - sValue;
  return Buffer.from(normalized.toString(16).padStart(64, '0'), 'hex');
}

function spkiDerToCompressedPublicKeyHex(spkiDer: Uint8Array): string {
  const keyObject = createPublicKey({
    key: Buffer.from(spkiDer),
    format: 'der',
    type: 'spki',
  });
  const jwk = keyObject.export({ format: 'jwk' });
  if (
    !jwk ||
    typeof jwk !== 'object' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new CounterpartyServiceError(503, 'invalid KMS public key format');
  }

  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new CounterpartyServiceError(503, 'invalid KMS public key coordinates');
  }

  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]).toString('hex');
}

async function loadKmsSdk(): Promise<KmsSdkModule> {
  if (!kmsSdkPromise) {
    kmsSdkPromise = (async () => {
      try {
        const moduleName = '@aws-sdk/client-kms';
        const mod = await import(moduleName);
        if (
          !('KMSClient' in mod) ||
          !('SignCommand' in mod) ||
          !('GetPublicKeyCommand' in mod)
        ) {
          throw new Error('invalid aws kms sdk module');
        }
        return mod as unknown as KmsSdkModule;
      } catch (error) {
        kmsSdkPromise = null;
        throw new CounterpartyServiceError(
          503,
          'kms-sdk-not-available',
          {
            reason: 'kms-sdk-not-available',
            details:
              error instanceof Error ? error.message : 'failed to load @aws-sdk/client-kms',
          },
        );
      }
    })();
  }

  return kmsSdkPromise;
}

function buildCounterpartySigningContext(request: CounterpartySignRequest): CounterpartySigningContext {
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

  return {
    pipeKey,
    balance1,
    balance2,
    tokenArg,
    secretArg,
    validAfterArg,
  };
}

function buildStructuredDataPayload(
  request: CounterpartySignRequest,
  stackflowMessageVersion: string,
  stacksNetwork: StackflowNodeConfig['stacksNetwork'],
): { message: ReturnType<typeof tupleCV>; domain: ReturnType<typeof tupleCV> } {
  const context = buildCounterpartySigningContext(request);

  const message = tupleCV({
    token: context.tokenArg,
    'principal-1': principalCV(context.pipeKey['principal-1']),
    'principal-2': principalCV(context.pipeKey['principal-2']),
    'balance-1': uintCV(BigInt(context.balance1)),
    'balance-2': uintCV(BigInt(context.balance2)),
    nonce: uintCV(BigInt(request.nonce)),
    action: uintCV(BigInt(request.action)),
    actor: principalCV(request.actor),
    'hashed-secret': context.secretArg,
    'valid-after': context.validAfterArg,
  });

  const domain = tupleCV({
    name: stringAsciiCV(request.contractId),
    version: stringAsciiCV(stackflowMessageVersion),
    'chain-id': uintCV(chainIdForNetwork(stacksNetwork)),
  });

  return { message, domain };
}

async function verifyCounterpartyWithReadonly(
  args: {
    enabled: boolean;
    counterpartyPrincipal: string | null;
    signatureVerifierMode: SignatureVerifierMode;
    network: ReturnType<typeof createNetwork>;
    request: CounterpartySignRequest;
  },
): Promise<SignatureVerificationResult> {
  const {
    enabled,
    counterpartyPrincipal,
    signatureVerifierMode,
    network,
    request,
  } = args;

  if (!enabled || !counterpartyPrincipal) {
    return { valid: false, reason: 'counterparty signing is not configured' };
  }

  if (request.forPrincipal !== counterpartyPrincipal) {
    return {
      valid: false,
      reason: `forPrincipal must be ${counterpartyPrincipal}`,
    };
  }

  if (signatureVerifierMode === 'accept-all') {
    return { valid: true, reason: null };
  }
  if (signatureVerifierMode === 'reject-all') {
    return { valid: false, reason: 'invalid-signature' };
  }

  const context = buildCounterpartySigningContext(request);
  const contract = splitContractId(request.contractId);
  const response = await fetchCallReadOnlyFunction({
    network,
    senderAddress: senderAddressForPrincipal(counterpartyPrincipal),
    contractAddress: contract.address,
    contractName: contract.name,
    functionName: 'verify-signature-request',
    functionArgs: [
      bufferCV(hexToBytes(request.theirSignature)),
      principalCV(request.withPrincipal),
      tupleCV({
        token: context.tokenArg,
        'principal-1': principalCV(context.pipeKey['principal-1']),
        'principal-2': principalCV(context.pipeKey['principal-2']),
      }),
      uintCV(BigInt(context.balance1)),
      uintCV(BigInt(context.balance2)),
      uintCV(BigInt(request.nonce)),
      uintCV(BigInt(request.action)),
      principalCV(request.actor),
      context.secretArg,
      context.validAfterArg,
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

export interface CounterpartySignRequest {
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

interface ParseCounterpartySignRequestOptions {
  counterpartyPrincipal: string;
  allowedActions: Set<string>;
  defaultAction: string | null;
}

function parseCounterpartySignRequest(
  input: unknown,
  options: ParseCounterpartySignRequestOptions,
): CounterpartySignRequest {
  if (!isRecord(input)) {
    throw new CounterpartyServiceError(400, 'payload must be an object');
  }

  const data = input;
  const forPrincipalInput = data.forPrincipal;
  if (forPrincipalInput !== undefined && forPrincipalInput !== null && forPrincipalInput !== '') {
    const parsedForPrincipal = parsePrincipalField(forPrincipalInput, 'forPrincipal');
    if (parsedForPrincipal !== options.counterpartyPrincipal) {
      throw new CounterpartyServiceError(
        400,
        `forPrincipal must match counterparty principal ${options.counterpartyPrincipal}`,
      );
    }
  }

  const actionInput =
    data.action !== undefined && data.action !== null && data.action !== ''
      ? data.action
      : options.defaultAction;
  if (actionInput === null) {
    throw new CounterpartyServiceError(400, 'action is required');
  }

  const action = parseUIntField(actionInput, 'action');
  if (!options.allowedActions.has(action)) {
    throw new CounterpartyServiceError(
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
    forPrincipal: options.counterpartyPrincipal,
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

export interface CounterpartySigner {
  readonly enabled: boolean;
  readonly counterpartyPrincipal: string | null;
  readonly signerAddress: string | null;
  ensureReady(): Promise<void>;
  verifyCounterpartySignature(
    request: CounterpartySignRequest,
  ): Promise<SignatureVerificationResult>;
  signMySignature(request: CounterpartySignRequest): Promise<string>;
}

export class CounterpartyStateSigner implements CounterpartySigner {
  readonly enabled: boolean;

  readonly counterpartyPrincipal: string | null;

  readonly signerAddress: string | null;

  private readonly counterpartyKey: string | null;

  private readonly network: ReturnType<typeof createNetwork>;

  private readonly signatureVerifierMode: SignatureVerifierMode;

  private readonly stackflowMessageVersion: string;

  private readonly stacksNetwork: StackflowNodeConfig['stacksNetwork'];

  constructor(
    config: Pick<
      StackflowNodeConfig,
      | 'stacksNetwork'
      | 'stacksApiUrl'
      | 'signatureVerifierMode'
      | 'counterpartyKey'
      | 'counterpartyPrincipal'
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
    this.counterpartyKey = config.counterpartyKey
      ? normalizeHex(config.counterpartyKey).slice(2)
      : null;
    this.signerAddress = this.counterpartyKey
      ? getAddressFromPrivateKey(this.counterpartyKey, this.network)
      : null;
    this.enabled = Boolean(this.counterpartyKey);

    if (!this.enabled) {
      this.counterpartyPrincipal = null;
      return;
    }

    if (config.counterpartyPrincipal?.trim()) {
      const parsedCounterpartyPrincipal = parsePrincipal(
        config.counterpartyPrincipal,
        'STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL',
      );
      if (
        !parsedCounterpartyPrincipal.includes('.') &&
        parsedCounterpartyPrincipal !== this.signerAddress
      ) {
        throw new Error(
          `STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL (${parsedCounterpartyPrincipal}) does not match counterparty key address (${this.signerAddress})`,
        );
      }
      this.counterpartyPrincipal = parsedCounterpartyPrincipal;
      return;
    }

    this.counterpartyPrincipal = this.signerAddress;
  }

  async verifyCounterpartySignature(
    request: CounterpartySignRequest,
  ): Promise<SignatureVerificationResult> {
    return verifyCounterpartyWithReadonly({
      enabled: this.enabled,
      counterpartyPrincipal: this.counterpartyPrincipal,
      signatureVerifierMode: this.signatureVerifierMode,
      network: this.network,
      request,
    });
  }

  async ensureReady(): Promise<void> {}

  async signMySignature(request: CounterpartySignRequest): Promise<string> {
    if (!this.enabled || !this.counterpartyKey || !this.counterpartyPrincipal) {
      throw new CounterpartyServiceError(503, 'counterparty signing is not configured');
    }

    const { message, domain } = buildStructuredDataPayload(
      request,
      this.stackflowMessageVersion,
      this.stacksNetwork,
    );

    const signature = signStructuredData({
      message,
      domain,
      privateKey: this.counterpartyKey,
    });
    return normalizeHex(signature);
  }
}

class KmsCounterpartySigner implements CounterpartySigner {
  readonly enabled: boolean;

  private readonly network: ReturnType<typeof createNetwork>;

  private readonly signatureVerifierMode: SignatureVerifierMode;

  private readonly stackflowMessageVersion: string;

  private readonly stacksNetwork: StackflowNodeConfig['stacksNetwork'];

  private readonly kmsKeyId: string | null;

  private readonly kmsRegion: string | null;

  private readonly kmsEndpoint: string | null;

  private readonly configuredCounterpartyPrincipal: string | null;

  private kmsClient: {
    send(command: unknown): Promise<unknown>;
  } | null = null;

  private kmsPublicKeyHex: string | null = null;

  private readyPromise: Promise<void> | null = null;

  private ready = false;

  private mutableSignerAddress: string | null = null;

  private mutableCounterpartyPrincipal: string | null = null;

  constructor(
    config: Pick<
      StackflowNodeConfig,
      | 'stacksNetwork'
      | 'stacksApiUrl'
      | 'signatureVerifierMode'
      | 'counterpartyPrincipal'
      | 'stackflowMessageVersion'
      | 'counterpartyKmsKeyId'
      | 'counterpartyKmsRegion'
      | 'counterpartyKmsEndpoint'
    >,
  ) {
    this.network = createNetwork({
      network: config.stacksNetwork,
      client: config.stacksApiUrl ? { baseUrl: config.stacksApiUrl } : undefined,
    });
    this.signatureVerifierMode = config.signatureVerifierMode;
    this.stackflowMessageVersion = config.stackflowMessageVersion;
    this.stacksNetwork = config.stacksNetwork;
    this.kmsKeyId = config.counterpartyKmsKeyId?.trim() || null;
    this.kmsRegion = config.counterpartyKmsRegion?.trim() || null;
    this.kmsEndpoint = config.counterpartyKmsEndpoint?.trim() || null;
    this.enabled = Boolean(this.kmsKeyId);
    this.configuredCounterpartyPrincipal = config.counterpartyPrincipal?.trim()
      ? parsePrincipal(config.counterpartyPrincipal, 'STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL')
      : null;

  }

  get signerAddress(): string | null {
    return this.mutableSignerAddress;
  }

  get counterpartyPrincipal(): string | null {
    return this.mutableCounterpartyPrincipal;
  }

  async ensureReady(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.ready) {
      return;
    }

    if (!this.readyPromise) {
      this.readyPromise = this.initialize();
    }

    await this.readyPromise;
  }

  async verifyCounterpartySignature(
    request: CounterpartySignRequest,
  ): Promise<SignatureVerificationResult> {
    await this.ensureReady();

    return verifyCounterpartyWithReadonly({
      enabled: this.enabled,
      counterpartyPrincipal: this.counterpartyPrincipal,
      signatureVerifierMode: this.signatureVerifierMode,
      network: this.network,
      request,
    });
  }

  async signMySignature(request: CounterpartySignRequest): Promise<string> {
    await this.ensureReady();
    if (!this.enabled || !this.kmsKeyId || !this.kmsClient || !this.kmsPublicKeyHex) {
      throw new CounterpartyServiceError(503, 'counterparty signing is not configured');
    }

    const { message, domain } = buildStructuredDataPayload(
      request,
      this.stackflowMessageVersion,
      this.stacksNetwork,
    );
    const encoded = encodeStructuredDataBytes({ message, domain });
    const digest = createHash('sha256').update(Buffer.from(encoded)).digest();

    const sdk = await loadKmsSdk();
    const signCommand = new sdk.SignCommand({
      KeyId: this.kmsKeyId,
      Message: digest,
      MessageType: 'DIGEST',
      SigningAlgorithm: sdk.SigningAlgorithmSpec?.ECDSA_SHA_256 || 'ECDSA_SHA_256',
    });
    const signResponse = await this.kmsClient.send(signCommand) as {
      Signature?: Uint8Array;
    };
    if (!signResponse?.Signature) {
      throw new CounterpartyServiceError(503, 'kms-signature-not-returned');
    }

    const { r, s } = parseDerSignature(signResponse.Signature);
    const lowS = ensureLowS(s);

    const messageHashHex = toHex(digest);
    const rHex = r.toString('hex');
    const sHex = lowS.toString('hex');

    let recoveryId: number | null = null;
    for (let candidate = 0; candidate <= 3; candidate += 1) {
      const vrs = `${candidate.toString(16).padStart(2, '0')}${rHex}${sHex}`;
      try {
        const recovered = publicKeyFromSignatureVrs(
          messageHashHex,
          vrs,
          PubKeyEncoding.Compressed,
        );
        if (normalizeHex(recovered).slice(2) === this.kmsPublicKeyHex) {
          recoveryId = candidate;
          break;
        }
      } catch {
        // continue
      }
    }

    if (recoveryId === null) {
      throw new CounterpartyServiceError(503, 'kms-signature-recovery-failed');
    }

    const rsv = `${rHex}${sHex}${recoveryId.toString(16).padStart(2, '0')}`;
    return normalizeHex(`0x${rsv}`);
  }

  private async initialize(): Promise<void> {
    if (!this.kmsKeyId) {
      return;
    }

    const sdk = await loadKmsSdk();
    const clientConfig: Record<string, unknown> = {};
    if (this.kmsRegion) {
      clientConfig.region = this.kmsRegion;
    }
    if (this.kmsEndpoint) {
      clientConfig.endpoint = this.kmsEndpoint;
    }

    this.kmsClient = new sdk.KMSClient(clientConfig);
    const getPublicKeyCommand = new sdk.GetPublicKeyCommand({
      KeyId: this.kmsKeyId,
    });
    const publicKeyResponse = await this.kmsClient.send(getPublicKeyCommand) as {
      PublicKey?: Uint8Array;
    };
    if (!publicKeyResponse?.PublicKey) {
      throw new CounterpartyServiceError(503, 'kms-public-key-not-returned');
    }

    this.kmsPublicKeyHex = spkiDerToCompressedPublicKeyHex(publicKeyResponse.PublicKey);
    const signerAddress = publicKeyToAddressSingleSig(this.kmsPublicKeyHex, this.network);
    this.mutableSignerAddress = signerAddress;

    if (this.configuredCounterpartyPrincipal) {
      if (
        !this.configuredCounterpartyPrincipal.includes('.') &&
        this.configuredCounterpartyPrincipal !== signerAddress
      ) {
        throw new Error(
          `STACKFLOW_NODE_COUNTERPARTY_PRINCIPAL (${this.configuredCounterpartyPrincipal}) does not match kms key address (${signerAddress})`,
        );
      }
      this.mutableCounterpartyPrincipal = this.configuredCounterpartyPrincipal;
    } else {
      this.mutableCounterpartyPrincipal = signerAddress;
    }

    this.ready = true;
  }
}

class UnsupportedCounterpartySigner implements CounterpartySigner {
  readonly enabled = false;

  readonly counterpartyPrincipal = null;

  readonly signerAddress = null;

  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async ensureReady(): Promise<void> {}

  async verifyCounterpartySignature(
    _request: CounterpartySignRequest,
  ): Promise<SignatureVerificationResult> {
    return {
      valid: false,
      reason: this.reason,
    };
  }

  async signMySignature(_request: CounterpartySignRequest): Promise<string> {
    throw new CounterpartyServiceError(503, this.reason);
  }
}

export function createCounterpartySigner(
  config: Pick<
    StackflowNodeConfig,
    | 'stacksNetwork'
    | 'stacksApiUrl'
    | 'signatureVerifierMode'
    | 'counterpartyKey'
    | 'counterpartyPrincipal'
    | 'counterpartySignerMode'
    | 'stackflowMessageVersion'
    | 'counterpartyKmsKeyId'
    | 'counterpartyKmsRegion'
    | 'counterpartyKmsEndpoint'
  >,
): CounterpartySigner {
  const mode = (config.counterpartySignerMode || 'local-key') as CounterpartySignerMode;

  if (mode === 'kms') {
    if (!config.counterpartyKmsKeyId) {
      return new UnsupportedCounterpartySigner(
        'STACKFLOW_NODE_COUNTERPARTY_KMS_KEY_ID is required for kms signer mode',
      );
    }
    return new KmsCounterpartySigner(config);
  }

  return new CounterpartyStateSigner(config);
}

export interface CounterpartySignResult {
  request: CounterpartySignRequest;
  mySignature: string;
  upsert: SignatureStateUpsertResult;
}

export class CounterpartyService {
  private readonly stackflowNode: StackflowNode;

  private readonly signer: CounterpartySigner;

  constructor({
    stackflowNode,
    signer,
  }: {
    stackflowNode: StackflowNode;
    signer: CounterpartySigner;
  }) {
    this.stackflowNode = stackflowNode;
    this.signer = signer;
  }

  get enabled(): boolean {
    return this.signer.enabled;
  }

  get counterpartyPrincipal(): string | null {
    return this.signer.counterpartyPrincipal;
  }

  async signTransfer(payload: unknown): Promise<CounterpartySignResult> {
    return this.signState(payload, new Set([ACTION_TRANSFER]), ACTION_TRANSFER);
  }

  async signSignatureRequest(payload: unknown): Promise<CounterpartySignResult> {
    return this.signState(
      payload,
      new Set([ACTION_CLOSE, ACTION_DEPOSIT, ACTION_WITHDRAWAL]),
      null,
    );
  }

  private resolveCurrentBaseline(
    request: CounterpartySignRequest,
  ): CounterpartyStateBaseline | null {
    const pipeKey = canonicalPipeKey(
      request.token,
      request.forPrincipal,
      request.withPrincipal,
    );
    const pipeId = normalizePipeId(pipeKey);
    if (!pipeId) {
      return null;
    }

    const status = this.stackflowNode.status();
    let best: CounterpartyStateBaseline | null = null;

    const consider = (candidate: CounterpartyStateBaseline): void => {
      if (!best || shouldReplaceBaseline(best, candidate)) {
        best = candidate;
      }
    };

    for (const observed of status.observedPipes) {
      if (observed.contractId !== request.contractId || observed.pipeId !== pipeId) {
        continue;
      }

      const principal1IsCounterparty = observed.pipeKey['principal-1'] === request.forPrincipal;
      const myBalance = principal1IsCounterparty ? observed.balance1 : observed.balance2;
      const theirBalance = principal1IsCounterparty ? observed.balance2 : observed.balance1;
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

  private enforceSigningPolicy(request: CounterpartySignRequest): void {
    const baseline = this.resolveCurrentBaseline(request);
    if (!baseline) {
      throw new CounterpartyServiceError(409, 'unknown-pipe-state', {
        reason: 'unknown-pipe-state',
      });
    }

    const incomingNonce = BigInt(request.nonce);
    if (incomingNonce <= baseline.nonceValue) {
      throw new CounterpartyServiceError(409, 'nonce-too-low', {
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
      throw new CounterpartyServiceError(403, 'counterparty-balance-decrease-not-allowed', {
        reason: 'counterparty-balance-decrease',
        currentMyBalance: baseline.myBalance,
        requestedMyBalance: request.myBalance,
      });
    }

    if (request.action === ACTION_TRANSFER) {
      const currentTotal = baseline.myBalanceValue + baseline.theirBalanceValue;
      const requestedTotal = requestedMyBalance + requestedTheirBalance;
      if (requestedTotal !== currentTotal) {
        throw new CounterpartyServiceError(403, 'invalid-transfer-total', {
          reason: 'invalid-transfer-total',
          currentTotal: currentTotal.toString(10),
          requestedTotal: requestedTotal.toString(10),
        });
      }

      if (requestedMyBalance <= baseline.myBalanceValue) {
        throw new CounterpartyServiceError(403, 'transfer-not-beneficial-for-counterparty', {
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
  ): Promise<CounterpartySignResult> {
    await this.signer.ensureReady();

    if (!this.signer.counterpartyPrincipal) {
      throw new CounterpartyServiceError(503, 'counterparty signing is not configured');
    }

    const request = parseCounterpartySignRequest(payload, {
      counterpartyPrincipal: this.signer.counterpartyPrincipal,
      allowedActions,
      defaultAction,
    });

    this.enforceSigningPolicy(request);

    const verification = await this.signer.verifyCounterpartySignature(request);
    if (!verification.valid) {
      throw new CounterpartyServiceError(
        401,
        verification.reason || 'counterparty signature invalid',
      );
    }

    const mySignature = await this.signer.signMySignature(request);

    try {
      const upsert = await this.stackflowNode.upsertSignatureState({
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
        throw new CounterpartyServiceError(401, error.message);
      }

      if (error instanceof PrincipalNotWatchedError) {
        throw new CounterpartyServiceError(403, error.message);
      }

      throw error;
    }
  }
}

export class CounterpartyServiceError extends Error {
  readonly statusCode: number;

  readonly details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'CounterpartyServiceError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
