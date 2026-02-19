import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ClosureRecord,
  DisputeAttemptRecord,
  ObservedPipeRecord,
  PipeKey,
  RecordedStackflowNodeEvent,
  SignatureStateRecord,
  StackflowNodePersistedState,
} from './types.js';

interface SqliteStateStoreOptions {
  dbFile: string;
  maxRecentEvents?: number;
}

interface ClosureRow {
  pipe_id: string;
  contract_id: string;
  pipe_key_json: string;
  closer: string | null;
  expires_at: string | null;
  nonce: string | null;
  event: string;
  txid: string | null;
  block_height: string | null;
  updated_at: string;
}

interface ObservedPipeRow {
  state_id: string;
  pipe_id: string;
  contract_id: string;
  pipe_key_json: string;
  balance_1: string | null;
  balance_2: string | null;
  pending_1_amount: string | null;
  pending_1_burn_height: string | null;
  pending_2_amount: string | null;
  pending_2_burn_height: string | null;
  expires_at: string | null;
  nonce: string | null;
  closer: string | null;
  event: string;
  txid: string | null;
  block_height: string | null;
  updated_at: string;
}

interface SignatureStateRow {
  state_id: string;
  pipe_id: string;
  contract_id: string;
  for_principal: string;
  with_principal: string;
  token: string | null;
  amount: string;
  my_balance: string;
  their_balance: string;
  my_signature: string;
  their_signature: string;
  nonce: string;
  action: string;
  actor: string;
  secret: string | null;
  valid_after: string | null;
  beneficial_only: number;
  updated_at: string;
}

interface DisputeAttemptRow {
  attempt_id: string;
  contract_id: string;
  pipe_id: string;
  for_principal: string;
  trigger_txid: string | null;
  success: number;
  dispute_txid: string | null;
  error: string | null;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyState(value: unknown): value is StackflowNodePersistedState {
  if (!isRecord(value)) {
    return false;
  }

  const observedPipes = value.observedPipes;
  const observedPipesOk =
    observedPipes === undefined || isRecord(observedPipes);

  return (
    isRecord(value.activeClosures) &&
    observedPipesOk &&
    isRecord(value.signatureStates) &&
    isRecord(value.disputeAttempts) &&
    Array.isArray(value.recentEvents)
  );
}

function parsePipeKey(value: string): PipeKey | null {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }

    const principal1 = parsed['principal-1'];
    const principal2 = parsed['principal-2'];
    const token = parsed.token;

    if (typeof principal1 !== 'string' || typeof principal2 !== 'string') {
      return null;
    }

    return {
      'principal-1': principal1,
      'principal-2': principal2,
      token: typeof token === 'string' ? token : null,
    };
  } catch {
    return null;
  }
}

export class SqliteStateStore {
  private readonly dbFile: string;

  private readonly maxRecentEvents: number;

  private db: DatabaseSync | null;

  constructor({ dbFile, maxRecentEvents = 500 }: SqliteStateStoreOptions) {
    this.dbFile = dbFile;
    this.maxRecentEvents = maxRecentEvents;
    this.db = null;
  }

  load(): void {
    const directory = path.dirname(this.dbFile);
    fs.mkdirSync(directory, { recursive: true });

    const legacyState = this.loadLegacyJsonState();
    if (legacyState) {
      const backupFile = `${this.dbFile}.json-backup-${Date.now()}`;
      fs.renameSync(this.dbFile, backupFile);
      console.log(
        `[stackflow-node] migrated legacy JSON state to SQLite; backup=${backupFile}`,
      );
    }

    this.db = new DatabaseSync(this.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS closures (
        pipe_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        pipe_key_json TEXT NOT NULL,
        closer TEXT,
        expires_at TEXT,
        nonce TEXT,
        event TEXT NOT NULL,
        txid TEXT,
        block_height TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observed_pipes (
        state_id TEXT PRIMARY KEY,
        pipe_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        pipe_key_json TEXT NOT NULL,
        balance_1 TEXT,
        balance_2 TEXT,
        pending_1_amount TEXT,
        pending_1_burn_height TEXT,
        pending_2_amount TEXT,
        pending_2_burn_height TEXT,
        expires_at TEXT,
        nonce TEXT,
        closer TEXT,
        event TEXT NOT NULL,
        txid TEXT,
        block_height TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observed_pipes_pipe
        ON observed_pipes(contract_id, pipe_id);

      CREATE TABLE IF NOT EXISTS signature_states (
        state_id TEXT PRIMARY KEY,
        pipe_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        for_principal TEXT NOT NULL,
        with_principal TEXT NOT NULL,
        token TEXT,
        amount TEXT NOT NULL DEFAULT '0',
        my_balance TEXT NOT NULL,
        their_balance TEXT NOT NULL,
        my_signature TEXT NOT NULL,
        their_signature TEXT NOT NULL,
        nonce TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        secret TEXT,
        valid_after TEXT,
        beneficial_only INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signature_states_contract_pipe
        ON signature_states(contract_id, pipe_id);

      CREATE TABLE IF NOT EXISTS dispute_attempts (
        attempt_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        pipe_id TEXT NOT NULL,
        for_principal TEXT NOT NULL,
        trigger_txid TEXT,
        success INTEGER NOT NULL,
        dispute_txid TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dispute_attempts_created_at
        ON dispute_attempts(created_at DESC);

      CREATE TABLE IF NOT EXISTS recent_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);

    this.ensureObservedPipeColumns();
    this.ensureSignatureStateColumns();

    const setMeta = this.db.prepare(
      'INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)',
    );
    setMeta.run('version', '1');
    setMeta.run('updated_at', '');

    if (legacyState) {
      this.importLegacyState(legacyState);
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('state store not loaded');
    }
    return this.db;
  }

  private ensureObservedPipeColumns(): void {
    const db = this.getDb();
    const columns = db
      .prepare('PRAGMA table_info(observed_pipes)')
      .all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));

    const required: Array<{ name: string; type: string }> = [
      { name: 'pending_1_amount', type: 'TEXT' },
      { name: 'pending_1_burn_height', type: 'TEXT' },
      { name: 'pending_2_amount', type: 'TEXT' },
      { name: 'pending_2_burn_height', type: 'TEXT' },
    ];

    for (const column of required) {
      if (existing.has(column.name)) {
        continue;
      }

      db.exec(
        `ALTER TABLE observed_pipes ADD COLUMN ${column.name} ${column.type}`,
      );
    }
  }

  private ensureSignatureStateColumns(): void {
    const db = this.getDb();
    const columns = db
      .prepare('PRAGMA table_info(signature_states)')
      .all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));

    if (!existing.has('amount')) {
      db.exec("ALTER TABLE signature_states ADD COLUMN amount TEXT NOT NULL DEFAULT '0'");
    }
  }

  private loadLegacyJsonState(): StackflowNodePersistedState | null {
    if (!fs.existsSync(this.dbFile)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.dbFile, 'utf8');
      const trimmed = raw.trimStart();
      if (!trimmed.startsWith('{')) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!isLegacyState(parsed)) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  private importLegacyState(legacyState: StackflowNodePersistedState): void {
    const db = this.getDb();
    db.exec('BEGIN');
    try {
      const setMeta = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
      setMeta.run(String(legacyState.version || 1), 'version');
      setMeta.run(legacyState.updatedAt || '', 'updated_at');

      const insertClosure = db.prepare(`
        INSERT OR REPLACE INTO closures (
          pipe_id,
          contract_id,
          pipe_key_json,
          closer,
          expires_at,
          nonce,
          event,
          txid,
          block_height,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const closure of Object.values(legacyState.activeClosures || {})) {
        insertClosure.run(
          closure.pipeId,
          closure.contractId,
          JSON.stringify(closure.pipeKey),
          closure.closer,
          closure.expiresAt,
          closure.nonce,
          closure.event,
          closure.txid,
          closure.blockHeight,
          closure.updatedAt,
        );
      }

      const insertObservedPipe = db.prepare(`
        INSERT OR REPLACE INTO observed_pipes (
          state_id,
          pipe_id,
          contract_id,
          pipe_key_json,
          balance_1,
          balance_2,
          pending_1_amount,
          pending_1_burn_height,
          pending_2_amount,
          pending_2_burn_height,
          expires_at,
          nonce,
          closer,
          event,
          txid,
          block_height,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const observedPipe of Object.values(legacyState.observedPipes || {})) {
        insertObservedPipe.run(
          observedPipe.stateId,
          observedPipe.pipeId,
          observedPipe.contractId,
          JSON.stringify(observedPipe.pipeKey),
          observedPipe.balance1,
          observedPipe.balance2,
          observedPipe.pending1Amount ?? null,
          observedPipe.pending1BurnHeight ?? null,
          observedPipe.pending2Amount ?? null,
          observedPipe.pending2BurnHeight ?? null,
          observedPipe.expiresAt,
          observedPipe.nonce,
          observedPipe.closer,
          observedPipe.event,
          observedPipe.txid,
          observedPipe.blockHeight,
          observedPipe.updatedAt,
        );
      }

      const insertSignatureState = db.prepare(`
        INSERT OR REPLACE INTO signature_states (
          state_id,
          pipe_id,
          contract_id,
          for_principal,
          with_principal,
          token,
          amount,
          my_balance,
          their_balance,
          my_signature,
          their_signature,
          nonce,
          action,
          actor,
          secret,
          valid_after,
          beneficial_only,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const state of Object.values(legacyState.signatureStates || {})) {
        insertSignatureState.run(
          state.stateId,
          state.pipeId,
          state.contractId,
          state.forPrincipal,
          state.withPrincipal,
          state.token,
          state.amount ?? '0',
          state.myBalance,
          state.theirBalance,
          state.mySignature,
          state.theirSignature,
          state.nonce,
          state.action,
          state.actor,
          state.secret,
          state.validAfter,
          state.beneficialOnly ? 1 : 0,
          state.updatedAt,
        );
      }

      const insertDisputeAttempt = db.prepare(`
        INSERT OR REPLACE INTO dispute_attempts (
          attempt_id,
          contract_id,
          pipe_id,
          for_principal,
          trigger_txid,
          success,
          dispute_txid,
          error,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const attempt of Object.values(legacyState.disputeAttempts || {})) {
        insertDisputeAttempt.run(
          attempt.attemptId,
          attempt.contractId,
          attempt.pipeId,
          attempt.forPrincipal,
          attempt.triggerTxid,
          attempt.success ? 1 : 0,
          attempt.disputeTxid,
          attempt.error,
          attempt.createdAt,
        );
      }

      const insertEvent = db.prepare(
        'INSERT INTO recent_events (event_json, observed_at) VALUES (?, ?)',
      );
      for (const event of legacyState.recentEvents || []) {
        insertEvent.run(JSON.stringify(event), event.observedAt);
      }

      db.prepare(`
        DELETE FROM recent_events
        WHERE seq NOT IN (
          SELECT seq FROM recent_events
          ORDER BY seq DESC
          LIMIT ?
        )
      `).run(this.maxRecentEvents);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private touchUpdatedAt(): void {
    const db = this.getDb();
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      new Date().toISOString(),
      'updated_at',
    );
  }

  private getMeta(key: string): string | null {
    const db = this.getDb();
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (!row) {
      return null;
    }

    return row.value;
  }

  private mapClosureRow(row: ClosureRow): ClosureRecord | null {
    const pipeKey = parsePipeKey(row.pipe_key_json);
    if (!pipeKey) {
      return null;
    }

    return {
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      pipeKey,
      closer: row.closer,
      expiresAt: row.expires_at,
      nonce: row.nonce,
      event: row.event,
      txid: row.txid,
      blockHeight: row.block_height,
      updatedAt: row.updated_at,
    };
  }

  private mapObservedPipeRow(row: ObservedPipeRow): ObservedPipeRecord | null {
    const pipeKey = parsePipeKey(row.pipe_key_json);
    if (!pipeKey) {
      return null;
    }

    return {
      stateId: row.state_id,
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      pipeKey,
      balance1: row.balance_1,
      balance2: row.balance_2,
      pending1Amount: row.pending_1_amount,
      pending1BurnHeight: row.pending_1_burn_height,
      pending2Amount: row.pending_2_amount,
      pending2BurnHeight: row.pending_2_burn_height,
      expiresAt: row.expires_at,
      nonce: row.nonce,
      closer: row.closer,
      event: row.event,
      txid: row.txid,
      blockHeight: row.block_height,
      updatedAt: row.updated_at,
    };
  }

  private mapSignatureStateRow(row: SignatureStateRow): SignatureStateRecord {
    return {
      stateId: row.state_id,
      pipeId: row.pipe_id,
      contractId: row.contract_id,
      forPrincipal: row.for_principal,
      withPrincipal: row.with_principal,
      token: row.token,
      amount: row.amount ?? '0',
      myBalance: row.my_balance,
      theirBalance: row.their_balance,
      mySignature: row.my_signature,
      theirSignature: row.their_signature,
      nonce: row.nonce,
      action: row.action,
      actor: row.actor,
      secret: row.secret,
      validAfter: row.valid_after,
      beneficialOnly: row.beneficial_only === 1,
      updatedAt: row.updated_at,
    };
  }

  private mapDisputeAttemptRow(row: DisputeAttemptRow): DisputeAttemptRecord {
    return {
      attemptId: row.attempt_id,
      contractId: row.contract_id,
      pipeId: row.pipe_id,
      forPrincipal: row.for_principal,
      triggerTxid: row.trigger_txid,
      success: row.success === 1,
      disputeTxid: row.dispute_txid,
      error: row.error,
      createdAt: row.created_at,
    };
  }

  getSnapshot(): StackflowNodePersistedState {
    const db = this.getDb();

    const closureRows = db
      .prepare('SELECT * FROM closures')
      .all() as unknown as ClosureRow[];
    const observedPipeRows = db
      .prepare('SELECT * FROM observed_pipes')
      .all() as unknown as ObservedPipeRow[];
    const signatureRows = db
      .prepare('SELECT * FROM signature_states')
      .all() as unknown as SignatureStateRow[];
    const disputeRows = db
      .prepare('SELECT * FROM dispute_attempts')
      .all() as unknown as DisputeAttemptRow[];
    const eventRows = db
      .prepare('SELECT event_json FROM recent_events ORDER BY seq DESC')
      .all() as Array<{ event_json: string }>;

    const activeClosures: Record<string, ClosureRecord> = {};
    for (const row of closureRows) {
      const mapped = this.mapClosureRow(row);
      if (mapped) {
        activeClosures[mapped.pipeId] = mapped;
      }
    }

    const observedPipes: Record<string, ObservedPipeRecord> = {};
    for (const row of observedPipeRows) {
      const mapped = this.mapObservedPipeRow(row);
      if (mapped) {
        observedPipes[mapped.stateId] = mapped;
      }
    }

    const signatureStates: Record<string, SignatureStateRecord> = {};
    for (const row of signatureRows) {
      const mapped = this.mapSignatureStateRow(row);
      signatureStates[mapped.stateId] = mapped;
    }

    const disputeAttempts: Record<string, DisputeAttemptRecord> = {};
    for (const row of disputeRows) {
      const mapped = this.mapDisputeAttemptRow(row);
      disputeAttempts[mapped.attemptId] = mapped;
    }

    const recentEvents: RecordedStackflowNodeEvent[] = [];
    for (const row of eventRows) {
      try {
        const parsed = JSON.parse(row.event_json) as RecordedStackflowNodeEvent;
        recentEvents.push(parsed);
      } catch {
        // Skip corrupted rows to keep the store usable.
      }
    }

    return {
      version: Number.parseInt(this.getMeta('version') || '1', 10) || 1,
      updatedAt: this.getMeta('updated_at') || null,
      activeClosures,
      observedPipes,
      signatureStates,
      disputeAttempts,
      recentEvents,
    };
  }

  recordEvent(event: RecordedStackflowNodeEvent): void {
    const db = this.getDb();
    const insert = db.prepare(
      'INSERT INTO recent_events (event_json, observed_at) VALUES (?, ?)',
    );
    const prune = db.prepare(`
      DELETE FROM recent_events
      WHERE seq NOT IN (
        SELECT seq FROM recent_events
        ORDER BY seq DESC
        LIMIT ?
      )
    `);

    insert.run(JSON.stringify(event), event.observedAt);
    prune.run(this.maxRecentEvents);
    this.touchUpdatedAt();
  }

  setClosure(closure: ClosureRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO closures (
        pipe_id,
        contract_id,
        pipe_key_json,
        closer,
        expires_at,
        nonce,
        event,
        txid,
        block_height,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pipe_id) DO UPDATE SET
        contract_id = excluded.contract_id,
        pipe_key_json = excluded.pipe_key_json,
        closer = excluded.closer,
        expires_at = excluded.expires_at,
        nonce = excluded.nonce,
        event = excluded.event,
        txid = excluded.txid,
        block_height = excluded.block_height,
        updated_at = excluded.updated_at
    `).run(
      closure.pipeId,
      closure.contractId,
      JSON.stringify(closure.pipeKey),
      closure.closer,
      closure.expiresAt,
      closure.nonce,
      closure.event,
      closure.txid,
      closure.blockHeight,
      closure.updatedAt,
    );
    this.touchUpdatedAt();
  }

  deleteClosure(pipeId: string): void {
    const db = this.getDb();
    const result = db
      .prepare('DELETE FROM closures WHERE pipe_id = ?')
      .run(pipeId);

    if (result.changes > 0) {
      this.touchUpdatedAt();
    }
  }

  listClosures(): ClosureRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM closures')
      .all() as unknown as ClosureRow[];

    const closures: ClosureRecord[] = [];
    for (const row of rows) {
      const mapped = this.mapClosureRow(row);
      if (mapped) {
        closures.push(mapped);
      }
    }

    return closures;
  }

  setObservedPipe(state: ObservedPipeRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO observed_pipes (
        state_id,
        pipe_id,
        contract_id,
        pipe_key_json,
        balance_1,
        balance_2,
        pending_1_amount,
        pending_1_burn_height,
        pending_2_amount,
        pending_2_burn_height,
        expires_at,
        nonce,
        closer,
        event,
        txid,
        block_height,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_id) DO UPDATE SET
        pipe_id = excluded.pipe_id,
        contract_id = excluded.contract_id,
        pipe_key_json = excluded.pipe_key_json,
        balance_1 = excluded.balance_1,
        balance_2 = excluded.balance_2,
        pending_1_amount = excluded.pending_1_amount,
        pending_1_burn_height = excluded.pending_1_burn_height,
        pending_2_amount = excluded.pending_2_amount,
        pending_2_burn_height = excluded.pending_2_burn_height,
        expires_at = excluded.expires_at,
        nonce = excluded.nonce,
        closer = excluded.closer,
        event = excluded.event,
        txid = excluded.txid,
        block_height = excluded.block_height,
        updated_at = excluded.updated_at
    `).run(
      state.stateId,
      state.pipeId,
      state.contractId,
      JSON.stringify(state.pipeKey),
      state.balance1,
      state.balance2,
      state.pending1Amount,
      state.pending1BurnHeight,
      state.pending2Amount,
      state.pending2BurnHeight,
      state.expiresAt,
      state.nonce,
      state.closer,
      state.event,
      state.txid,
      state.blockHeight,
      state.updatedAt,
    );
    this.touchUpdatedAt();
  }

  deleteObservedPipe(stateId: string): void {
    const db = this.getDb();
    const result = db
      .prepare('DELETE FROM observed_pipes WHERE state_id = ?')
      .run(stateId);

    if (result.changes > 0) {
      this.touchUpdatedAt();
    }
  }

  listObservedPipes(): ObservedPipeRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM observed_pipes')
      .all() as unknown as ObservedPipeRow[];

    const observedPipes: ObservedPipeRecord[] = [];
    for (const row of rows) {
      const mapped = this.mapObservedPipeRow(row);
      if (mapped) {
        observedPipes.push(mapped);
      }
    }

    return observedPipes;
  }

  getSignatureStates(): SignatureStateRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM signature_states')
      .all() as unknown as SignatureStateRow[];
    return rows.map((row) => this.mapSignatureStateRow(row));
  }

  getSignatureStatesForPipe(
    contractId: string,
    pipeId: string,
  ): SignatureStateRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare(`
        SELECT * FROM signature_states
        WHERE contract_id = ? AND pipe_id = ?
      `)
      .all(contractId, pipeId) as unknown as SignatureStateRow[];
    return rows.map((row) => this.mapSignatureStateRow(row));
  }

  setSignatureState(state: SignatureStateRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO signature_states (
        state_id,
        pipe_id,
        contract_id,
        for_principal,
        with_principal,
        token,
        amount,
        my_balance,
        their_balance,
        my_signature,
        their_signature,
        nonce,
        action,
        actor,
        secret,
        valid_after,
        beneficial_only,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_id) DO UPDATE SET
        pipe_id = excluded.pipe_id,
        contract_id = excluded.contract_id,
        for_principal = excluded.for_principal,
        with_principal = excluded.with_principal,
        token = excluded.token,
        amount = excluded.amount,
        my_balance = excluded.my_balance,
        their_balance = excluded.their_balance,
        my_signature = excluded.my_signature,
        their_signature = excluded.their_signature,
        nonce = excluded.nonce,
        action = excluded.action,
        actor = excluded.actor,
        secret = excluded.secret,
        valid_after = excluded.valid_after,
        beneficial_only = excluded.beneficial_only,
        updated_at = excluded.updated_at
    `).run(
      state.stateId,
      state.pipeId,
      state.contractId,
      state.forPrincipal,
      state.withPrincipal,
      state.token,
      state.amount,
      state.myBalance,
      state.theirBalance,
      state.mySignature,
      state.theirSignature,
      state.nonce,
      state.action,
      state.actor,
      state.secret,
      state.validAfter,
      state.beneficialOnly ? 1 : 0,
      state.updatedAt,
    );
    this.touchUpdatedAt();
  }

  getDisputeAttempt(attemptId: string): DisputeAttemptRecord | null {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM dispute_attempts WHERE attempt_id = ?')
      .get(attemptId) as DisputeAttemptRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapDisputeAttemptRow(row);
  }

  setDisputeAttempt(attempt: DisputeAttemptRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO dispute_attempts (
        attempt_id,
        contract_id,
        pipe_id,
        for_principal,
        trigger_txid,
        success,
        dispute_txid,
        error,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        contract_id = excluded.contract_id,
        pipe_id = excluded.pipe_id,
        for_principal = excluded.for_principal,
        trigger_txid = excluded.trigger_txid,
        success = excluded.success,
        dispute_txid = excluded.dispute_txid,
        error = excluded.error,
        created_at = excluded.created_at
    `).run(
      attempt.attemptId,
      attempt.contractId,
      attempt.pipeId,
      attempt.forPrincipal,
      attempt.triggerTxid,
      attempt.success ? 1 : 0,
      attempt.disputeTxid,
      attempt.error,
      attempt.createdAt,
    );
    this.touchUpdatedAt();
  }

  listDisputeAttempts(): DisputeAttemptRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM dispute_attempts ORDER BY created_at DESC')
      .all() as unknown as DisputeAttemptRow[];
    return rows.map((row) => this.mapDisputeAttemptRow(row));
  }
}
