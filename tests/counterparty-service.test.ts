import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNetwork } from '@stacks/network';
import { getAddressFromPrivateKey } from '@stacks/transactions';
import { describe, expect, it } from 'vitest';

import {
  createCounterpartySigner,
  CounterpartyService,
  CounterpartyServiceError,
  CounterpartyStateSigner,
} from '../server/src/counterparty-service.ts';
import { normalizePipeId } from '../server/src/observer-parser.ts';
import { canonicalPipeKey } from '../server/src/principal-utils.ts';
import { AcceptAllSignatureVerifier } from '../server/src/signature-verifier.ts';
import { SqliteStateStore } from '../server/src/state-store.ts';
import { StackflowNode } from '../server/src/stackflow-node.ts';

const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';
const COUNTERPARTY = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const PRODUCER_KEY =
  '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const COUNTERPARTY_SIGNATURE = `0x${'22'.repeat(65)}`;
const PRODUCER_ADDRESS = getAddressFromPrivateKey(
  PRODUCER_KEY,
  createNetwork({ network: 'devnet' }),
);

function cleanupDb(store: SqliteStateStore, dbFile: string): void {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbFile}${suffix}`;
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}

function makeHarness({
  signatureVerifierMode = 'accept-all' as const,
}: {
  signatureVerifierMode?: 'accept-all' | 'reject-all';
}) {
  const counterpartyAddress = getAddressFromPrivateKey(
    PRODUCER_KEY,
    createNetwork({ network: 'devnet' }),
  );
  const dbFile = path.join(
    os.tmpdir(),
    `stackflow-counterparty-${Date.now()}-${Math.random()}.db`,
  );
  const store = new SqliteStateStore({ dbFile, maxRecentEvents: 20 });
  store.load();

  const stackflowNode = new StackflowNode({
    stateStore: store,
    watchedPrincipals: [counterpartyAddress],
    signatureVerifier: new AcceptAllSignatureVerifier(),
  });
  const signer = new CounterpartyStateSigner({
    stacksNetwork: 'devnet',
    stacksApiUrl: null,
    signatureVerifierMode,
    counterpartyKey: PRODUCER_KEY,
    counterpartyPrincipal: null,
    stackflowMessageVersion: '0.6.0',
  });
  const service = new CounterpartyService({ stackflowNode, signer });

  return {
    counterpartyAddress,
    dbFile,
    store,
    service,
  };
}

function transferPayload(counterpartyAddress: string) {
  return {
    contractId: CONTRACT_ID,
    withPrincipal: COUNTERPARTY,
    token: null,
    myBalance: '900',
    theirBalance: '100',
    theirSignature: COUNTERPARTY_SIGNATURE,
    nonce: '5',
    action: '1',
    actor: counterpartyAddress,
    secret: null,
    validAfter: null,
    beneficialOnly: false,
  };
}

function seedObservedPipeState({
  store,
  counterpartyAddress,
  withPrincipal,
  token,
  contractId,
  myBalance,
  theirBalance,
  nonce,
}: {
  store: SqliteStateStore;
  counterpartyAddress: string;
  withPrincipal: string;
  token: string | null;
  contractId: string;
  myBalance: string;
  theirBalance: string;
  nonce: string;
}): void {
  const pipeKey = canonicalPipeKey(token, counterpartyAddress, withPrincipal);
  const pipeId = normalizePipeId(pipeKey);
  if (!pipeId) {
    throw new Error('failed to build pipe id in test');
  }

  const principal1IsCounterparty = pipeKey['principal-1'] === counterpartyAddress;
  const balance1 = principal1IsCounterparty ? myBalance : theirBalance;
  const balance2 = principal1IsCounterparty ? theirBalance : myBalance;
  const now = new Date().toISOString();
  store.setObservedPipe({
    stateId: `${contractId}|${pipeId}`,
    pipeId,
    contractId,
    pipeKey,
    balance1,
    balance2,
    pending1Amount: null,
    pending1BurnHeight: null,
    pending2Amount: null,
    pending2BurnHeight: null,
    expiresAt: null,
    nonce,
    closer: null,
    event: 'fund-pipe',
    txid: null,
    blockHeight: null,
    updatedAt: now,
  });
}

describe('counterparty signing service', () => {
  it('signs transfer states and stores the latest signature pair', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        counterpartyAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      const result = await service.signTransfer(transferPayload(counterpartyAddress));

      expect(result.upsert.stored).toBe(true);
      expect(result.upsert.replaced).toBe(false);
      expect(result.request.forPrincipal).toBe(counterpartyAddress);
      expect(result.request.action).toBe('1');
      expect(result.mySignature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(result.upsert.state.mySignature).toBe(result.mySignature);
      expect(result.upsert.state.theirSignature).toBe(COUNTERPARTY_SIGNATURE);
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('enforces action restrictions on /counterparty/signature-request', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      await expect(
        service.signSignatureRequest({
          ...transferPayload(counterpartyAddress),
          action: '1',
        }),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 400,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects requests when reject-all verifier mode is active', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({
      signatureVerifierMode: 'reject-all',
    });

    try {
      seedObservedPipeState({
        store,
        counterpartyAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      await expect(
        service.signTransfer(transferPayload(counterpartyAddress)),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 401,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('requires amount for withdrawal signature requests', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        counterpartyAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '200',
        theirBalance: '100',
        nonce: '4',
      });

      await expect(
        service.signSignatureRequest({
          ...transferPayload(counterpartyAddress),
          action: '3',
          actor: COUNTERPARTY,
          amount: null,
          myBalance: '200',
          theirBalance: '50',
          nonce: '5',
        }),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 400,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects transfer when nonce is not higher than stored state', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        counterpartyAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      const first = await service.signTransfer(transferPayload(counterpartyAddress));
      expect(first.upsert.stored).toBe(true);

      await expect(
        service.signTransfer(transferPayload(counterpartyAddress)),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 409,
        details: {
          reason: 'nonce-too-low',
          existingNonce: '5',
        },
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects transfer when counterparty balance decreases', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        counterpartyAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '200',
        theirBalance: '100',
        nonce: '4',
      });

      await expect(
        service.signTransfer({
          ...transferPayload(counterpartyAddress),
          myBalance: '150',
          theirBalance: '150',
          nonce: '5',
        }),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 403,
        details: {
          reason: 'counterparty-balance-decrease',
        },
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects transfer when no baseline state exists', async () => {
    const { counterpartyAddress, dbFile, store, service } = makeHarness({});

    try {
      await expect(
        service.signTransfer(transferPayload(counterpartyAddress)),
      ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
        statusCode: 409,
        details: {
          reason: 'unknown-pipe-state',
        },
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('requires a KMS key id when kms signer mode is enabled', async () => {
    const signer = createCounterpartySigner({
      stacksNetwork: 'devnet',
      stacksApiUrl: null,
      signatureVerifierMode: 'accept-all',
      counterpartyKey: null,
      counterpartyPrincipal: null,
      counterpartySignerMode: 'kms',
      stackflowMessageVersion: '0.6.0',
      counterpartyKmsKeyId: null,
      counterpartyKmsRegion: null,
      counterpartyKmsEndpoint: null,
    });

    expect(signer.enabled).toBe(false);
    await expect(signer.ensureReady()).resolves.toBeUndefined();
    await expect(
      signer.signMySignature(transferPayload(PRODUCER_ADDRESS)),
    ).rejects.toMatchObject<Partial<CounterpartyServiceError>>({
      statusCode: 503,
    });
  });
});
