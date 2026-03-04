import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return text;
}

function assertUintString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${fieldName} must be a uint string`);
  }
  return text;
}

function assertPositiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export function buildPipeStateKey({
  contractId,
  forPrincipal,
  withPrincipal,
  token = null,
}) {
  const contract = assertNonEmptyString(contractId, "contractId");
  const forP = assertNonEmptyString(forPrincipal, "forPrincipal");
  const withP = assertNonEmptyString(withPrincipal, "withPrincipal");
  const tokenPart = token ? String(token).trim() : "stx";
  return `${contract}|${tokenPart}|${forP}|${withP}`;
}

export function computeProofHash({ method, pathQuery, proof }) {
  const canonicalMethod = String(method || "GET").toUpperCase();
  const canonicalPathQuery = String(pathQuery || "/");
  return createHash("sha256")
    .update(canonicalMethod)
    .update("\n")
    .update(canonicalPathQuery)
    .update("\n")
    .update(JSON.stringify(proof))
    .digest("hex");
}

export class SqliteX402StateStore {
  constructor({
    dbFile,
    lockTtlMs = 15_000,
    lockWaitTimeoutMs = 5_000,
    lockPollIntervalMs = 50,
    busyTimeoutMs = 5_000,
  }) {
    this.dbFile = assertNonEmptyString(dbFile, "dbFile");
    this.lockTtlMs = assertPositiveInteger(lockTtlMs, "lockTtlMs");
    this.lockWaitTimeoutMs = assertPositiveInteger(lockWaitTimeoutMs, "lockWaitTimeoutMs");
    this.lockPollIntervalMs = assertPositiveInteger(lockPollIntervalMs, "lockPollIntervalMs");
    this.busyTimeoutMs = assertPositiveInteger(busyTimeoutMs, "busyTimeoutMs");

    const directory = path.dirname(this.dbFile);
    fs.mkdirSync(directory, { recursive: true });

    this.db = new DatabaseSync(this.dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipe_states (
        pipe_key TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        for_principal TEXT NOT NULL,
        with_principal TEXT NOT NULL,
        token TEXT,
        nonce TEXT NOT NULL,
        my_balance TEXT NOT NULL,
        their_balance TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consumed_proofs (
        proof_hash TEXT PRIMARY KEY,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_consumed_proofs_expires
        ON consumed_proofs(expires_at_ms);

      CREATE TABLE IF NOT EXISTS pipe_locks (
        pipe_key TEXT PRIMARY KEY,
        lock_token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pipe_locks_expires
        ON pipe_locks(expires_at_ms);
    `);

    this.selectPipeStateStmt = this.db.prepare(`
      SELECT *
      FROM pipe_states
      WHERE pipe_key = ?
    `);
    this.upsertPipeStateStmt = this.db.prepare(`
      INSERT INTO pipe_states (
        pipe_key,
        contract_id,
        for_principal,
        with_principal,
        token,
        nonce,
        my_balance,
        their_balance,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pipe_key) DO UPDATE SET
        contract_id = excluded.contract_id,
        for_principal = excluded.for_principal,
        with_principal = excluded.with_principal,
        token = excluded.token,
        nonce = excluded.nonce,
        my_balance = excluded.my_balance,
        their_balance = excluded.their_balance,
        updated_at_ms = excluded.updated_at_ms
    `);

    this.upsertConsumedProofStmt = this.db.prepare(`
      INSERT INTO consumed_proofs (
        proof_hash,
        expires_at_ms,
        created_at_ms
      ) VALUES (?, ?, ?)
      ON CONFLICT(proof_hash) DO UPDATE SET
        expires_at_ms = excluded.expires_at_ms
    `);
    this.selectConsumedProofStmt = this.db.prepare(`
      SELECT proof_hash
      FROM consumed_proofs
      WHERE proof_hash = ?
        AND expires_at_ms > ?
    `);
    this.deleteExpiredConsumedStmt = this.db.prepare(`
      DELETE FROM consumed_proofs
      WHERE expires_at_ms <= ?
    `);

    this.tryAcquirePipeLockStmt = this.db.prepare(`
      INSERT INTO pipe_locks (
        pipe_key,
        lock_token,
        expires_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(pipe_key) DO UPDATE SET
        lock_token = excluded.lock_token,
        expires_at_ms = excluded.expires_at_ms,
        updated_at_ms = excluded.updated_at_ms
      WHERE pipe_locks.expires_at_ms <= ?
    `);
    this.releasePipeLockStmt = this.db.prepare(`
      DELETE FROM pipe_locks
      WHERE pipe_key = ?
        AND lock_token = ?
    `);
    this.deleteExpiredLocksStmt = this.db.prepare(`
      DELETE FROM pipe_locks
      WHERE expires_at_ms <= ?
    `);
  }

  close() {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  assertOpen() {
    if (!this.db) {
      throw new Error("SQLite store is closed");
    }
  }

  getPipeState(pipeKey) {
    this.assertOpen();
    const key = assertNonEmptyString(pipeKey, "pipeKey");
    const row = this.selectPipeStateStmt.get(key);
    if (!row) {
      return null;
    }
    return {
      pipeKey: row.pipe_key,
      contractId: row.contract_id,
      forPrincipal: row.for_principal,
      withPrincipal: row.with_principal,
      token: row.token,
      nonce: row.nonce,
      myBalance: row.my_balance,
      theirBalance: row.their_balance,
      updatedAtMs: Number.parseInt(String(row.updated_at_ms), 10),
    };
  }

  setPipeState(state) {
    this.assertOpen();
    const pipeKey = assertNonEmptyString(state.pipeKey, "state.pipeKey");
    const contractId = assertNonEmptyString(state.contractId, "state.contractId");
    const forPrincipal = assertNonEmptyString(state.forPrincipal, "state.forPrincipal");
    const withPrincipal = assertNonEmptyString(state.withPrincipal, "state.withPrincipal");
    const token = state.token == null ? null : String(state.token).trim();
    const nonce = assertUintString(state.nonce, "state.nonce");
    const myBalance = assertUintString(state.myBalance, "state.myBalance");
    const theirBalance = assertUintString(state.theirBalance, "state.theirBalance");
    const updatedAtMs = Date.now();

    this.upsertPipeStateStmt.run(
      pipeKey,
      contractId,
      forPrincipal,
      withPrincipal,
      token,
      nonce,
      myBalance,
      theirBalance,
      updatedAtMs,
    );
  }

  markConsumedProof(proofHash, expiresAtMs) {
    this.assertOpen();
    const hash = assertNonEmptyString(proofHash, "proofHash").toLowerCase();
    const expires = assertPositiveInteger(expiresAtMs, "expiresAtMs");
    const createdAtMs = Date.now();
    this.upsertConsumedProofStmt.run(hash, expires, createdAtMs);
  }

  isProofConsumed(proofHash, nowMs = Date.now()) {
    this.assertOpen();
    const hash = assertNonEmptyString(proofHash, "proofHash").toLowerCase();
    const now = assertPositiveInteger(nowMs, "nowMs");
    return Boolean(this.selectConsumedProofStmt.get(hash, now));
  }

  purgeExpired(nowMs = Date.now()) {
    this.assertOpen();
    const now = assertPositiveInteger(nowMs, "nowMs");
    const consumed = this.deleteExpiredConsumedStmt.run(now);
    const locks = this.deleteExpiredLocksStmt.run(now);
    return {
      consumedDeleted: consumed.changes,
      locksDeleted: locks.changes,
    };
  }

  async acquirePipeLock(pipeKey, options = {}) {
    this.assertOpen();
    const key = assertNonEmptyString(pipeKey, "pipeKey");
    const timeoutMs = options.timeoutMs
      ? assertPositiveInteger(options.timeoutMs, "options.timeoutMs")
      : this.lockWaitTimeoutMs;
    const ttlMs = options.ttlMs
      ? assertPositiveInteger(options.ttlMs, "options.ttlMs")
      : this.lockTtlMs;
    const pollMs = options.pollIntervalMs
      ? assertPositiveInteger(options.pollIntervalMs, "options.pollIntervalMs")
      : this.lockPollIntervalMs;
    const deadline = Date.now() + timeoutMs;
    const token = randomUUID();

    while (Date.now() <= deadline) {
      const now = Date.now();
      const expiresAt = now + ttlMs;
      const result = this.tryAcquirePipeLockStmt.run(
        key,
        token,
        expiresAt,
        now,
        now,
      );
      if (result.changes > 0) {
        return token;
      }
      await sleep(pollMs);
    }

    throw new Error(`timed out acquiring lock for ${key}`);
  }

  releasePipeLock(pipeKey, lockToken) {
    this.assertOpen();
    const key = assertNonEmptyString(pipeKey, "pipeKey");
    const token = assertNonEmptyString(lockToken, "lockToken");
    const result = this.releasePipeLockStmt.run(key, token);
    return result.changes > 0;
  }

  async withPipeLock(pipeKey, fn, options = {}) {
    if (typeof fn !== "function") {
      throw new Error("fn must be a function");
    }
    const token = await this.acquirePipeLock(pipeKey, options);
    try {
      return await fn();
    } finally {
      this.releasePipeLock(pipeKey, token);
    }
  }
}
