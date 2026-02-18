import {
  extractStackflowPrintEvents,
  normalizePipeId,
} from './observer-parser.js';
import {
  canonicalPipeKey,
  isValidHex,
  parseOptionalUInt,
  parsePrincipal,
  parseUInt,
  splitContractId,
} from './principal-utils.js';
import { SqliteStateStore } from './state-store.js';
import type {
  ClosureRecord,
  DisputeAttemptRecord,
  DisputeExecutor,
  IngestResult,
  ObservedPipeRecord,
  PipeKey,
  RecordedWatchtowerEvent,
  SignatureStateInput,
  SignatureStateRecord,
  SignatureStateUpsertResult,
  SignatureVerifier,
  StackflowPrintEvent,
  WatchtowerStatus,
} from './types.js';

interface WatchtowerOptions {
  stateStore: SqliteStateStore;
  watchedContracts?: string[];
  watchedPrincipals?: string[];
  disputeExecutor?: DisputeExecutor;
  disputeOnlyBeneficial?: boolean;
  signatureVerifier?: SignatureVerifier;
}

interface UpsertSignatureStateOptions {
  skipVerification?: boolean;
}

const OPEN_CLOSURE_EVENTS = new Set(['force-cancel', 'force-close']);
const TERMINAL_EVENTS = new Set(['close-pipe', 'dispute-closure', 'finalize']);
const ACTION_DEPOSIT = '2';
const ACTION_WITHDRAWAL = '3';

function toBigInt(value: string | null): bigint | null {
  if (value === null) {
    return null;
  }
  return BigInt(value);
}

function expiryValue(value: string | null): number {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortClosures(closures: ClosureRecord[]): ClosureRecord[] {
  return [...closures].sort((left, right) => {
    const leftExpiry = expiryValue(left.expiresAt);
    const rightExpiry = expiryValue(right.expiresAt);

    if (leftExpiry === rightExpiry) {
      return left.pipeId.localeCompare(right.pipeId);
    }

    return leftExpiry - rightExpiry;
  });
}

function sortSignatureStates(states: SignatureStateRecord[]): SignatureStateRecord[] {
  return [...states].sort((left, right) => {
    const leftNonce = BigInt(left.nonce);
    const rightNonce = BigInt(right.nonce);

    if (leftNonce === rightNonce) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }

    return rightNonce > leftNonce ? 1 : -1;
  });
}

function sortObservedPipes(states: ObservedPipeRecord[]): ObservedPipeRecord[] {
  return [...states].sort((left, right) => {
    const leftNonce = toBigInt(left.nonce) ?? -1n;
    const rightNonce = toBigInt(right.nonce) ?? -1n;
    if (leftNonce === rightNonce) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
    return rightNonce > leftNonce ? 1 : -1;
  });
}

function observedPipeStateId(contractId: string, pipeId: string): string {
  return `${contractId}|${pipeId}`;
}

function normalizeContractId(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('contractId must be a non-empty string');
  }

  const contractId = input.trim();
  splitContractId(contractId);
  return contractId;
}

function normalizeToken(input: unknown): string | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  return parsePrincipal(input, 'token');
}

function normalizeHexBuff(input: unknown, bytes: number, fieldName: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`${fieldName} must be a hex string`);
  }

  const value = input.trim().toLowerCase();
  if (!isValidHex(value, bytes)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
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

  throw new Error('beneficialOnly must be a boolean');
}

function parseSignatureStateInput(
  input: unknown,
  defaultBeneficialOnly: boolean,
): SignatureStateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('signature state payload must be an object');
  }

  const data = input as Record<string, unknown>;
  const contractId = normalizeContractId(data.contractId);
  const forPrincipal = parsePrincipal(data.forPrincipal, 'forPrincipal');
  const withPrincipal = parsePrincipal(data.withPrincipal, 'withPrincipal');
  const token = normalizeToken(data.token);
  const action = parseUInt(data.action);
  const amount =
    action === ACTION_DEPOSIT || action === ACTION_WITHDRAWAL
      ? parseUInt(data.amount)
      : parseOptionalUInt(data.amount) || '0';

  return {
    contractId,
    forPrincipal,
    withPrincipal,
    token,
    amount,
    myBalance: parseUInt(data.myBalance),
    theirBalance: parseUInt(data.theirBalance),
    mySignature: normalizeHexBuff(data.mySignature, 65, 'mySignature'),
    theirSignature: normalizeHexBuff(data.theirSignature, 65, 'theirSignature'),
    nonce: parseUInt(data.nonce),
    action,
    actor: parsePrincipal(data.actor, 'actor'),
    secret: normalizeOptionalHexBuff(data.secret, 32, 'secret'),
    validAfter: parseOptionalUInt(data.validAfter),
    beneficialOnly: normalizeBool(data.beneficialOnly, defaultBeneficialOnly),
  };
}

function getClosureSideBalance(
  event: StackflowPrintEvent,
  forPrincipal: string,
): string | null {
  if (!event.pipeKey || !event.pipe) {
    return null;
  }

  if (event.pipeKey['principal-1'] === forPrincipal) {
    return event.pipe['balance-1'];
  }

  if (event.pipeKey['principal-2'] === forPrincipal) {
    return event.pipe['balance-2'];
  }

  return null;
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

export class Watchtower {
  private readonly stateStore: SqliteStateStore;

  private readonly watchedContracts: string[];

  private readonly watchedPrincipals: Set<string>;

  private readonly disputeExecutor: DisputeExecutor | null;

  private readonly disputeOnlyBeneficial: boolean;

  private readonly signatureVerifier: SignatureVerifier | null;

  constructor({
    stateStore,
    watchedContracts = [],
    watchedPrincipals = [],
    disputeExecutor,
    disputeOnlyBeneficial = false,
    signatureVerifier,
  }: WatchtowerOptions) {
    this.stateStore = stateStore;
    this.watchedContracts = watchedContracts;
    this.watchedPrincipals = new Set(watchedPrincipals);
    this.disputeExecutor = disputeExecutor || null;
    this.disputeOnlyBeneficial = disputeOnlyBeneficial;
    this.signatureVerifier = signatureVerifier || null;
  }

  async upsertSignatureState(
    input: unknown,
    options: UpsertSignatureStateOptions = {},
  ): Promise<SignatureStateUpsertResult> {
    const normalized = parseSignatureStateInput(input, this.disputeOnlyBeneficial);
    const context = `contract=${normalized.contractId} for=${normalized.forPrincipal} with=${normalized.withPrincipal} nonce=${normalized.nonce} action=${normalized.action} amount=${normalized.amount} token=${normalized.token ?? 'stx'}`;

    if (!this.isWatchedPrincipal(normalized.forPrincipal)) {
      console.warn(
        `[watchtower] signature-state processed result=rejected reason=principal-not-watched ${context}`,
      );
      throw new PrincipalNotWatchedError(normalized.forPrincipal);
    }

    if (!options.skipVerification && this.signatureVerifier) {
      const verification = await this.signatureVerifier.verifySignatureState(
        normalized,
      );

      if (!verification.valid) {
        console.warn(
          `[watchtower] signature-state processed result=rejected reason=${
            verification.reason || 'invalid-signature'
          } ${context}`,
        );
        throw new SignatureValidationError(
          verification.reason || 'invalid signature',
        );
      }
    }

    const pipeKey = canonicalPipeKey(
      normalized.token,
      normalized.forPrincipal,
      normalized.withPrincipal,
    );
    const pipeId = normalizePipeId(pipeKey);
    if (!pipeId) {
      throw new Error('failed to build pipe id');
    }
    const pipeContext = `${context} pipeId=${pipeId}`;

    const stateId = `${normalized.contractId}|${pipeId}|${normalized.forPrincipal}`;

    const existing = this.stateStore
      .getSignatureStates()
      .find((state) => state.stateId === stateId);

    const nextState: SignatureStateRecord = {
      stateId,
      pipeId,
      ...normalized,
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      const existingNonce = BigInt(existing.nonce);
      const incomingNonce = BigInt(nextState.nonce);

      if (incomingNonce <= existingNonce) {
        console.log(
          `[watchtower] signature-state processed result=ignored reason=nonce-not-higher incomingNonce=${incomingNonce.toString(
            10,
          )} existingNonce=${existingNonce.toString(10)} ${pipeContext}`,
        );
        return {
          stored: false,
          replaced: false,
          reason: 'nonce-too-low',
          state: existing,
        };
      }

      this.stateStore.setSignatureState(nextState);
      console.log(
        `[watchtower] signature-state processed result=stored replaced=true ${pipeContext}`,
      );
      return {
        stored: true,
        replaced: true,
        reason: null,
        state: nextState,
      };
    }

    this.stateStore.setSignatureState(nextState);
    console.log(
      `[watchtower] signature-state processed result=stored replaced=false ${pipeContext}`,
    );
    return {
      stored: true,
      replaced: false,
      reason: null,
      state: nextState,
    };
  }

  async ingest(payload: unknown, source: string | null = null): Promise<IngestResult> {
    const events = extractStackflowPrintEvents(payload, {
      watchedContracts: this.watchedContracts,
    });

    console.log(
      `[watchtower] stackflow events extracted=${events.length} source=${source ?? 'unknown'}`,
    );

    let observedEvents = 0;
    for (const event of events) {
      const pipeId = event.pipeKey ? normalizePipeId(event.pipeKey) : null;
      const watchedPipe = this.isWatchedPipe(event.pipeKey);
      console.log(
        `[watchtower] stackflow event detected contract=${event.contractId} event=${
          event.eventName ?? 'unknown'
        } txid=${event.txid ?? '-'} pipeId=${pipeId ?? '-'} watchedPipe=${watchedPipe}`,
      );

      if (!watchedPipe) {
        continue;
      }

      observedEvents += 1;
      await this.handleEvent(event, source);
    }

    return {
      observedEvents,
      activeClosures: this.stateStore.listClosures().length,
    };
  }

  async ingestBurnBlock(
    burnBlockHeightInput: string | number | bigint,
    source: string | null = null,
  ): Promise<{
    burnBlockHeight: string;
    processedPipes: number;
    settledPipes: number;
  }> {
    const burnBlockHeight = (() => {
      if (typeof burnBlockHeightInput === 'bigint') {
        return burnBlockHeightInput;
      }

      if (
        typeof burnBlockHeightInput === 'number' &&
        Number.isFinite(burnBlockHeightInput) &&
        burnBlockHeightInput >= 0
      ) {
        return BigInt(Math.trunc(burnBlockHeightInput));
      }

      if (
        typeof burnBlockHeightInput === 'string' &&
        /^\d+$/.test(burnBlockHeightInput)
      ) {
        return BigInt(burnBlockHeightInput);
      }

      throw new Error('invalid burn block height');
    })();

    let settledPipes = 0;
    const observedPipes = this.stateStore.listObservedPipes();

    for (const observedPipe of observedPipes) {
      const currentBalance1 = parseUnsignedBigInt(observedPipe.balance1);
      const currentBalance2 = parseUnsignedBigInt(observedPipe.balance2);
      const pending1Amount = parseUnsignedBigInt(observedPipe.pending1Amount);
      const pending1Height = parseUnsignedBigInt(observedPipe.pending1BurnHeight);
      const pending2Amount = parseUnsignedBigInt(observedPipe.pending2Amount);
      const pending2Height = parseUnsignedBigInt(observedPipe.pending2BurnHeight);

      let nextBalance1 = currentBalance1;
      let nextBalance2 = currentBalance2;
      let nextPending1Amount = observedPipe.pending1Amount;
      let nextPending1Height = observedPipe.pending1BurnHeight;
      let nextPending2Amount = observedPipe.pending2Amount;
      let nextPending2Height = observedPipe.pending2BurnHeight;

      let changed = false;

      if (
        pending1Amount !== null &&
        pending1Height !== null &&
        burnBlockHeight >= pending1Height &&
        nextBalance1 !== null
      ) {
        nextBalance1 += pending1Amount;
        nextPending1Amount = null;
        nextPending1Height = null;
        changed = true;
      }

      if (
        pending2Amount !== null &&
        pending2Height !== null &&
        burnBlockHeight >= pending2Height &&
        nextBalance2 !== null
      ) {
        nextBalance2 += pending2Amount;
        nextPending2Amount = null;
        nextPending2Height = null;
        changed = true;
      }

      if (!changed) {
        continue;
      }

      const nextPipe: ObservedPipeRecord = {
        ...observedPipe,
        balance1: nextBalance1 ? nextBalance1.toString(10) : '0',
        balance2: nextBalance2 ? nextBalance2.toString(10) : '0',
        pending1Amount: nextPending1Amount,
        pending1BurnHeight: nextPending1Height,
        pending2Amount: nextPending2Amount,
        pending2BurnHeight: nextPending2Height,
        updatedAt: new Date().toISOString(),
      };

      settledPipes += 1;
      this.stateStore.setObservedPipe(nextPipe);

      console.log(
        `[watchtower] pending settled pipeId=${observedPipe.pipeId} burnBlock=${burnBlockHeight.toString(
          10,
        )} balance1=${nextPipe.balance1 ?? '-'} balance2=${nextPipe.balance2 ?? '-'}`,
      );
    }

    console.log(
      `[watchtower] burn block processed height=${burnBlockHeight.toString(
        10,
      )} source=${source ?? 'unknown'} settledPipes=${settledPipes}`,
    );

    return {
      burnBlockHeight: burnBlockHeight.toString(10),
      processedPipes: observedPipes.length,
      settledPipes,
    };
  }

  private isWatchedPrincipal(principal: string): boolean {
    if (this.watchedPrincipals.size === 0) {
      return true;
    }

    return this.watchedPrincipals.has(principal);
  }

  private isWatchedPipe(pipeKey: PipeKey | null): boolean {
    if (this.watchedPrincipals.size === 0) {
      return true;
    }

    if (!pipeKey) {
      return false;
    }

    return (
      this.watchedPrincipals.has(pipeKey['principal-1']) ||
      this.watchedPrincipals.has(pipeKey['principal-2'])
    );
  }

  private async handleEvent(
    event: StackflowPrintEvent,
    source: string | null = null,
  ): Promise<void> {
    const processedEvent: RecordedWatchtowerEvent = {
      ...event,
      source,
      observedAt: new Date().toISOString(),
    };

    this.stateStore.recordEvent(processedEvent);
    console.log(
      `[watchtower] event recorded event=${event.eventName ?? 'unknown'} txid=${event.txid ?? '-'} source=${
        source ?? 'unknown'
      }`,
    );

    if (!event.pipeKey || !event.eventName) {
      console.log('[watchtower] event skipped reason=missing-pipe-or-event-name');
      return;
    }

    const pipeId = normalizePipeId(event.pipeKey);
    if (!pipeId) {
      console.log('[watchtower] event skipped reason=invalid-pipe-id');
      return;
    }

    const stateId = observedPipeStateId(event.contractId, pipeId);

    if (event.pipe && !TERMINAL_EVENTS.has(event.eventName)) {
      const observedPipe: ObservedPipeRecord = {
        stateId,
        pipeId,
        contractId: event.contractId,
        pipeKey: event.pipeKey,
        balance1: event.pipe['balance-1'],
        balance2: event.pipe['balance-2'],
        pending1Amount: event.pipe['pending-1']?.amount ?? null,
        pending1BurnHeight: event.pipe['pending-1']?.['burn-height'] ?? null,
        pending2Amount: event.pipe['pending-2']?.amount ?? null,
        pending2BurnHeight: event.pipe['pending-2']?.['burn-height'] ?? null,
        expiresAt: event.pipe['expires-at'],
        nonce: event.pipe.nonce,
        closer: event.pipe.closer,
        event: event.eventName,
        txid: event.txid,
        blockHeight: event.blockHeight,
        updatedAt: new Date().toISOString(),
      };
      this.stateStore.setObservedPipe(observedPipe);
      console.log(
        `[watchtower] observed pipe updated pipeId=${pipeId} event=${event.eventName} nonce=${
          observedPipe.nonce ?? '-'
        }`,
      );
    }

    if (OPEN_CLOSURE_EVENTS.has(event.eventName)) {
      const closer = event.pipe?.closer || event.sender || null;

      const closure: ClosureRecord = {
        pipeId,
        contractId: event.contractId,
        pipeKey: event.pipeKey,
        closer,
        expiresAt: event.pipe ? event.pipe['expires-at'] : null,
        nonce: event.pipe ? event.pipe.nonce : null,
        event: event.eventName,
        txid: event.txid,
        blockHeight: event.blockHeight,
        updatedAt: new Date().toISOString(),
      };

      this.stateStore.setClosure(closure);
      console.log(
        `[watchtower] closure opened pipeId=${pipeId} event=${event.eventName} nonce=${
          closure.nonce ?? '-'
        } expiresAt=${closure.expiresAt ?? '-'}`,
      );
      await this.tryDisputeClosure(event, closure);
      return;
    }

    if (TERMINAL_EVENTS.has(event.eventName)) {
      const observedPipe: ObservedPipeRecord = {
        stateId,
        pipeId,
        contractId: event.contractId,
        pipeKey: event.pipeKey,
        balance1: '0',
        balance2: '0',
        pending1Amount: null,
        pending1BurnHeight: null,
        pending2Amount: null,
        pending2BurnHeight: null,
        expiresAt: event.pipe?.['expires-at'] ?? null,
        nonce: event.pipe?.nonce ?? null,
        closer: null,
        event: event.eventName,
        txid: event.txid,
        blockHeight: event.blockHeight,
        updatedAt: new Date().toISOString(),
      };
      this.stateStore.setObservedPipe(observedPipe);
      this.stateStore.deleteClosure(pipeId);
      console.log(
        `[watchtower] terminal event settled pipeId=${pipeId} event=${event.eventName} balances-reset-to-zero`,
      );
      return;
    }
  }

  private async tryDisputeClosure(
    triggerEvent: StackflowPrintEvent,
    closure: ClosureRecord,
  ): Promise<void> {
    if (!this.disputeExecutor?.enabled) {
      console.log(
        `[watchtower] dispute skipped reason=executor-disabled pipeId=${closure.pipeId} contract=${closure.contractId}`,
      );
      return;
    }

    const closureNonce = toBigInt(closure.nonce);
    if (closureNonce === null) {
      console.log(
        `[watchtower] dispute skipped reason=missing-closure-nonce pipeId=${closure.pipeId} contract=${closure.contractId}`,
      );
      return;
    }

    const closer = closure.closer;
    if (!closer) {
      console.log(
        `[watchtower] dispute skipped reason=missing-closer pipeId=${closure.pipeId} contract=${closure.contractId}`,
      );
      return;
    }

    const candidates = sortSignatureStates(
      this.stateStore.getSignatureStatesForPipe(closure.contractId, closure.pipeId),
    ).filter((state) => state.forPrincipal !== closer);

    if (candidates.length === 0) {
      console.log(
        `[watchtower] dispute skipped reason=no-counterparty-state pipeId=${closure.pipeId} contract=${closure.contractId} closer=${closer}`,
      );
      return;
    }

    console.log(
      `[watchtower] dispute evaluate pipeId=${closure.pipeId} contract=${closure.contractId} closer=${closer} closureNonce=${closureNonce.toString(
        10,
      )} candidateStates=${candidates.length}`,
    );

    const eventHeight = toBigInt(triggerEvent.blockHeight);

    const eligible = candidates.find((state) => {
      if (BigInt(state.nonce) <= closureNonce) {
        return false;
      }

      if (state.validAfter !== null && eventHeight !== null && BigInt(state.validAfter) > eventHeight) {
        return false;
      }

      const useBeneficialPolicy = this.disputeOnlyBeneficial || state.beneficialOnly;
      if (!useBeneficialPolicy) {
        return true;
      }

      const closureBalance = getClosureSideBalance(triggerEvent, state.forPrincipal);
      if (closureBalance === null) {
        return false;
      }

      return BigInt(state.myBalance) > BigInt(closureBalance);
    });

    if (!eligible) {
      console.log(
        `[watchtower] dispute skipped reason=no-eligible-state pipeId=${closure.pipeId} contract=${closure.contractId}`,
      );
      return;
    }

    const attemptId = `${triggerEvent.txid || `${closure.contractId}|${closure.pipeId}|${closure.nonce}`}|${eligible.forPrincipal}`;

    const existingAttempt = this.stateStore.getDisputeAttempt(attemptId);
    if (existingAttempt?.success) {
      console.log(
        `[watchtower] dispute skipped reason=already-submitted pipeId=${closure.pipeId} contract=${closure.contractId} for=${eligible.forPrincipal} attemptId=${attemptId}`,
      );
      return;
    }

    console.log(
      `[watchtower] dispute submit pipeId=${closure.pipeId} contract=${closure.contractId} for=${eligible.forPrincipal} nonce=${eligible.nonce} triggerTxid=${triggerEvent.txid ?? '-'} mode=${
        this.disputeExecutor.constructor.name
      }`,
    );

    try {
      const result = await this.disputeExecutor.submitDispute({
        signatureState: eligible,
        closure,
        triggerEvent,
      });

      const attempt: DisputeAttemptRecord = {
        attemptId,
        contractId: closure.contractId,
        pipeId: closure.pipeId,
        forPrincipal: eligible.forPrincipal,
        triggerTxid: triggerEvent.txid,
        success: true,
        disputeTxid: result.txid,
        error: null,
        createdAt: new Date().toISOString(),
      };
      this.stateStore.setDisputeAttempt(attempt);
      console.log(
        `[watchtower] dispute submitted pipeId=${closure.pipeId} contract=${closure.contractId} for=${eligible.forPrincipal} disputeTxid=${result.txid}`,
      );
    } catch (error) {
      const attempt: DisputeAttemptRecord = {
        attemptId,
        contractId: closure.contractId,
        pipeId: closure.pipeId,
        forPrincipal: eligible.forPrincipal,
        triggerTxid: triggerEvent.txid,
        success: false,
        disputeTxid: null,
        error: error instanceof Error ? error.message : 'dispute submission failed',
        createdAt: new Date().toISOString(),
      };
      this.stateStore.setDisputeAttempt(attempt);
      console.error(
        `[watchtower] dispute failed pipeId=${closure.pipeId} contract=${closure.contractId} for=${eligible.forPrincipal} error=${attempt.error}`,
      );
    }
  }

  status(): WatchtowerStatus {
    const snapshot = this.stateStore.getSnapshot();

    return {
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      activeClosures: sortClosures(Object.values(snapshot.activeClosures)),
      observedPipes: sortObservedPipes(Object.values(snapshot.observedPipes)),
      signatureStates: sortSignatureStates(Object.values(snapshot.signatureStates)),
      disputeAttempts: this.stateStore.listDisputeAttempts(),
      recentEvents: snapshot.recentEvents,
    };
  }
}

export class SignatureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureValidationError';
  }
}

export class PrincipalNotWatchedError extends Error {
  constructor(principal: string) {
    super(`principal is not watched: ${principal}`);
    this.name = 'PrincipalNotWatchedError';
  }
}
