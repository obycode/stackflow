import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ForwardingService,
  ForwardingServiceError,
} from '../server/src/forwarding-service.ts';

const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';
const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const SIG_B = `0x${'22'.repeat(65)}`;
const HASHED_SECRET =
  '0x46d74c485561af789b3e3f76ea7eb83db34b07dabe75cb50c9910c4d161c42fb';
const VALID_SECRET =
  '0x8484848484848484848484848484848484848484848484848484848484848484';

function makeTransferPayload() {
  return {
    contractId: CONTRACT_ID,
    forPrincipal: P1,
    withPrincipal: P2,
    token: null,
    amount: '0',
    myBalance: '910',
    theirBalance: '90',
    theirSignature: SIG_B,
    nonce: '6',
    action: '1',
    actor: P2,
    secret: null,
    validAfter: null,
    beneficialOnly: false,
  };
}

describe('forwarding service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes transfer payloads and signs incoming update after next-hop accepts', async () => {
    const signTransfer = vi.fn().mockResolvedValue({
      request: makeTransferPayload(),
      mySignature: `0x${'11'.repeat(65)}`,
      upsert: {
        stored: true,
        replaced: false,
        state: {
          mySignature: `0x${'11'.repeat(65)}`,
          theirSignature: SIG_B,
        },
      },
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            mySignature: `0x${'33'.repeat(65)}`,
            theirSignature: SIG_B,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    const service = new ForwardingService({
      counterpartyService: {
        enabled: true,
        counterpartyPrincipal: P1,
        signTransfer,
      } as any,
      config: {
        enabled: true,
        minFee: '5',
        timeoutMs: 1_000,
        allowPrivateDestinations: true,
        allowedBaseUrls: ['https://next-hop.example/'],
      },
    });

    const result = await service.processTransfer({
      paymentId: 'pay-2026-03-06-0001',
      incomingAmount: '100',
      outgoingAmount: '90',
      hashedSecret: HASHED_SECRET,
      incoming: makeTransferPayload(),
      outgoing: {
        baseUrl: 'https://next-hop.example',
        payload: makeTransferPayload(),
      },
    });

    expect(result.feeAmount).toBe('10');
    expect(result.nextHopBaseUrl).toBe('https://next-hop.example');
    expect(result.hashedSecret).toBe(HASHED_SECRET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://next-hop.example/counterparty/transfer');
    expect(init.method).toBe('POST');

    const nextHopBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(nextHopBody.hashedSecret).toBe(HASHED_SECRET);
    expect(nextHopBody.secret).toBe(HASHED_SECRET);

    expect(signTransfer).toHaveBeenCalledTimes(1);
    const [incomingPayload] = signTransfer.mock.calls[0] as [Record<string, unknown>];
    expect(incomingPayload.hashedSecret).toBe(HASHED_SECRET);
    expect(incomingPayload.secret).toBe(HASHED_SECRET);
  });

  it('rejects private next-hop destinations by default', async () => {
    const signTransfer = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const service = new ForwardingService({
      counterpartyService: {
        enabled: true,
        counterpartyPrincipal: P1,
        signTransfer,
      } as any,
      config: {
        enabled: true,
        minFee: '1',
        timeoutMs: 1_000,
        allowPrivateDestinations: false,
        allowedBaseUrls: [],
      },
    });

    await expect(
      service.processTransfer({
        paymentId: 'pay-2026-03-06-0002',
        incomingAmount: '100',
        outgoingAmount: '99',
        hashedSecret: HASHED_SECRET,
        incoming: makeTransferPayload(),
        outgoing: {
          baseUrl: 'http://127.0.0.1:3999',
          payload: makeTransferPayload(),
        },
      }),
    ).rejects.toMatchObject<Partial<ForwardingServiceError>>({
      statusCode: 403,
      details: {
        reason: 'next-hop-private-destination',
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signTransfer).not.toHaveBeenCalled();
  });

  it('rejects negative forwarding fee before side effects', async () => {
    const signTransfer = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const service = new ForwardingService({
      counterpartyService: {
        enabled: true,
        counterpartyPrincipal: P1,
        signTransfer,
      } as any,
      config: {
        enabled: true,
        minFee: '1',
        timeoutMs: 1_000,
        allowPrivateDestinations: true,
        allowedBaseUrls: ['https://next-hop.example'],
      },
    });

    await expect(
      service.processTransfer({
        paymentId: 'pay-2026-03-06-0003',
        incomingAmount: '90',
        outgoingAmount: '100',
        hashedSecret: HASHED_SECRET,
        incoming: makeTransferPayload(),
        outgoing: {
          baseUrl: 'https://next-hop.example',
          payload: makeTransferPayload(),
        },
      }),
    ).rejects.toMatchObject<Partial<ForwardingServiceError>>({
      statusCode: 403,
      details: {
        reason: 'negative-forwarding-fee',
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signTransfer).not.toHaveBeenCalled();
  });

  it('verifies reveal preimage secrets', () => {
    const service = new ForwardingService({
      counterpartyService: {
        enabled: true,
        counterpartyPrincipal: P1,
        signTransfer: vi.fn(),
      } as any,
      config: {
        enabled: true,
        minFee: '1',
        timeoutMs: 1_000,
        allowPrivateDestinations: true,
        allowedBaseUrls: [],
      },
    });

    expect(
      service.verifyRevealSecret({
        hashedSecret: HASHED_SECRET,
        secret: VALID_SECRET,
      }),
    ).toEqual({
      hashedSecret: HASHED_SECRET,
      secret: VALID_SECRET,
    });

    expect(() =>
      service.verifyRevealSecret({
        hashedSecret: HASHED_SECRET,
        secret: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).toThrowError(ForwardingServiceError);

    expect(() =>
      service.verifyRevealSecret({
        hashedSecret: HASHED_SECRET,
        secret: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).toThrow(/secret does not match hashedSecret/i);
  });
});
