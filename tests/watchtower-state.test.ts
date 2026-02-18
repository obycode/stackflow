import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  noneCV,
  principalCV,
  serializeCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { describe, expect, it } from 'vitest';

import { normalizePipeId } from '../server/src/observer-parser.ts';
import { SqliteStateStore } from '../server/src/state-store.ts';
import { Watchtower } from '../server/src/watchtower.ts';

const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const P3 = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

function cleanupDb(store: SqliteStateStore, dbFile: string): void {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbFile}${suffix}`;
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}

function forceEventHex(
  name: 'fund-pipe' | 'force-close' | 'close-pipe' | 'dispute-closure' | 'finalize',
  principal1: string = P1,
  principal2: string = P2,
) {
  return `0x${serializeCV(
    tupleCV({
      event: stringAsciiCV(name),
      sender: principalCV(principal1),
      'pipe-key': tupleCV({
        'principal-1': principalCV(principal1),
        'principal-2': principalCV(principal2),
        token: noneCV(),
      }),
      pipe: tupleCV({
        'balance-1': uintCV(50),
        'balance-2': uintCV(75),
        'expires-at': uintCV(1000),
        nonce: uintCV(4),
        closer: noneCV(),
      }),
    }),
  )}`;
}

function payloadFor(
  eventName: 'fund-pipe' | 'force-close' | 'close-pipe' | 'dispute-closure' | 'finalize',
  principal1: string = P1,
  principal2: string = P2,
) {
  return {
    block_height: 777,
    events: [
      {
        txid: `0x${eventName}`,
        contract_event: {
          contract_identifier:
            'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0',
          topic: 'print',
          raw_value: forceEventHex(eventName, principal1, principal2),
        },
      },
    ],
  };
}

describe('watchtower state transitions', () => {
  it('ignores events for pipes that do not include watched principals', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({
      stateStore: store,
      watchedPrincipals: [P1],
    });

    const result = await watchtower.ingest(payloadFor('force-close', P2, P3), '/new_block');

    expect(result.observedEvents).toBe(0);
    expect(watchtower.status().activeClosures).toHaveLength(0);

    cleanupDb(store, dbFile);
  });

  it('tracks closures opened by force-close and zeroes balances on finalize', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({ stateStore: store });

    await watchtower.ingest(payloadFor('force-close'), '/new_block');

    let status = watchtower.status();
    expect(status.activeClosures).toHaveLength(1);
    expect(status.activeClosures[0].event).toBe('force-close');
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('force-close');

    await watchtower.ingest(payloadFor('finalize'), '/new_block');

    status = watchtower.status();
    expect(status.activeClosures).toHaveLength(0);
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('finalize');
    expect(status.observedPipes[0].balance1).toBe('0');
    expect(status.observedPipes[0].balance2).toBe('0');

    cleanupDb(store, dbFile);
  });

  it('tracks on-chain pipe balances from fund-pipe events', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({ stateStore: store });
    await watchtower.ingest(payloadFor('fund-pipe'), '/new_block');

    const status = watchtower.status();
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('fund-pipe');
    expect(status.observedPipes[0].balance1).toBe('50');
    expect(status.observedPipes[0].balance2).toBe('75');
    expect(status.observedPipes[0].nonce).toBe('4');

    cleanupDb(store, dbFile);
  });

  it('resets observed pipe balances to zero on dispute-closure', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({ stateStore: store });
    await watchtower.ingest(payloadFor('force-close'), '/new_block');

    let status = watchtower.status();
    expect(status.activeClosures).toHaveLength(1);
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].balance1).toBe('50');
    expect(status.observedPipes[0].balance2).toBe('75');

    await watchtower.ingest(payloadFor('dispute-closure'), '/new_block');

    status = watchtower.status();
    expect(status.activeClosures).toHaveLength(0);
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('dispute-closure');
    expect(status.observedPipes[0].balance1).toBe('0');
    expect(status.observedPipes[0].balance2).toBe('0');
    expect(status.observedPipes[0].pending1Amount).toBeNull();
    expect(status.observedPipes[0].pending2Amount).toBeNull();

    cleanupDb(store, dbFile);
  });

  it('resets observed pipe balances to zero on close-pipe', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({ stateStore: store });
    await watchtower.ingest(payloadFor('fund-pipe'), '/new_block');

    let status = watchtower.status();
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('fund-pipe');
    expect(status.observedPipes[0].balance1).toBe('50');
    expect(status.observedPipes[0].balance2).toBe('75');

    await watchtower.ingest(payloadFor('close-pipe'), '/new_block');

    status = watchtower.status();
    expect(status.activeClosures).toHaveLength(0);
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].event).toBe('close-pipe');
    expect(status.observedPipes[0].balance1).toBe('0');
    expect(status.observedPipes[0].balance2).toBe('0');
    expect(status.observedPipes[0].pending1Amount).toBeNull();
    expect(status.observedPipes[0].pending2Amount).toBeNull();

    cleanupDb(store, dbFile);
  });

  it('settles pending balances when burn block height is reached', async () => {
    const dbFile = path.join(
      os.tmpdir(),
      `stackflow-watchtower-${Date.now()}-${Math.random()}.db`,
    );

    const store = new SqliteStateStore({ dbFile, maxRecentEvents: 10 });
    store.load();

    const watchtower = new Watchtower({ stateStore: store });
    const pipeKey = {
      token: null,
      'principal-1': P1,
      'principal-2': P2,
    };
    const pipeId = normalizePipeId(pipeKey);
    if (!pipeId) {
      throw new Error('failed to build pipe id');
    }

    store.setObservedPipe({
      stateId: `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0|${pipeId}`,
      pipeId,
      contractId: 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0',
      pipeKey,
      balance1: '0',
      balance2: '0',
      pending1Amount: '4000000',
      pending1BurnHeight: '159',
      pending2Amount: null,
      pending2BurnHeight: null,
      expiresAt: null,
      nonce: '0',
      closer: null,
      event: 'fund-pipe',
      txid: '0xabc',
      blockHeight: '153',
      updatedAt: new Date().toISOString(),
    });

    const before = await watchtower.ingestBurnBlock(158, '/new_burn_block');
    expect(before.settledPipes).toBe(0);

    let status = watchtower.status();
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].balance1).toBe('0');
    expect(status.observedPipes[0].pending1Amount).toBe('4000000');
    expect(status.observedPipes[0].pending1BurnHeight).toBe('159');

    const after = await watchtower.ingestBurnBlock(159, '/new_burn_block');
    expect(after.settledPipes).toBe(1);

    status = watchtower.status();
    expect(status.observedPipes).toHaveLength(1);
    expect(status.observedPipes[0].balance1).toBe('4000000');
    expect(status.observedPipes[0].pending1Amount).toBeNull();
    expect(status.observedPipes[0].pending1BurnHeight).toBeNull();

    cleanupDb(store, dbFile);
  });
});
