import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
} from './counterparty-service.js';
import { SqliteStateStore } from './state-store.js';
import { canonicalPipeKey } from './principal-utils.js';
import type {
  DisputeExecutor,
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
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function createHandler({
  stackflowNode,
  counterpartyService,
  startedAt,
  disputeEnabled,
  signerAddress,
  counterpartyEnabled,
  counterpartyPrincipal,
  stacksNetwork,
  watchedContracts,
  logRawEvents,
}: {
  stackflowNode: StackflowNode;
  counterpartyService: CounterpartyService;
  startedAt: string;
  disputeEnabled: boolean;
  signerAddress: string | null;
  counterpartyEnabled: boolean;
  counterpartyPrincipal: string | null;
  stacksNetwork: 'mainnet' | 'testnet' | 'devnet' | 'mocknet';
  watchedContracts: string[];
  logRawEvents: boolean;
}) {
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
        stacksNetwork,
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
      const status = stackflowNode.status();
      const limit = parseLimit(url);

      writeJson(response, 200, {
        ok: true,
        signatureStates: status.signatureStates.slice(0, limit),
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

    if (method === 'POST' && url.pathname === '/signature-states') {
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
      try {
        const payload = await readJsonBody(request);
        const result = await counterpartyService.signTransfer(payload);

        if (!result.upsert.stored && result.upsert.reason === 'nonce-too-low') {
          console.warn(
            `[stackflow-node] /counterparty/transfer rejected status=409 reason=nonce-too-low incomingNonce=${result.request.nonce} existingNonce=${result.upsert.state.nonce} stateId=${result.upsert.state.stateId}`,
          );
          writeJson(response, 409, {
            ok: false,
            error: 'nonce-too-low',
            reason: 'nonce-too-low',
            incomingNonce: result.request.nonce,
            existingNonce: result.upsert.state.nonce,
            state: result.upsert.state,
          });
          return;
        }

        writeJson(response, 200, {
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
        });
      } catch (error) {
        if (error instanceof CounterpartyServiceError) {
          console.warn(
            `[stackflow-node] /counterparty/transfer rejected status=${error.statusCode} error=${error.message}`,
          );
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            ...details,
          });
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
      try {
        const payload = await readJsonBody(request);
        const result = await counterpartyService.signSignatureRequest(payload);

        if (!result.upsert.stored && result.upsert.reason === 'nonce-too-low') {
          console.warn(
            `[stackflow-node] /counterparty/signature-request rejected status=409 reason=nonce-too-low incomingNonce=${result.request.nonce} existingNonce=${result.upsert.state.nonce} stateId=${result.upsert.state.stateId}`,
          );
          writeJson(response, 409, {
            ok: false,
            error: 'nonce-too-low',
            reason: 'nonce-too-low',
            incomingNonce: result.request.nonce,
            existingNonce: result.upsert.state.nonce,
            state: result.upsert.state,
          });
          return;
        }

        writeJson(response, 200, {
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
        });
      } catch (error) {
        if (error instanceof CounterpartyServiceError) {
          console.warn(
            `[stackflow-node] /counterparty/signature-request rejected status=${error.statusCode} error=${error.message}`,
          );
          const details =
            error.details && typeof error.details === 'object'
              ? error.details
              : {};
          writeJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            ...details,
          });
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

    if (method === 'POST' && url.pathname === '/new_block') {
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

  const startedAt = new Date().toISOString();
  const server = http.createServer(
    createHandler({
      stackflowNode,
      counterpartyService,
      startedAt,
      disputeEnabled: disputeExecutor.enabled,
      signerAddress: disputeExecutor.signerAddress,
      counterpartyEnabled: counterpartyService.enabled,
      counterpartyPrincipal: counterpartyService.counterpartyPrincipal,
      stacksNetwork: config.stacksNetwork,
      watchedContracts: config.watchedContracts,
      logRawEvents: config.logRawEvents,
    }),
  );

  server.listen(config.port, config.host, () => {
    const watchedContracts =
      config.watchedContracts.length > 0
        ? config.watchedContracts.join(', ')
        : '[auto: any *.stackflow* contract]';
    const watchedPrincipals =
      effectiveWatchedPrincipals.length > 0
        ? effectiveWatchedPrincipals.join(', ')
        : '[auto: any principal]';

    console.log(
      `[stackflow-node] listening on http://${config.host}:${config.port} ` +
        `contracts=${watchedContracts} db=${config.dbFile} ` +
        `principals=${watchedPrincipals} disputes=${disputeExecutor.enabled ? 'enabled' : 'disabled'} ` +
        `dispute-mode=${config.disputeExecutorMode} verifier-mode=${config.signatureVerifierMode} ` +
        `counterparty-signer-mode=${config.counterpartySignerMode} ` +
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
