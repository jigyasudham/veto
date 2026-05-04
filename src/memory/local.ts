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
import { CREATE_TABLES, type SessionRow, type KnowledgeRow, type KnowledgeType, type ProjectMapRow, type DocsCacheRow } from './schema.js';

// Context window sizes per platform (tokens)
export const CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  codex: 128_000,
};

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
  return _db;
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
  connection_type?: string;
  project_dir?: string;
  summary?: string;
  context?: string;
  task_state?: string;
  token_count?: number;
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

  db.prepare(`
    INSERT INTO sessions (id, started_at, platform, connection_type, project_dir, summary, context, task_state, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, platform, connection_type,
    input.project_dir ?? null,
    input.summary ?? null,
    input.context ? JSON.stringify(input.context) : null,
    input.task_state ? JSON.stringify(input.task_state) : null,
    token_count
  );

  // Record usage event
  db.prepare(`
    INSERT INTO usage_events (id, session_id, platform, connection_type, tokens, event_type, recorded_at)
    VALUES (?, ?, ?, ?, ?, 'session_save', ?)
  `).run(randomUUID(), id, platform, connection_type, token_count, now);

  // Context window guard
  const window_size = CONTEXT_WINDOWS[platform] ?? 200_000;
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
  max_chars = 8000
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
        headers: { 'User-Agent': 'veto-mcp/1.1.0' },
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
    if (opts.agent) continue; // council events don't have a single agent
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

  // Avg latency: approximate from 10 most recent council outcomes (debated_at timestamps as proxy)
  const latencyRows = db.prepare(
    'SELECT debated_at FROM council_outcomes ORDER BY debated_at DESC LIMIT 10'
  ).all() as Array<{ debated_at: string }>;
  let avg_council_latency_ms: number | null = null;
  if (latencyRows.length >= 2) {
    const diffs: number[] = [];
    for (let i = 0; i < latencyRows.length - 1; i++) {
      diffs.push(Math.abs(new Date(latencyRows[i].debated_at).getTime() - new Date(latencyRows[i + 1].debated_at).getTime()));
    }
    avg_council_latency_ms = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
  }

  return {
    total_sessions: count('sessions'),
    total_memories: count('knowledge_base'),
    total_patterns: count('patterns'),
    total_council_outcomes: count('council_outcomes'),
    total_decisions: count('decisions'),
    avg_council_latency_ms,
  };
}