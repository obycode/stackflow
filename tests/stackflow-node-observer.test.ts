import {
  contractPrincipalCV,
  noneCV,
  principalCV,
  serializeCV,
  someCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { describe, expect, it } from 'vitest';

import {
  extractStackflowPrintEvents,
  normalizePipeId,
} from '../server/src/observer-parser.ts';

const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const CLOSER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

function toHex(cv: ReturnType<typeof tupleCV>) {
  return `0x${serializeCV(cv)}`;
}

function printEventHex(eventName: string) {
  return toHex(
    tupleCV({
      event: stringAsciiCV(eventName),
      sender: principalCV(P1),
      'pipe-key': tupleCV({
        'principal-1': principalCV(P1),
        'principal-2': principalCV(P2),
        token: someCV(contractPrincipalCV(CLOSER, 'stackflow-token-0-6-0')),
      }),
      pipe: tupleCV({
        'balance-1': uintCV(100),
        'balance-2': uintCV(200),
        'expires-at': uintCV(500),
        nonce: uintCV(9),
        closer: someCV(principalCV(CLOSER)),
      }),
    }),
  );
}

const DEVNET_FUND_PIPE_RAW_VALUE =
  '0x0c0000000506616d6f756e7401000000000000000000000000003d0900056576656e740d0000000966756e642d7069706504706970650c000000070962616c616e63652d3101000000000000000000000000000000000962616c616e63652d32010000000000000000000000000000000006636c6f736572090a657870697265732d617401ffffffffffffffffffffffffffffffff056e6f6e636501000000000000000000000000000000000970656e64696e672d310a0c0000000206616d6f756e7401000000000000000000000000003d09000b6275726e2d686569676874010000000000000000000000000000009f0970656e64696e672d320908706970652d6b65790c000000030b7072696e636970616c2d31051a7321b74e2b6a7e949e6c4ad313035b16650950170b7072696e636970616c2d32051aa009ef082269f8c8de591acaa265d61bbebd225105746f6b656e090673656e646572051a7321b74e2b6a7e949e6c4ad313035b1665095017';

describe('watchtower event parser', () => {
  it('extracts stackflow print events and decodes pipe metadata', () => {
    const payload = {
      block_height: 123,
      events: [
        {
          txid: '0xabc',
          event_index: 2,
          type: 'contract_event',
          contract_event: {
            contract_identifier:
              'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0',
            topic: 'print',
            raw_value: printEventHex('force-close'),
          },
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.eventName).toBe('force-close');
    expect(event.txid).toBe('0xabc');
    expect(event.pipe?.nonce).toBe('9');
    expect(event.pipe?.['expires-at']).toBe('500');
    expect(normalizePipeId(event.pipeKey)).toBe(
      `${CLOSER}.stackflow-token-0-6-0|${P1}|${P2}`,
    );
  });

  it('ignores non-stackflow contracts by default', () => {
    const payload = {
      events: [
        {
          txid: '0xdef',
          event_index: 1,
          contract_event: {
            contract_identifier: `${CLOSER}.not-stackflow`,
            topic: 'print',
            raw_value: printEventHex('force-cancel'),
          },
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload);
    expect(events).toEqual([]);
  });

  it('does not parse repr when raw_value is missing', () => {
    const payload = {
      receipts: [
        {
          events: [
            {
              txid: '0xfeed',
              contract_log: {
                contract_identifier:
                  'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0',
                topic: 'print',
                value: {
                  repr: '(tuple (event "finalize") (pipe-key none))',
                },
              },
            },
          ],
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBeNull();
    expect(events[0].pipeKey).toBeNull();
    expect(events[0].pipe).toBeNull();
  });

  it('supports raw_value hex when value is repr string', () => {
    const payload = {
      block_height: 456,
      events: [
        {
          txid: '0xraw1',
          contract_event: {
            contract_identifier:
              'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0',
            topic: 'print',
            value: '(tuple (event "fund-pipe"))',
            raw_value: printEventHex('fund-pipe'),
          },
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('fund-pipe');
    expect(events[0].pipeKey).not.toBeNull();
    expect(events[0].pipe?.nonce).toBe('9');
  });

  it('parses real devnet event envelopes using raw_value only', () => {
    const payload = {
      events: [
        {
          committed: true,
          contract_event: {
            contract_identifier: `${CLOSER}.stackflow`,
            topic: 'print',
            raw_value: DEVNET_FUND_PIPE_RAW_VALUE,
            value: {
              Tuple: {
                data_map: {
                  event: {
                    Sequence: { String: { ASCII: { data: [102, 117, 110] } } },
                  },
                },
              },
            },
          },
          event_index: 1,
          txid: '0x350253c9b1a2a8b3eee41d895a24f7650ef30cbeed531c51b0b3d58333e1413b',
          type: 'contract_event',
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('fund-pipe');
    expect(events[0].txid).toBe(
      '0x350253c9b1a2a8b3eee41d895a24f7650ef30cbeed531c51b0b3d58333e1413b',
    );
    expect(events[0].eventIndex).toBe('1');
    expect(events[0].pipe?.nonce).toBe('0');
    expect(events[0].pipe?.['balance-1']).toBe('0');
    expect(events[0].pipe?.['balance-2']).toBe('0');
    expect(events[0].pipe?.['pending-1']?.amount).toBe('4000000');
    expect(events[0].pipe?.['pending-1']?.['burn-height']).toBe('159');
    expect(events[0].pipe?.['pending-2']).toBeNull();
    expect(events[0].pipeKey?.['principal-1']).toBe(P1);
    expect(events[0].pipeKey?.['principal-2']).toBe(
      'ST2G0KVR849MZHJ6YB4DCN8K5TRDVXF92A664PHXT',
    );
    expect(events[0].pipeKey?.token).toBeNull();
  });

  it('supports explicit contract allowlists', () => {
    const payload = {
      events: [
        {
          txid: '0xallow',
          contract_event: {
            contract_identifier: `${CLOSER}.custom-flow`,
            topic: 'print',
            raw_value: toHex(
              tupleCV({
                event: stringAsciiCV('force-cancel'),
                sender: principalCV(P1),
                'pipe-key': tupleCV({
                  'principal-1': principalCV(P1),
                  'principal-2': principalCV(P2),
                  token: noneCV(),
                }),
                pipe: tupleCV({
                  'balance-1': uintCV(1),
                  'balance-2': uintCV(1),
                  'expires-at': uintCV(10),
                  nonce: uintCV(1),
                  closer: noneCV(),
                }),
              }),
            ),
          },
        },
      ],
    };

    const events = extractStackflowPrintEvents(payload, {
      watchedContracts: [`${CLOSER}.custom-flow`],
    });

    expect(events).toHaveLength(1);
    expect(events[0].contractId).toBe(`${CLOSER}.custom-flow`);
  });
});
