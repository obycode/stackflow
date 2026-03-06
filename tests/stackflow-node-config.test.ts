import { describe, expect, it } from 'vitest';

import { loadConfig } from '../server/src/config.ts';

const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

describe('stackflow-node config parsing', () => {
  it('loads sane defaults when env is empty', () => {
    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.maxRecentEvents).toBe(500);
    expect(config.stacksNetwork).toBe('devnet');
    expect(config.signatureVerifierMode).toBe('readonly');
    expect(config.disputeExecutorMode).toBe('auto');
    expect(config.forwardingTimeoutMs).toBe(10_000);
    expect(config.forwardingRevealRetryIntervalMs).toBe(15_000);
    expect(config.forwardingRevealRetryMaxAttempts).toBe(20);
    expect(config.dbFile).toContain('server/data/stackflow-node-state.db');
  });

  it('normalizes and de-duplicates watched principals', () => {
    const config = loadConfig({
      STACKFLOW_NODE_PRINCIPALS: ` ${P1},${P2},${P1} `,
    });

    expect(config.watchedPrincipals).toEqual([P1, P2]);
  });

  it('rejects invalid watched principal values', () => {
    expect(() =>
      loadConfig({
        STACKFLOW_NODE_PRINCIPALS: 'not-a-principal',
      }),
    ).toThrow();
  });

  it('rejects watched principal lists above max size', () => {
    const manyPrincipals = Array.from({ length: 101 }, (_, index) =>
      index % 2 === 0 ? P1 : P2,
    ).join(',');

    expect(() =>
      loadConfig({
        STACKFLOW_NODE_PRINCIPALS: manyPrincipals,
      }),
    ).toThrow(/exceeds max of 100/);
  });

  it('clamps and coerces numeric safety bounds', () => {
    const config = loadConfig({
      STACKFLOW_NODE_PEER_WRITE_RATE_LIMIT_PER_MINUTE: '-1',
      STACKFLOW_NODE_FORWARDING_MIN_FEE: '-99',
      STACKFLOW_NODE_FORWARDING_TIMEOUT_MS: '25',
      STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_INTERVAL_MS: '10',
      STACKFLOW_NODE_FORWARDING_REVEAL_RETRY_MAX_ATTEMPTS: '0',
    });

    expect(config.peerWriteRateLimitPerMinute).toBe(0);
    expect(config.forwardingMinFee).toBe('0');
    expect(config.forwardingTimeoutMs).toBe(1_000);
    expect(config.forwardingRevealRetryIntervalMs).toBe(1_000);
    expect(config.forwardingRevealRetryMaxAttempts).toBe(1);
  });

  it('normalizes forwarding base-url allowlists', () => {
    const config = loadConfig({
      STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS:
        ' https://node-b.example.com/path?x=1 , http://127.0.0.1:9797/ ',
    });

    expect(config.forwardingAllowedBaseUrls).toEqual([
      'https://node-b.example.com',
      'http://127.0.0.1:9797',
    ]);
  });

  it('rejects forwarding base-url allowlist entries that are not http/https', () => {
    expect(() =>
      loadConfig({
        STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS:
          'https://node-b.example.com,ftp://bad.example.com',
      }),
    ).toThrow(/must use http\/https/);
  });

  it('supports strict mode validation for enum and message version fields', () => {
    expect(() =>
      loadConfig({
        STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'bad-mode',
      }),
    ).toThrow(/SIGNATURE_VERIFIER_MODE/);

    expect(() =>
      loadConfig({
        STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'bad-mode',
      }),
    ).toThrow(/DISPUTE_EXECUTOR_MODE/);

    expect(() =>
      loadConfig({
        STACKFLOW_NODE_COUNTERPARTY_SIGNER_MODE: 'bad-mode',
      }),
    ).toThrow(/COUNTERPARTY_SIGNER_MODE/);

    expect(() =>
      loadConfig({
        STACKFLOW_NODE_STACKFLOW_MESSAGE_VERSION: '版本',
      }),
    ).toThrow(/must be ASCII/);
  });
});
