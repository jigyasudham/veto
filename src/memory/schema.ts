// Database schema definitions for veto.db
// All tables created on first run — zero setup required

export const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    platform    TEXT NOT NULL DEFAULT 'claude',
    project_dir TEXT,
    summary     TEXT,
    context     TEXT,
    task_state  TEXT,
    token_count INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
    recommended TEXT,
    debated_at  TEXT NOT NULL
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
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(platform, date_key)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_platform   ON sessions(platform);
  CREATE INDEX IF NOT EXISTS idx_decisions_session   ON decisions(session_id);
  CREATE INDEX IF NOT EXISTS idx_files_session       ON files_modified(session_id);
  CREATE INDEX IF NOT EXISTS idx_learning_task_type  ON learning_data(task_type);
  CREATE INDEX IF NOT EXISTS idx_patterns_key        ON patterns(pattern_key);
  CREATE INDEX IF NOT EXISTS idx_rate_usage_platform ON rate_usage(platform, date_key);
`;

export type SessionRow = {
  id: string;
  started_at: string;
  ended_at: string | null;
  platform: string;
  project_dir: string | null;
  summary: string | null;
  context: string | null;
  task_state: string | null;
  token_count: number;
  created_at: string;
};

export type DecisionRow = {
  id: string;
  session_id: string;
  made_at: string;
  decision: string;
  rationale: string | null;
  council_verdict: string | null;
  files_affected: string | null;
  overridden: number;
};

export type PatternRow = {
  id: string;
  pattern_key: string;
  pattern_val: string;
  confidence: number;
  seen_count: number;
  updated_at: string;
};