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

import { SqliteStateStore } from '../server/src/state-store.ts';
import {
  PrincipalNotWatchedError,
  SignatureValidationError,
  StackflowNode,
} from '../server/src/stackflow-node.ts';
import type {
  DisputeExecutor,
  SignatureVerifier,
  SubmitDisputeResult,
} from '../server/src/types.ts';

const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';

const SIG_A = `0x${'11'.repeat(65)}`;
const SIG_B = `0x${'22'.repeat(65)}`;

function cleanupDb(store: SqliteStateStore, dbFile: string): void {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbFile}${suffix}`;
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}

class FakeExecutor implements DisputeExecutor {
  readonly enabled = true;

  readonly signerAddress = 'ST3FAKEWATCHTOWERADDRESS';

  readonly calls: Array<{ forPrincipal: string; txid: string | null }> = [];

  async submitDispute(args: {
    signatureState: { forPrincipal: string };
    triggerEvent: { txid: string | null };
  }): Promise<SubmitDisputeResult> {
    this.calls.push({
      forPrincipal: args.signatureState.forPrincipal,
      txid: args.triggerEvent.txid,
    });

    return { txid: `0xdispute${this.calls.length}` };
  }
}

class RejectingSignatureVerifier implements SignatureVerifier {
  async verifySignatureState() {
    return {
      valid: false as const,
      reason: 'invalid-signature',
    };
  }
}

function makeForceCancelEventHex({
  sender,
  nonce,
  balance1,
  balance2,
}: {
  sender: string;
  nonce: number;
  balance1: number;
  balance2: number;
}): string {
  return `0x${serializeCV(
    tupleCV({
      event: stringAsciiCV('force-cancel'),
      sender: principalCV(sender),
      'pipe-key': tupleCV({
        'principal-1': principalCV(P1),
        'principal-2': principalCV(P2),
        token: noneCV(),
      }),
      pipe: tupleCV({
        'balance-1': uintCV(balance1),
        'balance-2': uintCV(balance2),
        'expires-at': uintCV(9999),
        nonce: uintCV(nonce),
        closer: noneCV(),
      }),
    }),
  )}`;
}

function forceCancelPayload(params: {
  txid: string;
  sender: string;
  nonce: number;
  balance1: number;
  balance2: number;
  blockHeight: number;
}) {
  return {
    block_height: params.blockHeight,
    events: [
      {
        txid: params.txid,
        contract_event: {
          contract_identifier: CONTRACT_ID,
          topic: 'print',
          raw_value: makeForceCancelEventHex(params),
        },
      },
    ],
  };
}

function makeStore(): { store: SqliteStateStore; dbFile: string } {
  const dbFile = path.join(
    os.tmpdir(),
    `stackflow-watchtower-dispute-${Date.now()}-${Math.random()}.db`,
  );

  const store = new SqliteStateStore({ dbFile, maxRecentEvents: 20 });
  store.load();

  return { store, dbFile };
}

describe('watchtower signature + dispute flow', () => {
  it('rejects signature states for unwatched principals', async () => {
    const { store, dbFile } = makeStore();
    const stackflowNode = new StackflowNode({
      stateStore: store,
      watchedPrincipals: [P2],
    });

    await expect(
      stackflowNode.upsertSignatureState({
        contractId: CONTRACT_ID,
        forPrincipal: P1,
        withPrincipal: P2,
        token: null,
        myBalance: '700',
        theirBalance: '300',
        mySignature: SIG_A,
        theirSignature: SIG_B,
        nonce: '5',
        action: '1',
        actor: P1,
        secret: null,
        validAfter: null,
      }),
    ).rejects.toBeInstanceOf(PrincipalNotWatchedError);

    expect(stackflowNode.status().signatureStates).toHaveLength(0);

    cleanupDb(store, dbFile);
  });

  it('rejects invalid signatures before storing state', async () => {
    const { store, dbFile } = makeStore();
    const stackflowNode = new StackflowNode({
      stateStore: store,
      signatureVerifier: new RejectingSignatureVerifier(),
    });

    await expect(
      stackflowNode.upsertSignatureState({
        contractId: CONTRACT_ID,
        forPrincipal: P1,
        withPrincipal: P2,
        token: null,
        myBalance: '700',
        theirBalance: '300',
        mySignature: SIG_A,
        theirSignature: SIG_B,
        nonce: '5',
        action: '1',
        actor: P1,
        secret: null,
        validAfter: null,
      }),
    ).rejects.toBeInstanceOf(SignatureValidationError);

    expect(stackflowNode.status().signatureStates).toHaveLength(0);

    cleanupDb(store, dbFile);
  });

  it('stores only the latest signature state by nonce', async () => {
    const { store, dbFile } = makeStore();
    const stackflowNode = new StackflowNode({ stateStore: store });

    const first = await stackflowNode.upsertSignatureState({
      contractId: CONTRACT_ID,
      forPrincipal: P1,
      withPrincipal: P2,
      token: null,
      myBalance: '700',
      theirBalance: '300',
      mySignature: SIG_A,
      theirSignature: SIG_B,
      nonce: '5',
      action: '1',
      actor: P1,
      secret: null,
      validAfter: null,
    });

    expect(first.stored).toBe(true);
    expect(first.replaced).toBe(false);

    const second = await stackflowNode.upsertSignatureState({
      contractId: CONTRACT_ID,
      forPrincipal: P1,
      withPrincipal: P2,
      token: null,
      myBalance: '900',
      theirBalance: '100',
      mySignature: SIG_A,
      theirSignature: SIG_B,
      nonce: '4',
      action: '1',
      actor: P1,
      secret: null,
      validAfter: null,
    });

    expect(second.stored).toBe(false);
    expect(second.reason).toBe('nonce-too-low');
    expect(stackflowNode.status().signatureStates).toHaveLength(1);
    expect(stackflowNode.status().signatureStates[0].nonce).toBe('5');

    const third = await stackflowNode.upsertSignatureState({
      contractId: CONTRACT_ID,
      forPrincipal: P1,
      withPrincipal: P2,
      token: null,
      myBalance: '850',
      theirBalance: '150',
      mySignature: SIG_A,
      theirSignature: SIG_B,
      nonce: '5',
      action: '1',
      actor: P1,
      secret: null,
      validAfter: null,
    });

    expect(third.stored).toBe(false);
    expect(third.reason).toBe('nonce-too-low');
    expect(stackflowNode.status().signatureStates).toHaveLength(1);
    expect(stackflowNode.status().signatureStates[0].myBalance).toBe('700');
    expect(stackflowNode.status().signatureStates[0].nonce).toBe('5');

    cleanupDb(store, dbFile);
  });

  it('auto-disputes force-cancel with a newer signature state and avoids duplicate submissions', async () => {
    const { store, dbFile } = makeStore();
    const executor = new FakeExecutor();
    const stackflowNode = new StackflowNode({
      stateStore: store,
      disputeExecutor: executor,
    });

    await stackflowNode.upsertSignatureState({
      contractId: CONTRACT_ID,
      forPrincipal: P1,
      withPrincipal: P2,
      token: null,
      myBalance: '900',
      theirBalance: '100',
      mySignature: SIG_A,
      theirSignature: SIG_B,
      nonce: '5',
      action: '1',
      actor: P1,
      secret: null,
      validAfter: null,
    });

    const payload = forceCancelPayload({
      txid: '0xforce1',
      sender: P2,
      nonce: 3,
      balance1: 500,
      balance2: 500,
      blockHeight: 200,
    });

    await stackflowNode.ingest(payload, '/new_block');
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].forPrincipal).toBe(P1);

    await stackflowNode.ingest(payload, '/new_block');
    expect(executor.calls).toHaveLength(1);

    const attempts = stackflowNode.status().disputeAttempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].success).toBe(true);

    cleanupDb(store, dbFile);
  });

  it('skips dispute when beneficial-only is set and state is not better for user', async () => {
    const { store, dbFile } = makeStore();
    const executor = new FakeExecutor();
    const stackflowNode = new StackflowNode({
      stateStore: store,
      disputeExecutor: executor,
    });

    await stackflowNode.upsertSignatureState({
      contractId: CONTRACT_ID,
      forPrincipal: P1,
      withPrincipal: P2,
      token: null,
      myBalance: '400',
      theirBalance: '600',
      mySignature: SIG_A,
      theirSignature: SIG_B,
      nonce: '10',
      action: '1',
      actor: P1,
      secret: null,
      validAfter: null,
      beneficialOnly: true,
    });

    await stackflowNode.ingest(
      forceCancelPayload({
        txid: '0xforce2',
        sender: P2,
        nonce: 8,
        balance1: 500,
        balance2: 500,
        blockHeight: 300,
      }),
      '/new_block',
    );

    expect(executor.calls).toHaveLength(0);
    expect(stackflowNode.status().disputeAttempts).toHaveLength(0);

    cleanupDb(store, dbFile);
  });
});
