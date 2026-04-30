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
  return _db;
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