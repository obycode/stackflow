import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeClosureEvent,
  normalizeSignatureState,
  parseUnsignedBigInt,
} from "./utils.js";

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return text;
}

function assertPositiveInt(value, fieldName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export class AgentStateStore {
  constructor({ dbFile, busyTimeoutMs = 5_000 }) {
    this.dbFile = assertNonEmptyString(dbFile, "dbFile");
    this.busyTimeoutMs = assertPositiveInt(busyTimeoutMs, "busyTimeoutMs");
    const dir = path.dirname(this.dbFile);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(this.dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_pipes (
        pipe_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        pipe_key_json TEXT NOT NULL,
        local_principal TEXT NOT NULL,
        counterparty_principal TEXT NOT NULL,
        token TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        last_chain_nonce TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signature_states (
        state_id TEXT PRIMARY KEY,
        pipe_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        pipe_key_json TEXT NOT NULL,
        for_principal TEXT NOT NULL,
        with_principal TEXT NOT NULL,
        token TEXT,
        my_balance TEXT NOT NULL,
        their_balance TEXT NOT NULL,
        nonce TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        my_signature TEXT NOT NULL,
        their_signature TEXT NOT NULL,
        secret TEXT,
        valid_after TEXT,
        beneficial_only INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_signature_states_pipe_for_nonce
        ON signature_states(pipe_id, for_principal, nonce);

      CREATE TABLE IF NOT EXISTS closures (
        txid TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        pipe_id TEXT NOT NULL,
        pipe_key_json TEXT NOT NULL,
        event_name TEXT NOT NULL,
        nonce TEXT NOT NULL,
        closer TEXT NOT NULL,
        block_height TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        closure_my_balance TEXT,
        disputed INTEGER NOT NULL DEFAULT 0,
        dispute_txid TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watcher_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_block_height TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO watcher_cursor (id, last_block_height, updated_at)
      VALUES (1, '0', datetime('now'))
      ON CONFLICT(id) DO NOTHING;
    `);

    this.upsertPipeStmt = this.db.prepare(`
      INSERT INTO tracked_pipes (
        pipe_id,
        contract_id,
        pipe_key_json,
        local_principal,
        counterparty_principal,
        token,
        status,
        last_chain_nonce,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pipe_id) DO UPDATE SET
        contract_id = excluded.contract_id,
        pipe_key_json = excluded.pipe_key_json,
        local_principal = excluded.local_principal,
        counterparty_principal = excluded.counterparty_principal,
        token = excluded.token,
        status = excluded.status,
        last_chain_nonce = excluded.last_chain_nonce,
        updated_at = excluded.updated_at
    `);
    this.listTrackedPipesStmt = this.db.prepare(`
      SELECT * FROM tracked_pipes ORDER BY updated_at DESC
    `);
    this.getTrackedPipeStmt = this.db.prepare(`
      SELECT * FROM tracked_pipes WHERE pipe_id = ?
    `);

    this.upsertSignatureStateStmt = this.db.prepare(`
      INSERT INTO signature_states (
        state_id,
        pipe_id,
        contract_id,
        pipe_key_json,
        for_principal,
        with_principal,
        token,
        my_balance,
        their_balance,
        nonce,
        action,
        actor,
        my_signature,
        their_signature,
        secret,
        valid_after,
        beneficial_only,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_id) DO UPDATE SET
        my_balance = excluded.my_balance,
        their_balance = excluded.their_balance,
        nonce = excluded.nonce,
        action = excluded.action,
        actor = excluded.actor,
        my_signature = excluded.my_signature,
        their_signature = excluded.their_signature,
        secret = excluded.secret,
        valid_after = excluded.valid_after,
        beneficial_only = excluded.beneficial_only,
        updated_at = excluded.updated_at
    `);
    this.getLatestSignatureStateStmt = this.db.prepare(`
      SELECT * FROM signature_states
      WHERE pipe_id = ?
        AND for_principal = ?
      ORDER BY CAST(nonce as INTEGER) DESC, updated_at DESC
      LIMIT 1
    `);

    this.insertClosureStmt = this.db.prepare(`
      INSERT INTO closures (
        txid,
        contract_id,
        pipe_id,
        pipe_key_json,
        event_name,
        nonce,
        closer,
        block_height,
        expires_at,
        closure_my_balance,
        disputed,
        dispute_txid,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(txid) DO UPDATE SET
        closure_my_balance = excluded.closure_my_balance,
        disputed = MAX(closures.disputed, excluded.disputed),
        dispute_txid = COALESCE(closures.dispute_txid, excluded.dispute_txid)
    `);
    this.markClosureDisputedStmt = this.db.prepare(`
      UPDATE closures
      SET disputed = 1,
          dispute_txid = ?
      WHERE txid = ?
    `);
    this.getClosureStmt = this.db.prepare(`
      SELECT * FROM closures WHERE txid = ?
    `);

    this.getCursorStmt = this.db.prepare(`
      SELECT last_block_height FROM watcher_cursor WHERE id = 1
    `);
    this.setCursorStmt = this.db.prepare(`
      UPDATE watcher_cursor
      SET last_block_height = ?,
          updated_at = ?
      WHERE id = 1
    `);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  assertOpen() {
    if (!this.db) {
      throw new Error("state store is closed");
    }
  }

  upsertTrackedPipe({
    pipeId,
    contractId,
    pipeKey,
    localPrincipal,
    counterpartyPrincipal,
    token = null,
    status = "open",
    lastChainNonce = null,
  }) {
    this.assertOpen();
    this.upsertPipeStmt.run(
      assertNonEmptyString(pipeId, "pipeId"),
      assertNonEmptyString(contractId, "contractId"),
      JSON.stringify(pipeKey),
      assertNonEmptyString(localPrincipal, "localPrincipal"),
      assertNonEmptyString(counterpartyPrincipal, "counterpartyPrincipal"),
      token ? String(token).trim() : null,
      String(status || "open"),
      lastChainNonce == null ? null : String(lastChainNonce),
      new Date().toISOString(),
    );
  }

  listTrackedPipes() {
    this.assertOpen();
    const rows = this.listTrackedPipesStmt.all();
    return rows.map((row) => ({
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      pipeKey: JSON.parse(row.pipe_key_json),
      localPrincipal: row.local_principal,
      counterpartyPrincipal: row.counterparty_principal,
      token: row.token,
      status: row.status,
      lastChainNonce: row.last_chain_nonce,
      updatedAt: row.updated_at,
    }));
  }

  getTrackedPipe(pipeId) {
    this.assertOpen();
    const row = this.getTrackedPipeStmt.get(assertNonEmptyString(pipeId, "pipeId"));
    if (!row) {
      return null;
    }
    return {
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      pipeKey: JSON.parse(row.pipe_key_json),
      localPrincipal: row.local_principal,
      counterpartyPrincipal: row.counterparty_principal,
      token: row.token,
      status: row.status,
      lastChainNonce: row.last_chain_nonce,
      updatedAt: row.updated_at,
    };
  }

  upsertSignatureState(input) {
    this.assertOpen();
    const state = normalizeSignatureState(input);
    const stateId = `${state.pipeId}|${state.forPrincipal}`;

    const existing = this.getLatestSignatureState(state.pipeId, state.forPrincipal);
    if (existing) {
      const existingNonce = parseUnsignedBigInt(existing.nonce, "existing nonce");
      const incomingNonce = parseUnsignedBigInt(state.nonce, "incoming nonce");
      if (incomingNonce < existingNonce) {
        return {
          stored: false,
          reason: "nonce-too-low",
          state: existing,
        };
      }
    }

    this.upsertSignatureStateStmt.run(
      stateId,
      state.pipeId,
      state.contractId,
      JSON.stringify(state.pipeKey),
      state.forPrincipal,
      state.withPrincipal,
      state.token,
      state.myBalance,
      state.theirBalance,
      state.nonce,
      state.action,
      state.actor,
      state.mySignature,
      state.theirSignature,
      state.secret,
      state.validAfter,
      state.beneficialOnly ? 1 : 0,
      state.updatedAt,
    );

    return {
      stored: true,
      reason: existing ? "replaced" : "stored",
      state,
    };
  }

  getLatestSignatureState(pipeId, forPrincipal) {
    this.assertOpen();
    const row = this.getLatestSignatureStateStmt.get(
      assertNonEmptyString(pipeId, "pipeId"),
      assertNonEmptyString(forPrincipal, "forPrincipal"),
    );
    if (!row) {
      return null;
    }
    return {
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      pipeKey: JSON.parse(row.pipe_key_json),
      forPrincipal: row.for_principal,
      withPrincipal: row.with_principal,
      token: row.token,
      myBalance: row.my_balance,
      theirBalance: row.their_balance,
      nonce: row.nonce,
      action: row.action,
      actor: row.actor,
      mySignature: row.my_signature,
      theirSignature: row.their_signature,
      secret: row.secret,
      validAfter: row.valid_after,
      beneficialOnly: row.beneficial_only === 1,
      updatedAt: row.updated_at,
    };
  }

  recordClosure(event) {
    this.assertOpen();
    const closure = normalizeClosureEvent(event);
    this.insertClosureStmt.run(
      closure.txid,
      closure.contractId,
      closure.pipeId,
      JSON.stringify(closure.pipeKey),
      closure.eventName,
      closure.nonce,
      closure.closer,
      closure.blockHeight,
      closure.expiresAt,
      closure.closureMyBalance ?? null,
      0,
      null,
      new Date().toISOString(),
    );
    return closure;
  }

  markClosureDisputed({ txid, disputeTxid }) {
    this.assertOpen();
    this.markClosureDisputedStmt.run(
      assertNonEmptyString(disputeTxid, "disputeTxid"),
      assertNonEmptyString(txid, "txid"),
    );
  }

  getClosure(txid) {
    this.assertOpen();
    const row = this.getClosureStmt.get(assertNonEmptyString(txid, "txid"));
    if (!row) {
      return null;
    }
    return {
      txid: row.txid,
      contractId: row.contract_id,
      pipeId: row.pipe_id,
      pipeKey: JSON.parse(row.pipe_key_json),
      eventName: row.event_name,
      nonce: row.nonce,
      closer: row.closer,
      blockHeight: row.block_height,
      expiresAt: row.expires_at,
      closureMyBalance: row.closure_my_balance,
      disputed: row.disputed === 1,
      disputeTxid: row.dispute_txid,
      createdAt: row.created_at,
    };
  }

  getWatcherCursor() {
    this.assertOpen();
    const row = this.getCursorStmt.get();
    return row ? row.last_block_height : "0";
  }

  setWatcherCursor(blockHeight) {
    this.assertOpen();
    this.setCursorStmt.run(
      String(blockHeight),
      new Date().toISOString(),
    );
  }
}
