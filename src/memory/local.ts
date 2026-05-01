// Local SQLite memory — all operations for session save/restore
// Uses Node.js built-in node:sqlite (Node 22.5+, no native compilation needed)

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { CREATE_TABLES, type SessionRow } from './schema.js';

const VETO_DIR = join(homedir(), '.veto');
const DB_PATH = join(VETO_DIR, 'veto.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(VETO_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec(CREATE_TABLES);
  migrateCouncilOutcomes(_db);
  migrateCouncilColumns(_db);
  return _db;
}

// Adds legal and security columns if they don't exist (Phase 3 → Phase 3.1 migration)
function migrateCouncilColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(council_outcomes)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('legal')) db.exec('ALTER TABLE council_outcomes ADD COLUMN legal TEXT');
  if (!names.has('security')) db.exec('ALTER TABLE council_outcomes ADD COLUMN security TEXT');
}

// Migrates council_outcomes if it was created with NOT NULL session_id (Phase 1/2 schema)
function migrateCouncilOutcomes(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(council_outcomes)').all() as Array<{ name: string; notnull: number }>;
  const col = cols.find(c => c.name === 'session_id');
  if (!col || col.notnull !== 1) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS _council_outcomes_new (
      id TEXT PRIMARY KEY, session_id TEXT, task TEXT NOT NULL,
      verdict TEXT NOT NULL, lead_dev TEXT, pm TEXT, architect TEXT,
      ux TEXT, devil TEXT, recommended TEXT, debated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _council_outcomes_new SELECT * FROM council_outcomes;
    DROP TABLE council_outcomes;
    ALTER TABLE _council_outcomes_new RENAME TO council_outcomes;
  `);
}

export type SaveSessionInput = {
  platform?: string;
  project_dir?: string;
  summary?: string;
  context?: string;
  task_state?: string;
  token_count?: number;
};

export type SessionSaveResult = {
  session_id: string;
  saved_at: string;
};

export function saveSession(input: SaveSessionInput): SessionSaveResult {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, started_at, platform, project_dir, summary, context, task_state, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    now,
    input.platform ?? 'claude',
    input.project_dir ?? null,
    input.summary ?? null,
    input.context ? JSON.stringify(input.context) : null,
    input.task_state ? JSON.stringify(input.task_state) : null,
    input.token_count ?? 0
  );

  return { session_id: id, saved_at: now };
}

export type RestoreSessionResult = {
  found: boolean;
  session?: SessionRow;
};

export function restoreSession(session_id: string): RestoreSessionResult {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id) as SessionRow | undefined;
  if (!row) return { found: false };
  return { found: true, session: row };
}

export function listSessions(limit = 10): SessionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as SessionRow[];
}

export function closeSession(session_id: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
    .run(new Date().toISOString(), session_id);
}

export function getDbPath(): string {
  return DB_PATH;
}

export type SaveCouncilOutcomeInput = {
  session_id?: string;
  task: string;
  verdict: string;
  lead_dev: string;
  pm: string;
  architect: string;
  ux: string;
  devil: string;
  legal: string;
  security: string;
  recommended: string;
};

export function saveCouncilOutcome(input: SaveCouncilOutcomeInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO council_outcomes
      (id, session_id, task, verdict, lead_dev, pm, architect, ux, devil, legal, security, recommended, debated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.session_id ?? null, input.task, input.verdict,
    input.lead_dev, input.pm, input.architect, input.ux, input.devil,
    input.legal, input.security, input.recommended, now);
  return id;
}