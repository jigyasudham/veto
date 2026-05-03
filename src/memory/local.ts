// Local SQLite memory — all operations for session save/restore
// Uses Node.js built-in node:sqlite (Node 22.5+, no native compilation needed)

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { CREATE_TABLES, type SessionRow, type KnowledgeRow, type KnowledgeType, type ProjectMapRow } from './schema.js';

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
  migrateSessionColumns(_db);
  return _db;
}

// Adds active_client and last_resumed_at columns if they don't exist
function migrateSessionColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('active_client')) db.exec('ALTER TABLE sessions ADD COLUMN active_client TEXT');
  if (!names.has('last_resumed_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT');
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

export function restoreSession(session_id: string, active_client?: string): RestoreSessionResult {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id) as SessionRow | undefined;
  if (!row) return { found: false };

  if (active_client) {
    const now = new Date().toISOString();
    db.prepare('UPDATE sessions SET active_client = ?, last_resumed_at = ? WHERE id = ?')
      .run(active_client, now, session_id);
    row.active_client = active_client;
    row.last_resumed_at = now;
  }

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

// ─── Knowledge Base ───────────────────────────────────────────────────────────

export type StoreKnowledgeInput = {
  type?: KnowledgeType;
  title: string;
  content: string;
  tags?: string[];
  project_dir?: string;
  session_id?: string;
  relevance?: number;
};

export function storeKnowledge(input: StoreKnowledgeInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO knowledge_base (id, type, title, content, tags, project_dir, session_id, relevance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type ?? 'solution',
    input.title,
    input.content,
    input.tags ? JSON.stringify(input.tags) : null,
    input.project_dir ?? null,
    input.session_id ?? null,
    input.relevance ?? 1.0,
    now,
    now
  );
  return id;
}

export type SearchKnowledgeOptions = {
  query?: string;
  type?: KnowledgeType;
  tags?: string[];
  project_dir?: string;
  limit?: number;
};

export function searchKnowledge(opts: SearchKnowledgeOptions): KnowledgeRow[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 10, 50);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.query) {
    conditions.push('(title LIKE ? OR content LIKE ?)');
    const q = `%${opts.query}%`;
    params.push(q, q);
  }
  if (opts.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }
  if (opts.project_dir) {
    conditions.push('project_dir = ?');
    params.push(opts.project_dir);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM knowledge_base ${where} ORDER BY relevance DESC, accessed_count DESC, created_at DESC LIMIT ?`
  ).all(...params, limit) as KnowledgeRow[];

  if (rows.length > 0 && opts.query) {
    const ids = rows.map(r => `'${r.id}'`).join(',');
    db.exec(`UPDATE knowledge_base SET accessed_count = accessed_count + 1 WHERE id IN (${ids})`);
  }

  return rows;
}

export function deleteKnowledge(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id) as { changes: number };
  return result.changes > 0;
}

// ─── Project Map ──────────────────────────────────────────────────────────────

export type UpdateProjectMapInput = {
  project_dir: string;
  structure: Record<string, unknown> | string;
  key_modules?: string[];
  tech_stack?: string[];
};

export function updateProjectMap(input: UpdateProjectMapInput): string {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM project_map WHERE project_dir = ?').get(input.project_dir) as { id: string } | undefined;

  const structure = typeof input.structure === 'string' ? input.structure : JSON.stringify(input.structure);
  const key_modules = input.key_modules ? JSON.stringify(input.key_modules) : null;
  const tech_stack = input.tech_stack ? JSON.stringify(input.tech_stack) : null;

  if (existing) {
    db.prepare(`
      UPDATE project_map SET structure = ?, key_modules = ?, tech_stack = ?, updated_at = ?
      WHERE project_dir = ?
    `).run(structure, key_modules, tech_stack, now, input.project_dir);
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO project_map (id, project_dir, structure, key_modules, tech_stack, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.project_dir, structure, key_modules, tech_stack, now);
  return id;
}

export function getProjectMap(project_dir: string): ProjectMapRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM project_map WHERE project_dir = ?').get(project_dir) as ProjectMapRow | null;
}

// ─── Pattern Operations ───────────────────────────────────────────────────────

export type UpsertPatternInput = {
  pattern_key: string;
  pattern_val: string;
  confidence?: number;
};

export function upsertPattern(input: UpsertPatternInput): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id, seen_count, confidence FROM patterns WHERE pattern_key = ?').get(input.pattern_key) as { id: string; seen_count: number; confidence: number } | undefined;

  if (existing) {
    const newConfidence = Math.min(1.0, (existing.confidence + (input.confidence ?? 1.0)) / 2);
    db.prepare(`
      UPDATE patterns SET pattern_val = ?, confidence = ?, seen_count = seen_count + 1, updated_at = ?
      WHERE pattern_key = ?
    `).run(input.pattern_val, newConfidence, now, input.pattern_key);
  } else {
    db.prepare(`
      INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(randomUUID(), input.pattern_key, input.pattern_val, input.confidence ?? 1.0, now);
  }
}

export function getPatterns(prefix?: string, limit = 20): import('./schema.js').PatternRow[] {
  const db = getDb();
  if (prefix) {
    return db.prepare(
      'SELECT * FROM patterns WHERE pattern_key LIKE ? ORDER BY confidence DESC, seen_count DESC LIMIT ?'
    ).all(`${prefix}%`, limit) as import('./schema.js').PatternRow[];
  }
  return db.prepare(
    'SELECT * FROM patterns ORDER BY confidence DESC, seen_count DESC LIMIT ?'
  ).all(limit) as import('./schema.js').PatternRow[];
}