import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const STACKFLOW_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');
const GATEWAY_ENTRY = path.join(ROOT, 'server', 'dist', 'x402-gateway.js');
const CONTRACT_ID = 'ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0';
const P1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const P2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const COUNTERPARTY_SIGNER_KEY =
  '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const SIG_B = `0x${'22'.repeat(65)}`;

function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupDbFiles(dbFile) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbFile}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate free port'));
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

async function waitForHealth(baseUrl, label, child, logsRef) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before health check.\n${logsRef.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`${label} health timeout.\n${logsRef.join('')}`);
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected status ${expected}, got ${response.status}`);
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function peerHeaders(seed) {
  return {
    'content-type': 'application/json',
    'x-stackflow-protocol-version': '1',
    'x-stackflow-request-id': `demo-req-${seed}`,
    'idempotency-key': `demo-idem-${seed}`,
  };
}

function hashSecret(secretHex) {
  const normalized = secretHex.startsWith('0x') ? secretHex.slice(2) : secretHex;
  return `0x${createHash('sha256').update(Buffer.from(normalized, 'hex')).digest('hex')}`;
}

function transferPayload({
  forPrincipal,
  withPrincipal,
  myBalance,
  theirBalance,
  nonce,
  hashedSecret,
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

function forwardingPayload({
  paymentId,
  incomingAmount,
  outgoingAmount,
  hashedSecret,
  incoming,
  outgoingBaseUrl,
  outgoingPayload,
}) {
  return {
    paymentId,
    incomingAmount,
    outgoingAmount,
    hashedSecret,
    incoming,
    outgoing: {
      baseUrl: outgoingBaseUrl,
      endpoint: '/counterparty/transfer',
      payload: outgoingPayload,
    },
  };
}

async function startUpstreamServer(port) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'demo-upstream' }));
      return;
    }
    if (request.method === 'GET' && pathname === '/paid-content') {
      const verified = request.headers['x-stackflow-x402-verified'] === 'true';
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          ok: true,
          source: 'upstream',
          content: 'premium payload',
          x402Verified: verified,
          proofHash:
            typeof request.headers['x-stackflow-x402-proof-hash'] === 'string'
              ? request.headers['x-stackflow-x402-proof-hash']
              : null,
        }),
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startMockNextHopServer(port) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = {};
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = {};
        }
      }

      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, service: 'demo-next-hop' }));
        return;
      }
      if (request.method === 'POST' && pathname === '/counterparty/transfer') {
        requests.push({ headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            ok: true,
            mySignature: `0x${'11'.repeat(65)}`,
            theirSignature: SIG_B,
          }),
        );
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    stop: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startChildProcess({ label, entry, env, healthBaseUrl }) {
  const logsRef = [];
  const child = spawn('node', [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logsRef.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => logsRef.push(chunk.toString('utf8')));

  await waitForHealth(healthBaseUrl, label, child, logsRef);

  return {
    logs: logsRef,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}

async function runDemo() {
  console.log('[demo] building stackflow server artifacts...');
  execFileSync('npm', ['run', '-s', 'build:stackflow-node'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const stackflowPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const upstreamPort = await getFreePort();
  const nextHopPort = await getFreePort();
  const dbFile = path.join(
    os.tmpdir(),
    `stackflow-x402-demo-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );

  const stackflowBaseUrl = `http://127.0.0.1:${stackflowPort}`;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  const upstream = await startUpstreamServer(upstreamPort);
  const nextHop = await startMockNextHopServer(nextHopPort);
  const stackflow = await startChildProcess({
    label: 'stackflow-node',
    entry: STACKFLOW_ENTRY,
    healthBaseUrl: stackflowBaseUrl,
    env: {
      STACKFLOW_NODE_HOST: '127.0.0.1',
      STACKFLOW_NODE_PORT: String(stackflowPort),
      STACKFLOW_NODE_DB_FILE: dbFile,
      STACKFLOW_CONTRACTS: CONTRACT_ID,
      STACKFLOW_NODE_SIGNATURE_VERIFIER_MODE: 'accept-all',
      STACKFLOW_NODE_DISPUTE_EXECUTOR_MODE: 'noop',
      STACKFLOW_NODE_COUNTERPARTY_KEY: COUNTERPARTY_SIGNER_KEY,
      STACKFLOW_NODE_FORWARDING_ENABLED: 'true',
      STACKFLOW_NODE_FORWARDING_MIN_FEE: '1',
      STACKFLOW_NODE_FORWARDING_ALLOW_PRIVATE_DESTINATIONS: 'true',
      STACKFLOW_NODE_FORWARDING_ALLOWED_BASE_URLS: nextHop.baseUrl,
    },
  });

  const gateway = await startChildProcess({
    label: 'x402-gateway',
    entry: GATEWAY_ENTRY,
    healthBaseUrl: gatewayBaseUrl,
    env: {
      STACKFLOW_X402_GATEWAY_HOST: '127.0.0.1',
      STACKFLOW_X402_GATEWAY_PORT: String(gatewayPort),
      STACKFLOW_X402_UPSTREAM_BASE_URL: upstream.baseUrl,
      STACKFLOW_X402_STACKFLOW_NODE_BASE_URL: stackflowBaseUrl,
      STACKFLOW_X402_PROTECTED_PATH: '/paid-content',
      STACKFLOW_X402_PRICE_AMOUNT: '10',
      STACKFLOW_X402_PRICE_ASSET: 'STX',
      STACKFLOW_X402_INDIRECT_WAIT_TIMEOUT_MS: '15000',
      STACKFLOW_X402_INDIRECT_POLL_INTERVAL_MS: '250',
    },
  });

  try {
    console.log('[demo] services ready');

    const health = await fetchJson(`${stackflowBaseUrl}/health`);
    assertStatus(health.response, 200, 'stackflow health');
    if (!health.body || typeof health.body !== 'object') {
      throw new Error('invalid stackflow health payload');
    }
    const counterpartyPrincipal = health.body.counterpartyPrincipal;
    if (typeof counterpartyPrincipal !== 'string') {
      throw new Error('counterparty principal missing in stackflow health response');
    }
    const requestorPrincipal = counterpartyPrincipal === P1 ? P2 : P1;

    const baseline = {
      contractId: CONTRACT_ID,
      forPrincipal: counterpartyPrincipal,
      withPrincipal: requestorPrincipal,
      token: null,
      myBalance: '900',
      theirBalance: '100',
      mySignature: `0x${'11'.repeat(65)}`,
      theirSignature: SIG_B,
      nonce: '5',
      action: '1',
      actor: requestorPrincipal,
      secret: null,
      validAfter: null,
      beneficialOnly: false,
    };
    const seedBaseline = await fetchJson(`${stackflowBaseUrl}/signature-states`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseline),
    });
    assertStatus(seedBaseline.response, 200, 'seed baseline');
    console.log('[demo] baseline state seeded');

    const unpaid = await fetchJson(`${gatewayBaseUrl}/paid-content`);
    assertStatus(unpaid.response, 402, 'unpaid request');
    console.log('[demo] unpaid -> 402 confirmed');

    const directProof = {
      mode: 'direct',
      proof: transferPayload({
        forPrincipal: counterpartyPrincipal,
        withPrincipal: requestorPrincipal,
        myBalance: '910',
        theirBalance: '90',
        nonce: '6',
      }),
    };
    directProof.proof.amount = '10';

    const direct = await fetchJson(`${gatewayBaseUrl}/paid-content`, {
      method: 'GET',
      headers: {
        'x-x402-payment': toBase64UrlJson(directProof),
      },
    });
    assertStatus(direct.response, 200, 'direct paid request');
    if (!direct.body || typeof direct.body !== 'object' || direct.body.x402Verified !== true) {
      throw new Error('direct paid request did not reach upstream as verified');
    }
    console.log('[demo] direct payment -> payload delivered');

    const indirectSecret =
      '0x8484848484848484848484848484848484848484848484848484848484848484';
    const hashedSecret = hashSecret(indirectSecret);
    const indirectPaymentId = `pay-indirect-${Date.now()}`;

    const indirectProof = {
      mode: 'indirect',
      paymentId: indirectPaymentId,
      secret: indirectSecret,
      expectedFromPrincipal: requestorPrincipal,
    };

    const indirectStartedAt = Date.now();
    const indirectRequestPromise = fetchJson(`${gatewayBaseUrl}/paid-content`, {
      method: 'GET',
      headers: {
        'x-x402-payment': toBase64UrlJson(indirectProof),
      },
    });

    await sleep(1200);
    const forward = await fetchJson(`${stackflowBaseUrl}/forwarding/transfer`, {
      method: 'POST',
      headers: peerHeaders(`indirect-${Date.now()}`),
      body: JSON.stringify(
        forwardingPayload({
          paymentId: indirectPaymentId,
          incomingAmount: '100',
          outgoingAmount: '90',
          hashedSecret,
          incoming: transferPayload({
            forPrincipal: counterpartyPrincipal,
            withPrincipal: requestorPrincipal,
            myBalance: '920',
            theirBalance: '80',
            nonce: '7',
            hashedSecret,
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
            hashedSecret,
            secret: null,
            validAfter: null,
            beneficialOnly: false,
          },
        }),
      ),
    });
    assertStatus(forward.response, 200, 'create forwarding payment for indirect mode');

    const indirect = await indirectRequestPromise;
    const indirectDurationMs = Date.now() - indirectStartedAt;
    assertStatus(indirect.response, 200, 'indirect paid request');
    if (!indirect.body || typeof indirect.body !== 'object' || indirect.body.x402Verified !== true) {
      throw new Error('indirect paid request did not reach upstream as verified');
    }
    console.log(
      `[demo] indirect payment (wait + reveal) -> payload delivered (waited ${indirectDurationMs}ms)`,
    );

    const paymentCheck = await fetchJson(
      `${stackflowBaseUrl}/forwarding/payments?paymentId=${encodeURIComponent(indirectPaymentId)}`,
    );
    assertStatus(paymentCheck.response, 200, 'forwarding payment check');
    if (
      !paymentCheck.body ||
      typeof paymentCheck.body !== 'object' ||
      !paymentCheck.body.payment ||
      typeof paymentCheck.body.payment !== 'object' ||
      !paymentCheck.body.payment.revealedAt
    ) {
      throw new Error('forwarding payment does not show revealedAt after indirect flow');
    }
    console.log('[demo] forwarding payment reveal confirmed');

    console.log('\n[demo] success: unpaid, direct, and indirect x402 flows all completed');
    console.log(`[demo] stackflow-node: ${stackflowBaseUrl}`);
    console.log(`[demo] x402-gateway:  ${gatewayBaseUrl}`);
    console.log(`[demo] upstream app:  ${upstream.baseUrl}`);
  } finally {
    await gateway.stop().catch(() => {});
    await stackflow.stop().catch(() => {});
    await nextHop.stop().catch(() => {});
    await upstream.stop().catch(() => {});
    cleanupDbFiles(dbFile);
  }
}

runDemo().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[demo] failed: ${message}`);
  process.exit(1);
});
