import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNetwork } from '@stacks/network';
import { getAddressFromPrivateKey } from '@stacks/transactions';
import { describe, expect, it } from 'vitest';

import {
  ProducerService,
  ProducerServiceError,
  ProducerStateSigner,
} from '../server/src/producer-service.ts';
import { normalizePipeId } from '../server/src/observer-parser.ts';
import { canonicalPipeKey } from '../server/src/principal-utils.ts';
import { AcceptAllSignatureVerifier } from '../server/src/signature-verifier.ts';
import { SqliteStateStore } from '../server/src/state-store.ts';
import { Watchtower } from '../server/src/watchtower.ts';

const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';
const COUNTERPARTY = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const PRODUCER_KEY =
  '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const COUNTERPARTY_SIGNATURE = `0x${'22'.repeat(65)}`;

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
  const producerAddress = getAddressFromPrivateKey(
    PRODUCER_KEY,
    createNetwork({ network: 'devnet' }),
  );
  const dbFile = path.join(
    os.tmpdir(),
    `stackflow-producer-${Date.now()}-${Math.random()}.db`,
  );
  const store = new SqliteStateStore({ dbFile, maxRecentEvents: 20 });
  store.load();

  const watchtower = new Watchtower({
    stateStore: store,
    watchedPrincipals: [producerAddress],
    signatureVerifier: new AcceptAllSignatureVerifier(),
  });
  const signer = new ProducerStateSigner({
    stacksNetwork: 'devnet',
    stacksApiUrl: null,
    signatureVerifierMode,
    producerKey: PRODUCER_KEY,
    producerPrincipal: null,
    stackflowMessageVersion: '0.6.0',
  });
  const service = new ProducerService({ watchtower, signer });

  return {
    producerAddress,
    dbFile,
    store,
    service,
  };
}

function transferPayload(producerAddress: string) {
  return {
    contractId: CONTRACT_ID,
    withPrincipal: COUNTERPARTY,
    token: null,
    myBalance: '900',
    theirBalance: '100',
    theirSignature: COUNTERPARTY_SIGNATURE,
    nonce: '5',
    action: '1',
    actor: producerAddress,
    secret: null,
    validAfter: null,
    beneficialOnly: false,
  };
}

function seedObservedPipeState({
  store,
  producerAddress,
  withPrincipal,
  token,
  contractId,
  myBalance,
  theirBalance,
  nonce,
}: {
  store: SqliteStateStore;
  producerAddress: string;
  withPrincipal: string;
  token: string | null;
  contractId: string;
  myBalance: string;
  theirBalance: string;
  nonce: string;
}): void {
  const pipeKey = canonicalPipeKey(token, producerAddress, withPrincipal);
  const pipeId = normalizePipeId(pipeKey);
  if (!pipeId) {
    throw new Error('failed to build pipe id in test');
  }

  const principal1IsProducer = pipeKey['principal-1'] === producerAddress;
  const balance1 = principal1IsProducer ? myBalance : theirBalance;
  const balance2 = principal1IsProducer ? theirBalance : myBalance;
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

describe('producer signing service', () => {
  it('signs transfer states and stores the latest signature pair', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        producerAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      const result = await service.signTransfer(transferPayload(producerAddress));

      expect(result.upsert.stored).toBe(true);
      expect(result.upsert.replaced).toBe(false);
      expect(result.request.forPrincipal).toBe(producerAddress);
      expect(result.request.action).toBe('1');
      expect(result.mySignature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(result.upsert.state.mySignature).toBe(result.mySignature);
      expect(result.upsert.state.theirSignature).toBe(COUNTERPARTY_SIGNATURE);
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('enforces action restrictions on /producer/signature-request', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      await expect(
        service.signSignatureRequest({
          ...transferPayload(producerAddress),
          action: '1',
        }),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
        statusCode: 400,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects requests when reject-all verifier mode is active', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({
      signatureVerifierMode: 'reject-all',
    });

    try {
      seedObservedPipeState({
        store,
        producerAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      await expect(
        service.signTransfer(transferPayload(producerAddress)),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
        statusCode: 401,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('requires amount for withdrawal signature requests', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        producerAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '200',
        theirBalance: '100',
        nonce: '4',
      });

      await expect(
        service.signSignatureRequest({
          ...transferPayload(producerAddress),
          action: '3',
          actor: COUNTERPARTY,
          amount: null,
          myBalance: '200',
          theirBalance: '50',
          nonce: '5',
        }),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
        statusCode: 400,
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects transfer when nonce is not higher than stored state', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        producerAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '800',
        theirBalance: '200',
        nonce: '4',
      });

      const first = await service.signTransfer(transferPayload(producerAddress));
      expect(first.upsert.stored).toBe(true);

      await expect(
        service.signTransfer(transferPayload(producerAddress)),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
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

  it('rejects transfer when producer balance decreases', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      seedObservedPipeState({
        store,
        producerAddress,
        withPrincipal: COUNTERPARTY,
        token: null,
        contractId: CONTRACT_ID,
        myBalance: '200',
        theirBalance: '100',
        nonce: '4',
      });

      await expect(
        service.signTransfer({
          ...transferPayload(producerAddress),
          myBalance: '150',
          theirBalance: '150',
          nonce: '5',
        }),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
        statusCode: 403,
        details: {
          reason: 'producer-balance-decrease',
        },
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });

  it('rejects transfer when no baseline state exists', async () => {
    const { producerAddress, dbFile, store, service } = makeHarness({});

    try {
      await expect(
        service.signTransfer(transferPayload(producerAddress)),
      ).rejects.toMatchObject<Partial<ProducerServiceError>>({
        statusCode: 409,
        details: {
          reason: 'unknown-pipe-state',
        },
      });
    } finally {
      cleanupDb(store, dbFile);
    }
  });
});
