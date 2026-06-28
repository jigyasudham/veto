// Local SQLite memory — all operations for session save/restore
// Uses Node.js built-in node:sqlite (Node 22.5+, no native compilation needed)

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// node:sqlite is a Node 22.5+ built-in — use createRequire so bundlers (Vite/esbuild) skip it
const _require = createRequire(import.meta.url);
const DbSync = (_require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
import { CREATE_TABLES, VETO_DB_SCHEMA_VERSION, type SessionRow, type KnowledgeRow, type KnowledgeType, type ProjectMapRow, type DocsCacheRow, type ToolCallTraceLogRow } from './schema.js';

// Context window sizes per platform (tokens)
export const CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  codex: 128_000,
};

// Per-model context windows — resolved at call time when model is provided.
// Falls back to CONTEXT_WINDOWS[platform] when model is unknown.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude 4.x — 1M context
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-7': 1_000_000,
  'claude-opus-4-7':   1_000_000,
  'claude-opus-4-8':   1_000_000,
  'claude-haiku-4-5':  1_000_000,
  // Claude 3.x — 200K context
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku':  200_000,
  'claude-3-opus':     200_000,
  // Gemini — all current models are 1M+
  'gemini-3.5-flash': 1_048_576,
  'gemini-3.5-pro':   1_048_576,
  'gemini-3-pro':     1_048_576,
  'gemini-3-flash':   1_048_576,
  'gemini-2-5-pro':   1_048_576,
  'gemini-2-0-flash': 1_048_576,
  'gemini-1-5-pro':   1_048_576,
  'gemini-1-5-flash': 1_048_576,
  // OpenAI / Codex
  'gpt-5.1-codex': 400_000,
  'gpt-5.1':       400_000,
  'gpt-5':         400_000,
  'gpt-4o':      128_000,
  'gpt-4o-mini': 128_000,
  'o1':          200_000,
  'o3':          200_000,
  'o4-mini':     200_000,
};

export function resolveContextWindow(platform: string, model?: string): number {
  if (model) {
    if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
    // Prefix match handles suffixed model IDs like "claude-sonnet-4-6-20251001"
    for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
      if (model.startsWith(key)) return MODEL_CONTEXT_WINDOWS[key];
    }
  }
  return CONTEXT_WINDOWS[platform] ?? 200_000;
}

const VETO_DIR = join(homedir(), '.veto');
const DB_PATH = process.env.VETO_TEST_DB ?? join(VETO_DIR, 'veto.db');

let _db: DatabaseSync | null = null;

export function resetDb(): void {
  if (_db) { _db.close(); _db = null; }
}

export function getDb(): DatabaseSync {
  if (_db) return _db;
  if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DbSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec(CREATE_TABLES);
  migrateCouncilOutcomes(_db);
  migrateCouncilColumns(_db);
  migrateSessionColumns(_db);
  migrateCouncilDuration(_db);
  migrateRateUsageTokens(_db);
  migrateUsageLog(_db);
  migrateSessionSaveType(_db);
  migrateScanDiagnostics(_db);
  migrateSessionTags(_db);
  migrateContextUsage(_db);
  migrateRoutingFeedback(_db);
  migrateToolTraceLog(_db);
  // Stamp the read-contract version so external readers (veto-vscode, statusline)
  // can detect drift via `PRAGMA user_version`. See VETO_DB_SCHEMA_VERSION.
  _db.exec(`PRAGMA user_version = ${VETO_DB_SCHEMA_VERSION}`);
  return _db;
}

// Creates tool_call_trace_log table for auditing and session replay (v1.8.0 migration)
function migrateToolTraceLog(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_trace_log (
      id            TEXT PRIMARY KEY,
      session_id    TEXT,
      tool_name     TEXT NOT NULL,
      args_json     TEXT,
      result_status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      duration_ms   INTEGER NOT NULL,
      tokens_used   INTEGER,
      recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_trace_session ON tool_call_trace_log(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_trace_name    ON tool_call_trace_log(tool_name)`);
}

export function getSessionReplay(sessionId: string): ToolCallTraceLogRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM tool_call_trace_log WHERE session_id = ? ORDER BY recorded_at ASC').all(sessionId) as unknown as ToolCallTraceLogRow[];
}

// ... existing migration functions ...

export function recordToolCall(opts: {
  session_id?: string;
  tool_name: string;
  args?: Record<string, unknown>;
  result_status: 'success' | 'error';
  error_message?: string;
  duration_ms: number;
  tokens_used?: number;
}): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO tool_call_trace_log (id, session_id, tool_name, args_json, result_status, error_message, duration_ms, tokens_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.session_id ?? null,
    opts.tool_name,
    opts.args ? JSON.stringify(opts.args) : null,
    opts.result_status,
    opts.error_message ?? null,
    opts.duration_ms,
    opts.tokens_used ?? null
  );
  return id;
}

// Creates routing_feedback table for opt-in routing signal storage (v1.4.8 migration)
function migrateRoutingFeedback(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_feedback (
      id           TEXT PRIMARY KEY,
      task_hash    TEXT NOT NULL,
      task_snippet TEXT NOT NULL,
      complexity   INTEGER NOT NULL,
      model_tier   INTEGER NOT NULL,
      agent        TEXT,
      outcome      TEXT NOT NULL DEFAULT 'pending',
      quality      INTEGER,
      session_id   TEXT,
      recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_routing_fb_hash ON routing_feedback(task_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_routing_fb_exp  ON routing_feedback(expires_at)`);
}

// Creates context_usage table for live VS Code extension polling (v1.4.4 migration)
function migrateContextUsage(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_usage (
      platform       TEXT PRIMARY KEY,
      model          TEXT,
      token_count    INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 200000,
      usage_pct      REAL NOT NULL DEFAULT 0,
      session_id     TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// Adds tags column to sessions (v1.3.1 migration)
function migrateSessionTags(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('tags')) db.exec('ALTER TABLE sessions ADD COLUMN tags TEXT');
}

// Creates scan_diagnostics table if it doesn't exist (v1.2.18 migration)
function migrateScanDiagnostics(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_diagnostics (
      id         TEXT PRIMARY KEY,
      file_path  TEXT NOT NULL,
      line       INTEGER NOT NULL DEFAULT 0,
      col_start  INTEGER NOT NULL DEFAULT 0,
      message    TEXT NOT NULL,
      severity   TEXT NOT NULL DEFAULT 'warning',
      source     TEXT NOT NULL DEFAULT 'veto',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_diag_file ON scan_diagnostics(file_path)`);
}

// Adds save_type column to sessions if it doesn't exist (v1.2.17 migration)
function migrateSessionSaveType(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('save_type')) db.exec("ALTER TABLE sessions ADD COLUMN save_type TEXT NOT NULL DEFAULT 'manual'");
}

// Backfills token_count on rate_usage for DBs created before it was added to the
// canonical CREATE in schema.ts (v1.2.13 migration). New DBs already have the column;
// this is a no-op for them. schema.ts is the source of truth — keep the two in sync.
function migrateRateUsageTokens(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(rate_usage)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('token_count')) db.exec('ALTER TABLE rate_usage ADD COLUMN token_count INTEGER DEFAULT 0');
}

// Creates usage_log table if it doesn't exist (v1.2.14 migration)
function migrateUsageLog(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id               TEXT PRIMARY KEY,
      tool_name        TEXT NOT NULL,
      session_id       TEXT,
      max_tokens       INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      exceeded         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// Adds duration_ms column to council_outcomes if it doesn't exist (v1.2.3 migration)
function migrateCouncilDuration(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(council_outcomes)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('duration_ms')) db.exec('ALTER TABLE council_outcomes ADD COLUMN duration_ms INTEGER DEFAULT 0');
}

// Adds active_client, last_resumed_at, and connection_type columns if they don't exist
function migrateSessionColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('active_client'))   db.exec('ALTER TABLE sessions ADD COLUMN active_client TEXT');
  if (!names.has('last_resumed_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT');
  if (!names.has('connection_type')) db.exec("ALTER TABLE sessions ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'subscription'");
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
  model?: string;
  connection_type?: string;
  project_dir?: string;
  summary?: string;
  context?: string;
  task_state?: string;
  token_count?: number;
  save_type?: 'manual' | 'auto';
  tags?: string[];
};

export type SessionSaveResult = {
  session_id: string;
  saved_at: string;
  context_warning: boolean;
  usage_pct: number;
  continuation_prompt: string | null;
};

export function saveSession(input: SaveSessionInput): SessionSaveResult {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const platform = input.platform ?? 'claude';
  const connection_type = input.connection_type ?? 'subscription';
  const token_count = input.token_count ?? 0;

  const save_type = input.save_type ?? 'manual';

  db.prepare(`
    INSERT INTO sessions (id, started_at, platform, connection_type, project_dir, summary, context, task_state, token_count, save_type, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, platform, connection_type,
    input.project_dir ?? null,
    input.summary ?? null,
    input.context ? JSON.stringify(input.context) : null,
    input.task_state ? JSON.stringify(input.task_state) : null,
    token_count,
    save_type,
    input.tags ? JSON.stringify(input.tags) : null
  );

  // Record usage event
  db.prepare(`
    INSERT INTO usage_events (id, session_id, platform, connection_type, tokens, event_type, recorded_at)
    VALUES (?, ?, ?, ?, ?, 'session_save', ?)
  `).run(randomUUID(), id, platform, connection_type, token_count, now);

  // Context window guard — use model-specific window when available (Gemini 1M vs Claude 200k)
  const window_size = resolveContextWindow(platform, input.model);
  const usage_pct = Math.round((token_count / window_size) * 100);
  const context_warning = usage_pct >= 80;
  const continuation_prompt = context_warning
    ? `Session ${id} saved. Context at ${usage_pct}% of ${platform} limit. To continue in a fresh session: call veto_continue { "session_id": "${id}" }`
    : null;

  return { session_id: id, saved_at: now, context_warning, usage_pct, continuation_prompt };
}

export type RestoreSessionResult = {
  found: boolean;
  session?: SessionRow;
};

export type UpdateSessionResult = {
  updated: boolean;
  session_id: string;
  saved_at: string;
};

export function updateSession(session_id: string, input: SaveSessionInput): UpdateSessionResult | null {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id) as { id: string } | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE sessions SET
      summary     = ?,
      context     = ?,
      task_state  = ?,
      token_count = ?,
      save_type   = 'manual',
      created_at  = ?
    WHERE id = ?
  `).run(
    input.summary ?? null,
    input.context ? JSON.stringify(input.context) : null,
    input.task_state ? JSON.stringify(input.task_state) : null,
    input.token_count ?? 0,
    now,
    session_id
  );

  return { updated: true, session_id, saved_at: now };
}

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

export function listSessions(limit = 10, query?: string): SessionRow[] {
  const db = getDb();
  if (query) {
    const q = `%${query}%`;
    return db.prepare(
      `SELECT * FROM sessions WHERE summary LIKE ? OR context LIKE ? OR task_state LIKE ? OR tags LIKE ? OR project_dir LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(q, q, q, q, q, limit) as SessionRow[];
  }
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
  duration_ms?: number;
};

export function saveCouncilOutcome(input: SaveCouncilOutcomeInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO council_outcomes
      (id, session_id, task, verdict, lead_dev, pm, architect, ux, devil, legal, security, recommended, debated_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.session_id ?? null, input.task, input.verdict,
    input.lead_dev, input.pm, input.architect, input.ux, input.devil,
    input.legal, input.security, input.recommended, now, input.duration_ms ?? 0);
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
    const updateStmt = db.prepare('UPDATE knowledge_base SET accessed_count = accessed_count + 1 WHERE id = ?');
    for (const row of rows) updateStmt.run(row.id);
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

// ─── Context Status ───────────────────────────────────────────────────────────

export type ContextStatus = {
  session_id: string;
  platform: string;
  token_count: number;
  context_window: number;
  usage_pct: number;
  recommended_action: 'safe' | 'compress' | 'handoff';
};

export function getContextStatus(session_id: string): ContextStatus | null {
  const db = getDb();
  const row = db.prepare('SELECT id, platform, token_count FROM sessions WHERE id = ?').get(session_id) as { id: string; platform: string; token_count: number } | undefined;
  if (!row) return null;
  const context_window = CONTEXT_WINDOWS[row.platform] ?? 200_000;
  const usage_pct = Math.round((row.token_count / context_window) * 100);
  const recommended_action: ContextStatus['recommended_action'] =
    usage_pct >= 80 ? 'handoff' : usage_pct >= 60 ? 'compress' : 'safe';
  return { session_id: row.id, platform: row.platform, token_count: row.token_count, context_window, usage_pct, recommended_action };
}

// ─── Docs Cache ───────────────────────────────────────────────────────────────

const DOCS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchAndCacheDocs(
  package_name: string,
  ecosystem: 'npm' | 'pypi' | 'crates',
  version?: string,
  max_chars = 8000,
  agentVersion = '1.0.0'
): Promise<{ package_name: string; version: string; ecosystem: string; content: string; cached: boolean; fetched_at: string } | null> {
  const db = getDb();

  // Check cache first
  const cached = db.prepare(
    'SELECT * FROM docs_cache WHERE package_name = ? AND ecosystem = ? ORDER BY fetched_at DESC LIMIT 1'
  ).get(package_name, ecosystem) as DocsCacheRow | undefined;

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < DOCS_TTL_MS) {
      return { package_name, version: cached.version, ecosystem, content: cached.content.slice(0, max_chars), cached: true, fetched_at: cached.fetched_at };
    }
  }

  // Fetch from source with 5s timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    let content = '';
    let resolved_version = version ?? 'latest';

    if (ecosystem === 'npm') {
      const meta = await fetch(`https://registry.npmjs.org/${encodeURIComponent(package_name)}`, { signal: controller.signal });
      if (!meta.ok) return null;
      const json = await meta.json() as Record<string, unknown>;
      resolved_version = version ?? (json['dist-tags'] as Record<string, string>)?.['latest'] ?? 'latest';
      const readme = (json['readme'] as string) ?? '';
      const description = (json['description'] as string) ?? '';
      content = `# ${package_name}@${resolved_version}\n${description}\n\n${readme}`;
    } else if (ecosystem === 'pypi') {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(package_name)}/json`, { signal: controller.signal });
      if (!res.ok) return null;
      const json = await res.json() as { info: { version: string; summary: string; description: string } };
      resolved_version = version ?? json.info.version;
      content = `# ${package_name}@${resolved_version}\n${json.info.summary}\n\n${json.info.description}`;
    } else {
      const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(package_name)}`, {
        signal: controller.signal,
        headers: { 'User-Agent': `veto-mcp/${agentVersion}` },
      });
      if (!res.ok) return null;
      const json = await res.json() as { crate: { newest_version: string; description: string; documentation: string } };
      resolved_version = version ?? json.crate.newest_version;
      content = `# ${package_name}@${resolved_version}\n${json.crate.description}\nDocs: ${json.crate.documentation}`;
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO docs_cache (id, package_name, ecosystem, version, content, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), package_name, ecosystem, resolved_version, content, now);

    return { package_name, version: resolved_version, ecosystem, content: content.slice(0, max_chars), cached: false, fetched_at: now };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Task Plans ───────────────────────────────────────────────────────────────

export function saveTaskPlan(plan_json: string, description_hash: string, project_dir?: string): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO task_plans (id, description_hash, plan_json, project_dir, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, description_hash, plan_json, project_dir ?? null);
  return id;
}

export function getTaskPlan(description_hash: string): { id: string; plan_json: string } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, plan_json FROM task_plans
    WHERE description_hash = ?
      AND created_at > datetime('now', '-7 days')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(description_hash) as { id: string; plan_json: string } | undefined;
  return row ?? null;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export type VetoMetrics = {
  sessions: { total: number; today: number; this_week: number };
  council: { total: number; today: number; by_verdict: Record<string, number> };
  agents: Array<{ agent: string; calls: number; avg_quality: number }>;
  quality: { overall_avg: number; trend: Array<{ date: string; avg: number; count: number }> };
  knowledge: { total_entries: number; by_type: Record<string, number> };
  patterns: { total: number };
};

export function getMetrics(): VetoMetrics {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  const sessions = {
    total:     (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n,
    today:     (db.prepare("SELECT COUNT(*) as n FROM sessions WHERE created_at >= ?").get(today + 'T00:00:00') as { n: number }).n,
    this_week: (db.prepare("SELECT COUNT(*) as n FROM sessions WHERE created_at >= ?").get(weekAgo + 'T00:00:00') as { n: number }).n,
  };

  const councilTotal = (db.prepare('SELECT COUNT(*) as n FROM council_outcomes').get() as { n: number }).n;
  const councilToday = (db.prepare("SELECT COUNT(*) as n FROM council_outcomes WHERE debated_at >= ?").get(today + 'T00:00:00') as { n: number }).n;
  const verdictRows = db.prepare('SELECT verdict, COUNT(*) as n FROM council_outcomes GROUP BY verdict').all() as Array<{ verdict: string; n: number }>;
  const by_verdict = Object.fromEntries(verdictRows.map(r => [r.verdict, r.n]));

  const agentRows = db.prepare(
    'SELECT agent, COUNT(*) as calls, AVG(output_quality) as avg_q FROM learning_data WHERE agent IS NOT NULL GROUP BY agent ORDER BY calls DESC LIMIT 10'
  ).all() as Array<{ agent: string; calls: number; avg_q: number | null }>;
  const agents = agentRows.map(r => ({ agent: r.agent, calls: r.calls, avg_quality: Math.round(r.avg_q ?? 0) }));

  const overallAvg = (db.prepare('SELECT AVG(output_quality) as avg FROM learning_data WHERE output_quality IS NOT NULL').get() as { avg: number | null }).avg ?? 0;
  const trendRows = db.prepare(
    "SELECT substr(recorded_at,1,10) as date, AVG(output_quality) as avg, COUNT(*) as count FROM learning_data WHERE output_quality IS NOT NULL AND recorded_at >= ? GROUP BY date ORDER BY date"
  ).all(weekAgo + 'T00:00:00') as Array<{ date: string; avg: number; count: number }>;
  const trend = trendRows.map(r => ({ date: r.date, avg: Math.round(r.avg), count: r.count }));

  const knowledgeTotal = (db.prepare('SELECT COUNT(*) as n FROM knowledge_base').get() as { n: number }).n;
  const knowledgeTypeRows = db.prepare('SELECT type, COUNT(*) as n FROM knowledge_base GROUP BY type').all() as Array<{ type: string; n: number }>;
  const by_type = Object.fromEntries(knowledgeTypeRows.map(r => [r.type, r.n]));

  const patternsTotal = (db.prepare('SELECT COUNT(*) as n FROM patterns').get() as { n: number }).n;

  return {
    sessions,
    council: { total: councilTotal, today: councilToday, by_verdict },
    agents,
    quality: { overall_avg: Math.round(overallAvg), trend },
    knowledge: { total_entries: knowledgeTotal, by_type },
    patterns: { total: patternsTotal },
  };
}

// ─── Usage Status ─────────────────────────────────────────────────────────────

export type UsageStatus = {
  today: {
    by_platform: Array<{
      platform: string;
      requests: number;
      tokens_reported: number;
      connection_breakdown: { subscription: number; api: number };
    }>;
  };
  history: Array<{ date: string; total_requests: number; total_tokens: number }>;
  warnings: string[];
};

export function getUsageStatus(): UsageStatus {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Today's requests from rate_usage
  const rateRows = db.prepare(
    'SELECT platform, request_count FROM rate_usage WHERE date_key = ?'
  ).all(today) as Array<{ platform: string; request_count: number }>;

  // Today's tokens + connection_type breakdown from usage_events
  const eventRows = db.prepare(`
    SELECT platform, connection_type, SUM(tokens) as total_tokens, COUNT(*) as cnt
    FROM usage_events
    WHERE DATE(recorded_at) = ?
    GROUP BY platform, connection_type
  `).all(today) as Array<{ platform: string; connection_type: string; total_tokens: number; cnt: number }>;

  const platforms = ['claude', 'gemini', 'codex'];
  const by_platform = platforms.map(p => {
    const rate = rateRows.find(r => r.platform === p);
    const subEvents = eventRows.filter(e => e.platform === p && e.connection_type === 'subscription');
    const apiEvents = eventRows.filter(e => e.platform === p && e.connection_type === 'api');
    const tokens = eventRows.filter(e => e.platform === p).reduce((s, e) => s + (e.total_tokens ?? 0), 0);
    return {
      platform: p,
      requests: rate?.request_count ?? 0,
      tokens_reported: tokens,
      connection_breakdown: {
        subscription: subEvents.reduce((s, e) => s + e.cnt, 0),
        api: apiEvents.reduce((s, e) => s + e.cnt, 0),
      },
    };
  });

  // Last 7 days history
  const history = db.prepare(`
    SELECT DATE(recorded_at) as date, COUNT(*) as total_requests, SUM(tokens) as total_tokens
    FROM usage_events
    WHERE recorded_at >= date('now', '-7 days')
    GROUP BY DATE(recorded_at)
    ORDER BY date DESC
  `).all() as Array<{ date: string; total_requests: number; total_tokens: number }>;

  // Warnings
  const warnings: string[] = [];
  for (const p of by_platform) {
    if (p.requests > 0) {
      const dailyLimit = p.platform === 'gemini' ? 1500 : 500;
      const pct = Math.round((p.requests / dailyLimit) * 100);
      if (pct >= 80) warnings.push(`${p.platform} at ${pct}% of estimated daily request limit`);
    }
  }

  return { today: { by_platform }, history, warnings };
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

export type AuditEvent = {
  timestamp: string;
  event_type: string;
  session_id: string | null;
  agent: string | null;
  verdict: string | null;
  summary: string;
  affected_files: string | null;
};

export type AuditLogOptions = {
  session_id?: string;
  agent?: string;
  verdict?: string;
  since?: string;
  limit?: number;
};

export function getAuditLog(opts: AuditLogOptions = {}): AuditEvent[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const events: AuditEvent[] = [];

  // Council outcomes
  const councilWhere: string[] = ['1=1'];
  const councilParams: (string | number)[] = [];
  if (opts.session_id) { councilWhere.push('session_id = ?'); councilParams.push(opts.session_id); }
  if (opts.verdict)    { councilWhere.push('verdict = ?');    councilParams.push(opts.verdict); }
  if (opts.since)      { councilWhere.push('debated_at >= ?');councilParams.push(opts.since); }

  const councilRows = db.prepare(
    `SELECT id, session_id, task, verdict, recommended, debated_at FROM council_outcomes WHERE ${councilWhere.join(' AND ')} ORDER BY debated_at DESC LIMIT ?`
  ).all(...councilParams, limit) as Array<{ id: string; session_id: string | null; task: string; verdict: string; recommended: string | null; debated_at: string }>;

  for (const r of councilRows) {
    events.push({ timestamp: r.debated_at, event_type: 'council', session_id: r.session_id, agent: null, verdict: r.verdict, summary: r.task.slice(0, 100), affected_files: null });
  }

  // Decisions
  const decWhere: string[] = ['1=1'];
  const decParams: (string | number)[] = [];
  if (opts.session_id) { decWhere.push('session_id = ?'); decParams.push(opts.session_id); }
  if (opts.since)      { decWhere.push('made_at >= ?');    decParams.push(opts.since); }

  const decRows = db.prepare(
    `SELECT id, session_id, decision, rationale, council_verdict, files_affected, made_at FROM decisions WHERE ${decWhere.join(' AND ')} ORDER BY made_at DESC LIMIT ?`
  ).all(...decParams, limit) as Array<{ id: string; session_id: string; decision: string; rationale: string | null; council_verdict: string | null; files_affected: string | null; made_at: string }>;

  for (const r of decRows) {
    events.push({ timestamp: r.made_at, event_type: 'decision', session_id: r.session_id, agent: null, verdict: r.council_verdict, summary: r.decision.slice(0, 100), affected_files: r.files_affected });
  }

  // Sort combined and return limit
  return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

// ─── Scan Diagnostics ─────────────────────────────────────────────────────────

export type ScanDiagnosticRow = {
  id: string;
  file_path: string;
  line: number;
  col_start: number;
  message: string;
  severity: string;
  source: string;
  created_at: string;
};

export function storeScanDiagnostics(
  filePath: string,
  findings: Array<{ line: number; col_start?: number; message: string; severity: string }>,
  source = 'veto',
): void {
  const db = getDb();
  db.prepare('DELETE FROM scan_diagnostics WHERE file_path = ?').run(filePath);
  if (findings.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO scan_diagnostics (id, file_path, line, col_start, message, severity, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const f of findings) {
    stmt.run(randomUUID(), filePath, Math.max(0, f.line - 1), f.col_start ?? 0, f.message, f.severity, source);
  }
}

export function getScanDiagnostics(filePath?: string): ScanDiagnosticRow[] {
  const db = getDb();
  if (filePath) {
    return db.prepare('SELECT * FROM scan_diagnostics WHERE file_path = ? ORDER BY line').all(filePath) as ScanDiagnosticRow[];
  }
  return db.prepare('SELECT * FROM scan_diagnostics ORDER BY file_path, line').all() as ScanDiagnosticRow[];
}

export function clearScanDiagnostics(filePath?: string): void {
  const db = getDb();
  if (filePath) {
    db.prepare('DELETE FROM scan_diagnostics WHERE file_path = ?').run(filePath);
  } else {
    db.exec('DELETE FROM scan_diagnostics');
  }
}

// ─── Health Stats ─────────────────────────────────────────────────────────────

export type HealthStats = {
  total_sessions: number;
  total_memories: number;
  total_patterns: number;
  total_council_outcomes: number;
  total_decisions: number;
  avg_council_latency_ms: number | null;
};

export function getHealthStats(): HealthStats {
  const db = getDb();
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;

  // Avg latency: average of actual recorded debate durations
  const latencyRow = db.prepare(
    'SELECT AVG(duration_ms) as avg_ms, COUNT(*) as n FROM council_outcomes WHERE duration_ms > 0'
  ).get() as { avg_ms: number | null; n: number };
  const avg_council_latency_ms: number | null =
    latencyRow.n > 0 && latencyRow.avg_ms != null ? Math.round(latencyRow.avg_ms) : null;

  return {
    total_sessions: count('sessions'),
    total_memories: count('knowledge_base'),
    total_patterns: count('patterns'),
    total_council_outcomes: count('council_outcomes'),
    total_decisions: count('decisions'),
    avg_council_latency_ms,
  };
}

// ── Token budget logging (#20) ────────────────────────────────────────────────

export type UsageLogRow = {
  id: string;
  tool_name: string;
  session_id: string | null;
  max_tokens: number;
  estimated_tokens: number;
  exceeded: number;
  created_at: string;
};

export function logUsage(entry: {
  tool_name: string;
  session_id?: string;
  max_tokens: number;
  output: string;
}): { exceeded: boolean; estimated_tokens: number } {
  const db = getDb();
  const estimated_tokens = Math.ceil(entry.output.length / 4);
  const exceeded = estimated_tokens > entry.max_tokens ? 1 : 0;
  db.prepare(
    `INSERT INTO usage_log (id, tool_name, session_id, max_tokens, estimated_tokens, exceeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    randomUUID(),
    entry.tool_name,
    entry.session_id ?? null,
    entry.max_tokens,
    estimated_tokens,
    exceeded,
  );
  return { exceeded: exceeded === 1, estimated_tokens };
}

export function getUsageLogs(opts: { limit?: number; tool_name?: string } = {}): UsageLogRow[] {
  const db = getDb();
  const limit = opts.limit ?? 20;
  if (opts.tool_name) {
    return db.prepare(
      'SELECT * FROM usage_log WHERE tool_name = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.tool_name, limit) as UsageLogRow[];
  }
  return db.prepare(
    'SELECT * FROM usage_log ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as UsageLogRow[];
}

// ── Context Usage — live token count for VS Code extension ───────────────────

export interface ContextUsageRow {
  platform: string;
  model: string | null;
  token_count: number;
  context_window: number;
  usage_pct: number;
  session_id: string | null;
  updated_at: string;
}

export function upsertContextUsage(opts: {
  platform: string;
  model?: string;
  token_count: number;
  context_window: number;
  session_id?: string;
}): void {
  if (opts.token_count <= 0) return;
  const db = getDb();
  const usage_pct = Math.round((opts.token_count / opts.context_window) * 100 * 10) / 10;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO context_usage (platform, model, token_count, context_window, usage_pct, session_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      model          = excluded.model,
      token_count    = excluded.token_count,
      context_window = excluded.context_window,
      usage_pct      = excluded.usage_pct,
      session_id     = excluded.session_id,
      updated_at     = excluded.updated_at
  `).run(
    opts.platform,
    opts.model ?? null,
    opts.token_count,
    opts.context_window,
    usage_pct,
    opts.session_id ?? null,
    now,
  );
}

export function getContextUsage(platform?: string): ContextUsageRow[] {
  const db = getDb();
  if (platform) {
    return db.prepare('SELECT * FROM context_usage WHERE platform = ?').all(platform) as unknown as ContextUsageRow[];
  }
  return db.prepare('SELECT * FROM context_usage ORDER BY updated_at DESC').all() as unknown as ContextUsageRow[];
}