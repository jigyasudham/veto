// Database schema definitions for veto.db
// All tables created on first run — zero setup required

export const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    platform         TEXT NOT NULL DEFAULT 'claude',
    active_client    TEXT,
    last_resumed_at  TEXT,
    connection_type  TEXT NOT NULL DEFAULT 'subscription',
    project_dir      TEXT,
    summary          TEXT,
    context          TEXT,
    task_state       TEXT,
    token_count      INTEGER DEFAULT 0,
    save_type        TEXT NOT NULL DEFAULT 'manual',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS docs_cache (
    id           TEXT PRIMARY KEY,
    package_name TEXT NOT NULL,
    ecosystem    TEXT NOT NULL,
    version      TEXT NOT NULL,
    content      TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    UNIQUE(package_name, ecosystem, version)
  );

  CREATE TABLE IF NOT EXISTS task_plans (
    id               TEXT PRIMARY KEY,
    description_hash TEXT NOT NULL,
    plan_json        TEXT NOT NULL,
    project_dir      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id              TEXT PRIMARY KEY,
    session_id      TEXT,
    platform        TEXT NOT NULL,
    connection_type TEXT NOT NULL DEFAULT 'subscription',
    tokens          INTEGER DEFAULT 0,
    event_type      TEXT NOT NULL DEFAULT 'session_save',
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    made_at     TEXT NOT NULL,
    decision    TEXT NOT NULL,
    rationale   TEXT,
    council_verdict TEXT,
    files_affected  TEXT,
    overridden  INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS files_modified (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    operation   TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS council_outcomes (
    id          TEXT PRIMARY KEY,
    session_id  TEXT,
    task        TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    lead_dev    TEXT,
    pm          TEXT,
    architect   TEXT,
    ux          TEXT,
    devil       TEXT,
    legal       TEXT,
    security    TEXT,
    recommended TEXT,
    debated_at  TEXT NOT NULL,
    duration_ms INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS learning_data (
    id            TEXT PRIMARY KEY,
    task_type     TEXT NOT NULL,
    complexity    INTEGER NOT NULL,
    model_tier    INTEGER NOT NULL,
    output_quality INTEGER,
    tokens_used   INTEGER,
    agent         TEXT,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patterns (
    id          TEXT PRIMARY KEY,
    pattern_key TEXT NOT NULL UNIQUE,
    pattern_val TEXT NOT NULL,
    confidence  REAL DEFAULT 1.0,
    seen_count  INTEGER DEFAULT 1,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rate_usage (
    id            TEXT PRIMARY KEY,
    platform      TEXT NOT NULL,
    date_key      TEXT NOT NULL,
    request_count INTEGER DEFAULT 0,
    token_count   INTEGER DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(platform, date_key)
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id               TEXT PRIMARY KEY,
    tool_name        TEXT NOT NULL,
    session_id       TEXT,
    max_tokens       INTEGER NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    exceeded         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL DEFAULT 'solution',
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    tags           TEXT,
    project_dir    TEXT,
    session_id     TEXT,
    relevance      REAL DEFAULT 1.0,
    accessed_count INTEGER DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_map (
    id          TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL UNIQUE,
    structure   TEXT NOT NULL,
    key_modules TEXT,
    tech_stack  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_diagnostics (
    id         TEXT PRIMARY KEY,
    file_path  TEXT NOT NULL,
    line       INTEGER NOT NULL DEFAULT 0,
    col_start  INTEGER NOT NULL DEFAULT 0,
    message    TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'warning',
    source     TEXT NOT NULL DEFAULT 'veto',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS context_usage (
    platform       TEXT PRIMARY KEY,
    model          TEXT,
    token_count    INTEGER NOT NULL DEFAULT 0,
    context_window INTEGER NOT NULL DEFAULT 200000,
    usage_pct      REAL NOT NULL DEFAULT 0,
    session_id     TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decision_constraints (
    id                 TEXT PRIMARY KEY,
    project_dir        TEXT,
    rule               TEXT NOT NULL,
    why                TEXT,
    forbidden_patterns TEXT NOT NULL,
    file_scope         TEXT,
    severity           TEXT NOT NULL DEFAULT 'block',
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_decision_constraints_proj ON decision_constraints(project_dir);

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
  );

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
  );

  CREATE INDEX IF NOT EXISTS idx_tool_trace_session ON tool_call_trace_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_tool_trace_name    ON tool_call_trace_log(tool_name);

  CREATE INDEX IF NOT EXISTS idx_scan_diag_file ON scan_diagnostics(file_path);
  CREATE INDEX IF NOT EXISTS idx_routing_fb_hash ON routing_feedback(task_hash);
  CREATE INDEX IF NOT EXISTS idx_routing_fb_exp  ON routing_feedback(expires_at);

  CREATE INDEX IF NOT EXISTS idx_sessions_platform    ON sessions(platform);
  CREATE INDEX IF NOT EXISTS idx_decisions_session    ON decisions(session_id);
  CREATE INDEX IF NOT EXISTS idx_files_session        ON files_modified(session_id);
  CREATE INDEX IF NOT EXISTS idx_learning_task_type   ON learning_data(task_type);
  CREATE INDEX IF NOT EXISTS idx_patterns_key         ON patterns(pattern_key);
  CREATE INDEX IF NOT EXISTS idx_rate_usage_platform  ON rate_usage(platform, date_key);
  CREATE INDEX IF NOT EXISTS idx_knowledge_type       ON knowledge_base(type);
  CREATE INDEX IF NOT EXISTS idx_knowledge_project    ON knowledge_base(project_dir);
  CREATE INDEX IF NOT EXISTS idx_project_map_dir      ON project_map(project_dir);
  CREATE INDEX IF NOT EXISTS idx_docs_cache_pkg       ON docs_cache(package_name, ecosystem);
  CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_events_date    ON usage_events(recorded_at);
`;

export type SessionRow = {
  id: string;
  started_at: string;
  ended_at: string | null;
  platform: string;
  active_client: string | null;
  last_resumed_at: string | null;
  connection_type: string;
  project_dir: string | null;
  summary: string | null;
  context: string | null;
  task_state: string | null;
  token_count: number;
  save_type: 'manual' | 'auto';
  created_at: string;
};

export type KnowledgeType = 'solution' | 'pattern' | 'context' | 'error' | 'reference' | 'decision';

export type KnowledgeRow = {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string | null;
  project_dir: string | null;
  session_id: string | null;
  relevance: number;
  accessed_count: number;
  created_at: string;
  updated_at: string;
};

export type ProjectMapRow = {
  id: string;
  project_dir: string;
  structure: string;
  key_modules: string | null;
  tech_stack: string | null;
  updated_at: string;
};

export type DocsCacheRow = {
  id: string;
  package_name: string;
  ecosystem: string;
  version: string;
  content: string;
  fetched_at: string;
};

export type PatternRow = {
  id: string;
  pattern_key: string;
  pattern_val: string;
  confidence: number;
  seen_count: number;
  updated_at: string;
};

export type ToolCallTraceLogRow = { id: string; session_id: string | null; tool_name: string; args_json: string | null; result_status: string; error_message: string | null; duration_ms: number; tokens_used: number | null; recorded_at: string; };
