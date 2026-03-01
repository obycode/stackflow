import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  noneCV,
  principalCV,
  serializeCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');
const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';
const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const P3 = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const COUNTERPARTY_SIGNER_KEY =
  '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const SIG_A = `0x${'11'.repeat(65)}`;
const SIG_B = `0x${'22'.repeat(65)}`;
const ADMIN_READ_TOKEN = 'stackflow-admin-integration-token';
const RUN_HTTP_INTEGRATION = process.env.STACKFLOW_NODE_HTTP_INTEGRATION === '1';

interface Harness {
  baseUrl: string;
  dbFile: string;
  logs: () => string;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

interface MockNextHop {
  baseUrl: string;
  requests: Array<{
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }>;
  revealRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }>;
  stop: () => Promise<void>;
}

let built = false;

beforeAll(() => {
  if (!RUN_HTTP_INTEGRATION) {
    return;
  }

  if (!built) {
    execFileSync('npm', ['run', '-s', 'build:stackflow-node'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    built = true;
  }
});

function cleanupDbFiles(dbFile: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbFile}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function forceEventHex({
  eventName,
  sender,
  nonce,
  balance1,
  balance2,
}: {
  eventName: 'force-close' | 'force-cancel';
  sender: string;
  nonce: number;
  balance1: number;
  balance2: number;
}): string {
  return `0x${serializeCV(
    tupleCV({
      event: stringAsciiCV(eventName),
      sender: principalCV(sender),
      'pipe-key': tupleCV({
        'principal-1': principalCV(P1),
        'principal-2': principalCV(P2),
        token: noneCV(),
      }),
      pipe: tupleCV({
        'balance-1': uintCV(balance1),
        'balance-2': uintCV(balance2),
        'expires-at': uintCV(5000),
        nonce: uintCV(nonce),
        closer: noneCV(),
      }),
    }),
  )}`;
}

function newBlockPayload({
  txid,
  eventName,
  sender,
  nonce,
  balance1,
  balance2,
}: {
  txid: string;
  eventName: 'force-close' | 'force-cancel';
  sender: string;
  nonce: number;
  balance1: number;
  balance2: number;
}) {
  return {
    block_height: 555,
    events: [
      {
        txid,
        contract_event: {
          contract_identifier: CONTRACT_ID,
          topic: 'print',
          raw_value: forceEventHex({
            eventName,
            sender,
            nonce,
            balance1,
            balance2,
          }),
        },
      },
    ],
  };
}

function signatureStatePayload(forPrincipal: string) {
  return {
    contractId: CONTRACT_ID,
    forPrincipal,
    withPrincipal: forPrincipal === P1 ? P2 : P1,
    token: null,
    myBalance: '900',
    theirBalance: '100',
    mySignature: SIG_A,
    theirSignature: SIG_B,
    nonce: '5',
    action: '1',
    actor: forPrincipal,
    secret: null,
    validAfter: null,
    beneficialOnly: false,
  };
}

function transferPayload({
  forPrincipal,
  withPrincipal,
  myBalance,
  theirBalance,
  nonce,
  hashedSecret,
}: {
  forPrincipal: string;
  withPrincipal: string;
  myBalance: string;
  theirBalance: string;
  nonce: string;
  hashedSecret?: string;
}) {
  return {
    contractId: CONTRACT_ID,
    forPrincipal,
    withPrincipal,
    token: null,
    amount: '0',
    myBalance,
    theirBalance,
    theirSignature: SIG_B,
    nonce,
    action: '1',
    actor: withPrincipal,
    ...(hashedSecret
      ? {
          hashedSecret,
          secret: hashedSecret,
        }
      : { secret: null }),
    validAfter: null,
    beneficialOnly: false,
  };
}

function signatureRequestPayload({
  forPrincipal,
  withPrincipal,
  action,
  amount,
  myBalance,
  theirBalance,
  nonce,
  actor,
}: {
  forPrincipal: string;
  withPrincipal: string;
  action: '0' | '2' | '3';
  amount: string;
  myBalance: string;
  theirBalance: string;
  nonce: string;
  actor: string;
}) {
  return {
    contractId: CONTRACT_ID,
    forPrincipal,
    withPrincipal,
    token: null,
    amount,
    myBalance,
    theirBalance,
    theirSignature: SIG_B,
    nonce,
    action,
    actor,
    secret: null,
    validAfter: null,
    beneficialOnly: false,
  };
}

function forwardingPayload({
  paymentId,
  incomingAmount,
  outgoingAmount,
  hashedSecret,
  incoming,
  outgoingBaseUrl,
  outgoingEndpoint,
  outgoingPayload,
  upstream,
}: {
  paymentId: string;
  incomingAmount: string;
  outgoingAmount: string;
  hashedSecret: string;
  incoming: Record<string, unknown>;
  outgoingBaseUrl: string;
  outgoingEndpoint?: string;
  outgoingPayload: Record<string, unknown>;
  upstream?: {
    baseUrl: string;
    paymentId: string;
    revealEndpoint?: string;
  };
}) {
  return {
    paymentId,
    incomingAmount,
    outgoingAmount,
    hashedSecret,
    incoming,
    ...(upstream
      ? {
          upstream: {
            baseUrl: upstream.baseUrl,
            paymentId: upstream.paymentId,
            revealEndpoint: upstream.revealEndpoint ?? '/forwarding/reveal',
          },
        }
      : {}),
    outgoing: {
      baseUrl: outgoingBaseUrl,
      endpoint: outgoingEndpoint ?? '/counterparty/transfer',
      payload: outgoingPayload,
    },
  };
}

function peerHeaders(seed: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-stackflow-protocol-version': '1',
    'x-stackflow-request-id': `req-${seed}`,
    'idempotency-key': `idem-${seed}`,
  };
}

function adminHeaders(token = ADMIN_READ_TOKEN): Record<string, string> {
  return {
    'x-stackflow-admin-token': token,
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await predicate();
    if (done) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condition timed out');
}

async function waitForHealth(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  logsRef: string[],
): Promise<void> {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `watchtower exited before health check. logs:\n${logsRef.join('')}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // ignore
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`watchtower health timeout. logs:\n${logsRef.join('')}`);
}

async function startHarness({
  dbFile,
  extraEnv,
}: {
  dbFile: string;
  extraEnv: Record<string, string>;
}): Promise<Harness> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logsRef: string[] = [];
  let child = spawn('node', [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      STACKFLOW_NODE_HOST: '127.0.0.1',
      STACKFLOW_NODE_PORT: String(port),
      STACKFLOW_NODE_DB_FILE: dbFile,
      STACKFLOW_CONTRACTS: CONTRACT_ID,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    logsRef.push(chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    logsRef.push(chunk.toString('utf8'));
  });

  await waitForHealth(baseUrl, child, logsRef);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    await once(child, 'exit');
  };

  const restart = async (): Promise<void> => {
    await stop();
    child = spawn('node', [SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        STACKFLOW_NODE_HOST: '127.0.0.1',
        STACKFLOW_NODE_PORT: String(port),
        STACKFLOW_NODE_DB_FILE: dbFile,
        STACKFLOW_CONTRACTS: CONTRACT_ID,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      logsRef.push(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      logsRef.push(chunk.toString('utf8'));
    });
    await waitForHealth(baseUrl, child, logsRef);
  };

  return {
    baseUrl,
    dbFile,
    logs: () => logsRef.join(''),
    stop,
    restart,
  };
}

async function startMockNextHop(options: {
  failRevealAttempts?: number;
} = {}): Promise<MockNextHop> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests: Array<{
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }> = [];
  const revealRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }> = [];
  let revealFailuresRemaining = Math.max(0, options.failRevealAttempts ?? 0);

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: unknown = {};
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = {};
        }
      }

      const pathname = new URL(request.url || '/', baseUrl).pathname;
      if (pathname === '/counterparty/transfer') {
        requests.push({
          headers: request.headers,
          body,
        });

        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(
          JSON.stringify({
            ok: true,
            mySignature: SIG_A,
            theirSignature: SIG_B,
            stored: true,
            replaced: false,
            nonce: '11',
            action: '1',
          }),
        );
        return;
      }

      if (pathname === '/forwarding/reveal') {
        revealRequests.push({
          headers: request.headers,
          body,
        });
        if (revealFailuresRemaining > 0) {
          revealFailuresRemaining -= 1;
          response.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(
            JSON.stringify({
              ok: false,
              error: 'temporary upstream failure',
              reason: 'temporary-unavailable',
            }),
          );
          return;
        }

        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(
          JSON.stringify({
            ok: true,
            secretRevealed: true,
          }),
        );
        return;
      }

      response.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(
        JSON.stringify({
          ok: false,
          error: 'route not found',
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    baseUrl,
    requests,
    revealRequests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

const describeHttp = RUN_HTTP_INTEGRATION
  ? describe.sequential
  : describe.skip;

describeHttp('watchtower http integration', () => {
  it('supports stacks-node observer routes and persists closures across restart', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: `${P1},${P2}`,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
      },
    });

    try {
      const badRoute = await fetch(`${harness.baseUrl}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(badRoute.status).toBe(404);

      const app = await fetch(`${harness.baseUrl}/app`);
      expect(app.status).toBe(200);

      const appScript = await fetch(`${harness.baseUrl}/app/main.js`);
      expect(appScript.status).toBe(200);

      const compatRoutes = [
        '/new_burn_block',
        '/new_mempool_tx',
        '/drop_mempool_tx',
        '/new_microblocks',
      ];
      for (const route of compatRoutes) {
        const response = await fetch(`${harness.baseUrl}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          ok: boolean;
          ignored: boolean;
          route: string;
        };
        expect(body.ok).toBe(true);
        expect(body.ignored).toBe(true);
        expect(body.route).toBe(route);
      }

      const ingest = await fetch(`${harness.baseUrl}/new_block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          newBlockPayload({
            txid: '0xevent1',
            eventName: 'force-close',
            sender: P1,
            nonce: 4,
            balance1: 500,
            balance2: 500,
          }),
        ),
      });
      expect(ingest.status).toBe(200);
      const ingestBody = (await ingest.json()) as {
        ok: boolean;
        observedEvents: number;
      };
      expect(ingestBody.ok).toBe(true);
      expect(ingestBody.observedEvents).toBe(1);

      const closuresResponse = await fetch(`${harness.baseUrl}/closures`);
      const closures = (await closuresResponse.json()) as {
        closures: Array<{ event: string }>;
      };
      expect(closures.closures).toHaveLength(1);
      expect(closures.closures[0].event).toBe('force-close');

      const pipesResponse = await fetch(
        `${harness.baseUrl}/pipes?principal=${encodeURIComponent(P1)}`,
      );
      expect(pipesResponse.status).toBe(200);
      const pipes = (await pipesResponse.json()) as {
        pipes: Array<{
          event: string;
          balance1: string | null;
          balance2: string | null;
          nonce: string | null;
        }>;
      };
      expect(pipes.pipes).toHaveLength(1);
      expect(pipes.pipes[0].event).toBe('force-close');
      expect(pipes.pipes[0].balance1).toBe('500');
      expect(pipes.pipes[0].balance2).toBe('500');
      expect(pipes.pipes[0].nonce).toBe('4');

      await harness.restart();

      const closuresAfterRestartResponse = await fetch(
        `${harness.baseUrl}/closures`,
      );
      const closuresAfterRestart = (await closuresAfterRestartResponse.json()) as {
        closures: Array<{ event: string }>;
      };
      expect(closuresAfterRestart.closures).toHaveLength(1);
      expect(closuresAfterRestart.closures[0].event).toBe('force-close');
    } finally {
      await harness.stop();

      const db = new DatabaseSync(dbFile);
      const closureCount = db
        .prepare('SELECT COUNT(*) as count FROM closures')
        .get() as { count: number };
      db.close();
      expect(closureCount.count).toBe(1);

      cleanupDbFiles(dbFile);
    }
  });

  it('restricts observer routes to configured source IPs and ignores x-forwarded-for spoofing', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: `${P1},${P2}`,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_OBSERVER_LOCALHOST_ONLY: 'false',
        STACKFLOW_NODE_OBSERVER_ALLOWED_IPS: '198.51.100.77',
      },
    });

    try {
      const blockResponse = await fetch(`${harness.baseUrl}/new_block`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.77',
        },
        body: JSON.stringify(
          newBlockPayload({
            txid: '0xevent-observer-denied-1',
            eventName: 'force-close',
            sender: P1,
            nonce: 4,
            balance1: 500,
            balance2: 500,
          }),
        ),
      });
      expect(blockResponse.status).toBe(403);
      const blockBody = (await blockResponse.json()) as {
        ok: boolean;
        reason: string;
      };
      expect(blockBody.ok).toBe(false);
      expect(blockBody.reason).toBe('observer-source-not-allowed');

      const burnResponse = await fetch(`${harness.baseUrl}/new_burn_block`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.77',
        },
        body: JSON.stringify({ block_height: 700 }),
      });
      expect(burnResponse.status).toBe(403);
      const burnBody = (await burnResponse.json()) as {
        ok: boolean;
        reason: string;
      };
      expect(burnBody.ok).toBe(false);
      expect(burnBody.reason).toBe('observer-source-not-allowed');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('runs end-to-end signature ingest and mock dispute flow', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: P1,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'mock',
      },
    });

    try {
      const malformed = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(malformed.status).toBe(400);

      const unwatched = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P3)),
      });
      expect(unwatched.status).toBe(403);

      const accepted = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(accepted.status).toBe(200);
      const acceptedBody = (await accepted.json()) as { stored: boolean };
      expect(acceptedBody.stored).toBe(true);

      const duplicateNonce = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(duplicateNonce.status).toBe(409);
      const duplicateNonceBody = (await duplicateNonce.json()) as {
        ok: boolean;
        reason: string;
        existingNonce: string;
      };
      expect(duplicateNonceBody.ok).toBe(false);
      expect(duplicateNonceBody.reason).toBe('nonce-too-low');
      expect(duplicateNonceBody.existingNonce).toBe('5');

      const trigger = await fetch(`${harness.baseUrl}/new_block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          newBlockPayload({
            txid: '0xevent2',
            eventName: 'force-cancel',
            sender: P2,
            nonce: 3,
            balance1: 500,
            balance2: 500,
          }),
        ),
      });
      expect(trigger.status).toBe(200);

      const pipesResponse = await fetch(
        `${harness.baseUrl}/pipes?principal=${encodeURIComponent(P1)}`,
      );
      expect(pipesResponse.status).toBe(200);
      const pipes = (await pipesResponse.json()) as {
        pipes: Array<{
          event: string;
          source: string;
          balance1: string | null;
          balance2: string | null;
          nonce: string | null;
        }>;
      };
      expect(pipes.pipes).toHaveLength(1);
      expect(pipes.pipes[0].event).toBe('signature-state');
      expect(pipes.pipes[0].source).toBe('signature-state');
      expect(pipes.pipes[0].balance1).toBe('900');
      expect(pipes.pipes[0].balance2).toBe('100');
      expect(pipes.pipes[0].nonce).toBe('5');

      const disputesResponse = await fetch(
        `${harness.baseUrl}/dispute-attempts?limit=10`,
      );
      const disputes = (await disputesResponse.json()) as {
        disputeAttempts: Array<{
          success: boolean;
          disputeTxid: string | null;
        }>;
      };
      expect(disputes.disputeAttempts).toHaveLength(1);
      expect(disputes.disputeAttempts[0].success).toBe(true);
      expect(disputes.disputeAttempts[0].disputeTxid).toMatch(/^0xmock/);

      await harness.restart();

      const statesAfterRestartResponse = await fetch(
        `${harness.baseUrl}/signature-states?limit=10`,
      );
      const statesAfterRestart = (await statesAfterRestartResponse.json()) as {
        signatureStates: Array<{ forPrincipal: string }>;
      };
      expect(statesAfterRestart.signatureStates).toHaveLength(1);
      expect(statesAfterRestart.signatureStates[0].forPrincipal).toBe(P1);
    } finally {
      await harness.stop();

      const db = new DatabaseSync(dbFile);
      const stateCount = db
        .prepare('SELECT COUNT(*) as count FROM signature_states')
        .get() as { count: number };
      const attemptCount = db
        .prepare('SELECT COUNT(*) as count FROM dispute_attempts')
        .get() as { count: number };
      db.close();

      expect(stateCount.count).toBe(1);
      expect(attemptCount.count).toBe(1);
      cleanupDbFiles(dbFile);
    }
  });

  it('signs and persists a direct transfer update through /counterparty/transfer', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
        STACKFLOW_NODE_ADMIN_READ_TOKEN: ADMIN_READ_TOKEN,
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;

      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const transferResponse = await fetch(
        `${harness.baseUrl}/counterparty/transfer`,
        {
          method: 'POST',
          headers: peerHeaders('transfer-1'),
          body: JSON.stringify(
            transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '910',
              theirBalance: '90',
              nonce: '6',
            }),
          ),
        },
      );
      expect(transferResponse.status).toBe(200);
      const transferBody = (await transferResponse.json()) as {
        stored: boolean;
        replaced: boolean;
        mySignature: string;
        protocolVersion: string;
        idempotencyKey: string;
        requestId: string;
      };
      expect(transferBody.stored).toBe(true);
      expect(transferBody.replaced).toBe(true);
      expect(transferBody.mySignature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(transferBody.protocolVersion).toBe('1');
      expect(transferBody.idempotencyKey).toBe('idem-transfer-1');
      expect(transferBody.requestId).toBe('req-transfer-1');

      const replayTransferResponse = await fetch(
        `${harness.baseUrl}/counterparty/transfer`,
        {
          method: 'POST',
          headers: peerHeaders('transfer-1'),
          body: JSON.stringify(
            transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '910',
              theirBalance: '90',
              nonce: '6',
            }),
          ),
        },
      );
      expect(replayTransferResponse.status).toBe(200);
      expect(replayTransferResponse.headers.get('x-stackflow-idempotency-replay')).toBe(
        'true',
      );
      const replayTransferBody = (await replayTransferResponse.json()) as {
        mySignature: string;
      };
      expect(replayTransferBody.mySignature).toBe(transferBody.mySignature);

      const idempotencyReuseResponse = await fetch(
        `${harness.baseUrl}/counterparty/transfer`,
        {
          method: 'POST',
          headers: peerHeaders('transfer-1'),
          body: JSON.stringify(
            transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '920',
              theirBalance: '80',
              nonce: '7',
            }),
          ),
        },
      );
      expect(idempotencyReuseResponse.status).toBe(409);
      const idempotencyReuseBody = (await idempotencyReuseResponse.json()) as {
        reason: string;
      };
      expect(idempotencyReuseBody.reason).toBe('idempotency-key-reused');

      const statesDeniedResponse = await fetch(
        `${harness.baseUrl}/signature-states?limit=10`,
      );
      expect(statesDeniedResponse.status).toBe(401);

      const statesResponse = await fetch(`${harness.baseUrl}/signature-states?limit=10`, {
        headers: adminHeaders(),
      });
      expect(statesResponse.status).toBe(200);
      const statesBody = (await statesResponse.json()) as {
        redacted: boolean;
        signatureStates: Array<{
          forPrincipal: string;
          withPrincipal: string;
          nonce: string;
          myBalance: string;
          theirBalance: string;
          mySignature: string;
        }>;
      };
      expect(statesBody.redacted).toBe(false);
      expect(statesBody.signatureStates).toHaveLength(1);
      expect(statesBody.signatureStates[0].forPrincipal).toBe(counterpartyPrincipal);
      expect(statesBody.signatureStates[0].withPrincipal).toBe(withPrincipal);
      expect(statesBody.signatureStates[0].nonce).toBe('6');
      expect(statesBody.signatureStates[0].myBalance).toBe('910');
      expect(statesBody.signatureStates[0].theirBalance).toBe('90');
      expect(statesBody.signatureStates[0].mySignature).toBe(
        transferBody.mySignature,
      );

      const pipesResponse = await fetch(
        `${harness.baseUrl}/pipes?principal=${encodeURIComponent(counterpartyPrincipal)}`,
      );
      expect(pipesResponse.status).toBe(200);
      const pipesBody = (await pipesResponse.json()) as {
        pipes: Array<{
          source: string;
          nonce: string | null;
          balance1: string | null;
          balance2: string | null;
          pipeKey: {
            'principal-1': string;
            'principal-2': string;
          };
        }>;
      };
      expect(pipesBody.pipes).toHaveLength(1);
      expect(pipesBody.pipes[0].source).toBe('signature-state');
      expect(pipesBody.pipes[0].nonce).toBe('6');
      const principal1IsCounterparty =
        pipesBody.pipes[0].pipeKey['principal-1'] === counterpartyPrincipal;
      expect(
        principal1IsCounterparty
          ? pipesBody.pipes[0].balance1
          : pipesBody.pipes[0].balance2,
      ).toBe('910');
      expect(
        principal1IsCounterparty
          ? pipesBody.pipes[0].balance2
          : pipesBody.pipes[0].balance1,
      ).toBe('90');

      const rejectedTransfer = await fetch(
        `${harness.baseUrl}/counterparty/transfer`,
        {
          method: 'POST',
          headers: peerHeaders('transfer-2'),
          body: JSON.stringify(
            transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '910',
              theirBalance: '90',
              nonce: '7',
            }),
          ),
        },
      );
      expect(rejectedTransfer.status).toBe(403);
      const rejectedBody = (await rejectedTransfer.json()) as {
        reason: string;
      };
      expect(rejectedBody.reason).toBe('transfer-not-beneficial');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('supports peer signature requests for close, deposit, and withdrawal', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;

      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const closeResponse = await fetch(
        `${harness.baseUrl}/counterparty/signature-request`,
        {
          method: 'POST',
          headers: peerHeaders('sig-close-1'),
          body: JSON.stringify(
            signatureRequestPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              action: '0',
              amount: '0',
              myBalance: '900',
              theirBalance: '100',
              nonce: '6',
              actor: withPrincipal,
            }),
          ),
        },
      );
      expect(closeResponse.status).toBe(200);
      const closeBody = (await closeResponse.json()) as {
        action: string;
        nonce: string;
        stored: boolean;
        replaced: boolean;
        mySignature: string;
      };
      expect(closeBody.action).toBe('0');
      expect(closeBody.nonce).toBe('6');
      expect(closeBody.stored).toBe(true);
      expect(closeBody.replaced).toBe(true);
      expect(closeBody.mySignature).toMatch(/^0x[0-9a-f]{130}$/);

      const depositResponse = await fetch(
        `${harness.baseUrl}/counterparty/signature-request`,
        {
          method: 'POST',
          headers: peerHeaders('sig-deposit-1'),
          body: JSON.stringify(
            signatureRequestPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              action: '2',
              amount: '50',
              myBalance: '900',
              theirBalance: '150',
              nonce: '7',
              actor: withPrincipal,
            }),
          ),
        },
      );
      expect(depositResponse.status).toBe(200);
      const depositBody = (await depositResponse.json()) as {
        action: string;
        nonce: string;
      };
      expect(depositBody.action).toBe('2');
      expect(depositBody.nonce).toBe('7');

      const withdrawalResponse = await fetch(
        `${harness.baseUrl}/counterparty/signature-request`,
        {
          method: 'POST',
          headers: peerHeaders('sig-withdraw-1'),
          body: JSON.stringify(
            signatureRequestPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              action: '3',
              amount: '25',
              myBalance: '900',
              theirBalance: '125',
              nonce: '8',
              actor: withPrincipal,
            }),
          ),
        },
      );
      expect(withdrawalResponse.status).toBe(200);
      const withdrawalBody = (await withdrawalResponse.json()) as {
        action: string;
        nonce: string;
      };
      expect(withdrawalBody.action).toBe('3');
      expect(withdrawalBody.nonce).toBe('8');

      const duplicateNonce = await fetch(
        `${harness.baseUrl}/counterparty/signature-request`,
        {
          method: 'POST',
          headers: peerHeaders('sig-close-2'),
          body: JSON.stringify(
            signatureRequestPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              action: '0',
              amount: '0',
              myBalance: '900',
              theirBalance: '125',
              nonce: '8',
              actor: withPrincipal,
            }),
          ),
        },
      );
      expect(duplicateNonce.status).toBe(409);
      const duplicateNonceBody = (await duplicateNonce.json()) as {
        reason: string;
      };
      expect(duplicateNonceBody.reason).toBe('nonce-too-low');

      const balanceDecrease = await fetch(
        `${harness.baseUrl}/counterparty/signature-request`,
        {
          method: 'POST',
          headers: peerHeaders('sig-close-3'),
          body: JSON.stringify(
            signatureRequestPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              action: '0',
              amount: '0',
              myBalance: '899',
              theirBalance: '126',
              nonce: '9',
              actor: withPrincipal,
            }),
          ),
        },
      );
      expect(balanceDecrease.status).toBe(403);
      const balanceDecreaseBody = (await balanceDecrease.json()) as {
        reason: string;
      };
      expect(balanceDecreaseBody.reason).toBe('counterparty-balance-decrease');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('rejects counterparty requests missing peer protocol headers', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const response = await fetch(`${harness.baseUrl}/counterparty/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          transferPayload({
            forPrincipal: counterpartyPrincipal,
            withPrincipal,
            myBalance: '910',
            theirBalance: '90',
            nonce: '6',
          }),
        ),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { reason: string };
      expect(body.reason).toBe('missing-protocol-version');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('processes a forwarding transfer and persists payment records', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const nextHop = await startMockNextHop();
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
        STACKFLOW_NODE_FORWARDING_ENABLED: 'true',
        STACKFLOW_NODE_FORWARDING_MIN_FEE: '5',
        STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS: 'true',
        STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS: nextHop.baseUrl,
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
        forwardingEnabled: boolean;
      };
      expect(health.forwardingEnabled).toBe(true);
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;

      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const payload = forwardingPayload({
        paymentId: 'pay-2026-02-28-0001',
        incomingAmount: '100',
        outgoingAmount: '90',
        hashedSecret: '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
        incoming: transferPayload({
          forPrincipal: counterpartyPrincipal,
          withPrincipal,
          myBalance: '910',
          theirBalance: '90',
            nonce: '6',
            hashedSecret:
              '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
          }),
        outgoingBaseUrl: nextHop.baseUrl,
        outgoingPayload: {
          contractId: CONTRACT_ID,
          forPrincipal: P2,
          withPrincipal: counterpartyPrincipal,
          token: null,
          amount: '0',
          myBalance: '500',
          theirBalance: '500',
          theirSignature: SIG_B,
          nonce: '11',
          action: '1',
          actor: counterpartyPrincipal,
          hashedSecret:
            '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
          secret: null,
          validAfter: null,
          beneficialOnly: false,
        },
      });

      const forwardResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-1'),
        body: JSON.stringify(payload),
      });
      expect(forwardResponse.status).toBe(200);
      const forwardBody = (await forwardResponse.json()) as {
        paymentId: string;
        feeAmount: string;
        hashedSecret: string;
        upstream: {
          mySignature: string;
        };
      };
      expect(forwardBody.paymentId).toBe('pay-2026-02-28-0001');
      expect(forwardBody.feeAmount).toBe('10');
      expect(forwardBody.hashedSecret).toBe(
        '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
      );
      expect(forwardBody.upstream.mySignature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(nextHop.requests).toHaveLength(1);
      expect(nextHop.requests[0].headers['x-stackflow-protocol-version']).toBe('1');
      expect(nextHop.requests[0].headers['x-stackflow-request-id']).toBeTruthy();
      expect(nextHop.requests[0].headers['idempotency-key']).toBeTruthy();

      const replayResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-1'),
        body: JSON.stringify(payload),
      });
      expect(replayResponse.status).toBe(200);
      expect(replayResponse.headers.get('x-stackflow-idempotency-replay')).toBe('true');
      expect(nextHop.requests).toHaveLength(1);

      const paymentResponse = await fetch(
        `${harness.baseUrl}/forwarding/payments?paymentId=pay-2026-02-28-0001`,
      );
      expect(paymentResponse.status).toBe(200);
      const paymentBody = (await paymentResponse.json()) as {
        redacted: boolean;
        payment: {
          status: string;
          hashedSecret: string | null;
          revealedSecret: string | null;
        } | null;
      };
      expect(paymentBody.redacted).toBe(true);
      expect(paymentBody.payment).toBeTruthy();
      expect(paymentBody.payment?.status).toBe('completed');
      expect(paymentBody.payment?.hashedSecret).toBe(
        '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
      );
      expect(paymentBody.payment?.revealedSecret).toBe(null);

      const revealBad = await fetch(`${harness.baseUrl}/forwarding/reveal`, {
        method: 'POST',
        headers: peerHeaders('forward-reveal-1'),
        body: JSON.stringify({
          paymentId: 'pay-2026-02-28-0001',
          secret: '0x2222222222222222222222222222222222222222222222222222222222222222',
        }),
      });
      expect(revealBad.status).toBe(400);
      const revealBadBody = (await revealBad.json()) as { reason: string };
      expect(revealBadBody.reason).toBe('invalid-secret-preimage');

      const revealOk = await fetch(`${harness.baseUrl}/forwarding/reveal`, {
        method: 'POST',
        headers: peerHeaders('forward-reveal-2'),
        body: JSON.stringify({
          paymentId: 'pay-2026-02-28-0001',
          secret: '0x8484848484848484848484848484848484848484848484848484848484848484',
        }),
      });
      expect(revealOk.status).toBe(200);
      const revealOkBody = (await revealOk.json()) as { secretRevealed: boolean };
      expect(revealOkBody.secretRevealed).toBe(true);

      const paymentAfterRevealResponse = await fetch(
        `${harness.baseUrl}/forwarding/payments?paymentId=pay-2026-02-28-0001`,
      );
      expect(paymentAfterRevealResponse.status).toBe(200);
      const paymentAfterRevealBody = (await paymentAfterRevealResponse.json()) as {
        redacted: boolean;
        payment: {
          revealedSecret: string | null;
          revealedAt: string | null;
        } | null;
      };
      expect(paymentAfterRevealBody.redacted).toBe(true);
      expect(paymentAfterRevealBody.payment?.revealedSecret).toBe(null);
      expect(paymentAfterRevealBody.payment?.revealedAt).toBeTruthy();

      const lowFeeResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-2'),
        body: JSON.stringify(
          forwardingPayload({
            paymentId: 'pay-2026-02-28-0002',
            incomingAmount: '100',
            outgoingAmount: '99',
            hashedSecret:
              '0x3333333333333333333333333333333333333333333333333333333333333333',
            incoming: transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '920',
              theirBalance: '80',
              nonce: '7',
              hashedSecret:
                '0x3333333333333333333333333333333333333333333333333333333333333333',
            }),
            outgoingBaseUrl: nextHop.baseUrl,
            outgoingPayload: {
              contractId: CONTRACT_ID,
              forPrincipal: P2,
              withPrincipal: counterpartyPrincipal,
              token: null,
              amount: '0',
              myBalance: '500',
              theirBalance: '500',
              theirSignature: SIG_B,
              nonce: '12',
              action: '1',
              actor: counterpartyPrincipal,
              hashedSecret:
                '0x3333333333333333333333333333333333333333333333333333333333333333',
              secret: null,
              validAfter: null,
              beneficialOnly: false,
            },
          }),
        ),
      });
      expect(lowFeeResponse.status).toBe(403);
      const lowFeeBody = (await lowFeeResponse.json()) as {
        reason: string;
      };
      expect(lowFeeBody.reason).toBe('forwarding-fee-too-low');
      expect(nextHop.requests).toHaveLength(1);
    } finally {
      await harness.stop();
      await nextHop.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('rejects forwarding transfers to private next-hop destinations by default', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
        STACKFLOW_NODE_FORWARDING_ENABLED: 'true',
        STACKFLOW_NODE_FORWARDING_MIN_FEE: '1',
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;
      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const response = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-private-next-hop'),
        body: JSON.stringify(
          forwardingPayload({
            paymentId: 'pay-2026-03-01-private-1',
            incomingAmount: '100',
            outgoingAmount: '99',
            hashedSecret:
              '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            incoming: transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '901',
              theirBalance: '99',
              nonce: '6',
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            }),
            outgoingBaseUrl: 'http://127.0.0.1:9797',
            outgoingPayload: {
              contractId: CONTRACT_ID,
              forPrincipal: P2,
              withPrincipal: counterpartyPrincipal,
              token: null,
              amount: '0',
              myBalance: '500',
              theirBalance: '500',
              theirSignature: SIG_B,
              nonce: '11',
              action: '1',
              actor: counterpartyPrincipal,
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
              secret: null,
              validAfter: null,
              beneficialOnly: false,
            },
          }),
        ),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { reason: string };
      expect(body.reason).toBe('next-hop-private-destination');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('rejects unsupported forwarding endpoint paths', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
        STACKFLOW_NODE_FORWARDING_ENABLED: 'true',
        STACKFLOW_NODE_FORWARDING_MIN_FEE: '1',
        STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS: 'true',
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;
      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const badNextHopEndpointResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-bad-endpoint-1'),
        body: JSON.stringify(
          forwardingPayload({
            paymentId: 'pay-2026-03-01-endpoint-1',
            incomingAmount: '100',
            outgoingAmount: '99',
            hashedSecret:
              '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            incoming: transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '901',
              theirBalance: '99',
              nonce: '6',
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            }),
            outgoingBaseUrl: 'http://127.0.0.1:9797',
            outgoingEndpoint: '/counterparty/signature-request',
            outgoingPayload: {
              contractId: CONTRACT_ID,
              forPrincipal: P2,
              withPrincipal: counterpartyPrincipal,
              token: null,
              amount: '0',
              myBalance: '500',
              theirBalance: '500',
              theirSignature: SIG_B,
              nonce: '11',
              action: '1',
              actor: counterpartyPrincipal,
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
              secret: null,
              validAfter: null,
              beneficialOnly: false,
            },
          }),
        ),
      });
      expect(badNextHopEndpointResponse.status).toBe(400);
      const badNextHopEndpointBody = (await badNextHopEndpointResponse.json()) as {
        reason: string;
      };
      expect(badNextHopEndpointBody.reason).toBe('unsupported-next-hop-endpoint');

      const badUpstreamEndpointResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-bad-endpoint-2'),
        body: JSON.stringify(
          forwardingPayload({
            paymentId: 'pay-2026-03-01-endpoint-2',
            incomingAmount: '100',
            outgoingAmount: '99',
            hashedSecret:
              '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            upstream: {
              baseUrl: 'http://127.0.0.1:8787',
              paymentId: 'upstream-endpoint-2',
              revealEndpoint: '/counterparty/transfer',
            },
            incoming: transferPayload({
              forPrincipal: counterpartyPrincipal,
              withPrincipal,
              myBalance: '902',
              theirBalance: '98',
              nonce: '7',
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
            }),
            outgoingBaseUrl: 'http://127.0.0.1:9797',
            outgoingPayload: {
              contractId: CONTRACT_ID,
              forPrincipal: P2,
              withPrincipal: counterpartyPrincipal,
              token: null,
              amount: '0',
              myBalance: '500',
              theirBalance: '500',
              theirSignature: SIG_B,
              nonce: '12',
              action: '1',
              actor: counterpartyPrincipal,
              hashedSecret:
                '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
              secret: null,
              validAfter: null,
              beneficialOnly: false,
            },
          }),
        ),
      });
      expect(badUpstreamEndpointResponse.status).toBe(400);
      const badUpstreamEndpointBody = (await badUpstreamEndpointResponse.json()) as {
        reason: string;
      };
      expect(badUpstreamEndpointBody.reason).toBe('unsupported-upstream-reveal-endpoint');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('propagates revealed secrets upstream and retries after transient failure', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const nextHop = await startMockNextHop({ failRevealAttempts: 1 });
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
        STACKFLOW_NODE_FORWARDING_ENABLED: 'true',
        STACKFLOW_NODE_FORWARDING_MIN_FEE: '1',
        STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS: 'true',
        STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS: nextHop.baseUrl,
        STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_INTERVAL_MS: '100',
        STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS: '4',
      },
    });

    try {
      const healthResponse = await fetch(`${harness.baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        counterpartyPrincipal: string | null;
      };
      expect(typeof health.counterpartyPrincipal).toBe('string');
      const counterpartyPrincipal = health.counterpartyPrincipal as string;
      const withPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

      const baselineState = signatureStatePayload(counterpartyPrincipal);
      baselineState.withPrincipal = withPrincipal;
      baselineState.actor = withPrincipal;
      const seedResponse = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baselineState),
      });
      expect(seedResponse.status).toBe(200);

      const payload = forwardingPayload({
        paymentId: 'pay-2026-02-28-0009',
        incomingAmount: '101',
        outgoingAmount: '100',
        hashedSecret: '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
        upstream: {
          baseUrl: nextHop.baseUrl,
          paymentId: 'upstream-pay-0009',
        },
        incoming: transferPayload({
          forPrincipal: counterpartyPrincipal,
          withPrincipal,
          myBalance: '901',
          theirBalance: '99',
          nonce: '9',
          hashedSecret:
            '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
        }),
        outgoingBaseUrl: nextHop.baseUrl,
        outgoingPayload: {
          contractId: CONTRACT_ID,
          forPrincipal: P2,
          withPrincipal: counterpartyPrincipal,
          token: null,
          amount: '0',
          myBalance: '500',
          theirBalance: '500',
          theirSignature: SIG_B,
          nonce: '19',
          action: '1',
          actor: counterpartyPrincipal,
          hashedSecret:
            '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb',
          secret: null,
          validAfter: null,
          beneficialOnly: false,
        },
      });

      const forwardResponse = await fetch(`${harness.baseUrl}/forwarding/transfer`, {
        method: 'POST',
        headers: peerHeaders('forward-upstream-1'),
        body: JSON.stringify(payload),
      });
      expect(forwardResponse.status).toBe(200);

      const revealResponse = await fetch(`${harness.baseUrl}/forwarding/reveal`, {
        method: 'POST',
        headers: peerHeaders('forward-upstream-reveal-1'),
        body: JSON.stringify({
          paymentId: 'pay-2026-02-28-0009',
          secret: '0x8484848484848484848484848484848484848484848484848484848484848484',
        }),
      });
      expect(revealResponse.status).toBe(200);
      const revealBody = (await revealResponse.json()) as {
        revealPropagationStatus: string;
      };
      expect(revealBody.revealPropagationStatus).toBe('pending');

      await waitForCondition(async () => {
        const response = await fetch(
          `${harness.baseUrl}/forwarding/payments?paymentId=pay-2026-02-28-0009`,
        );
        const body = (await response.json()) as {
          payment: {
            revealPropagationStatus: string;
            revealPropagationAttempts: number;
            revealPropagatedAt: string | null;
          } | null;
        };
        return (
          body.payment?.revealPropagationStatus === 'propagated' &&
          body.payment.revealPropagationAttempts >= 2 &&
          Boolean(body.payment.revealPropagatedAt)
        );
      });

      expect(nextHop.revealRequests.length).toBeGreaterThanOrEqual(2);
      const firstRevealBody = nextHop.revealRequests[0]?.body as
        | { paymentId?: string; secret?: string }
        | undefined;
      expect(firstRevealBody?.paymentId).toBe('upstream-pay-0009');
      expect(firstRevealBody?.secret).toBe(
        '0x8484848484848484848484848484848484848484848484848484848484848484',
      );
    } finally {
      await harness.stop();
      await nextHop.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('returns 401 when reject-all verifier mode is active', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: P1,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'reject-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
      },
    });

    try {
      const response = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(response.status).toBe(401);
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('returns 429 when write rate limit is exceeded', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: P1,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE: '1',
      },
    });

    try {
      const first = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBeTruthy();
      const secondBody = (await second.json()) as { reason: string };
      expect(secondBody.reason).toBe('rate-limit-exceeded');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('does not trust x-forwarded-for for rate limiting by default', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: P1,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
        STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE: '1',
      },
    });

    try {
      const first = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.17',
        },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.19',
        },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(second.status).toBe(429);
      const secondBody = (await second.json()) as { reason: string };
      expect(secondBody.reason).toBe('rate-limit-exceeded');
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });

  it('redacts sensitive signature fields when admin token is not configured', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-http-${Date.now()}-${Math.random()}.db`,
    );
    const harness = await startHarness({
      dbFile,
      extraEnv: {
        STACKFLOW_NODE_PRINCIPALS: P1,
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
      },
    });

    try {
      const seed = await fetch(`${harness.baseUrl}/signature-states`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signatureStatePayload(P1)),
      });
      expect(seed.status).toBe(200);

      const response = await fetch(`${harness.baseUrl}/signature-states?limit=10`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        redacted: boolean;
        signatureStates: Array<{
          mySignature: string;
          theirSignature: string;
          secret: string | null;
        }>;
      };
      expect(body.redacted).toBe(true);
      expect(body.signatureStates).toHaveLength(1);
      expect(body.signatureStates[0].mySignature).toBe('[redacted]');
      expect(body.signatureStates[0].theirSignature).toBe('[redacted]');
      expect(body.signatureStates[0].secret).toBe(null);
    } finally {
      await harness.stop();
      cleanupDbFiles(dbFile);
    }
  });
});
