import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
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
const SIG_A = `0x${'11'.repeat(65)}`;
const SIG_B = `0x${'22'.repeat(65)}`;
const RUN_HTTP_INTEGRATION = process.env.STACKFLOW_NODE_HTTP_INTEGRATION === '1';

interface Harness {
  baseUrl: string;
  dbFile: string;
  logs: () => string;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
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
});
