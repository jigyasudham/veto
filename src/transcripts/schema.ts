// Sidecar transcripts.db — schema & additive migrations (VERSION-3 item 6, Step 2).
//
// A SEPARATE database file from veto.db. The HUD / veto-vscode read-contract
// lives entirely in veto.db and is never touched by transcript capture — that
// isolation is the whole point of the sidecar. Migrations are additive and
// versioned via `PRAGMA user_version`: each later step APPENDS a migration
// rather than editing an existing one, so the schema grows without churn and
// re-open is idempotent.

// Highest migration version defined below.
export const TRANSCRIPTS_SCHEMA_VERSION = 1;

export type Migration = { version: number; up: string };

export const MIGRATIONS: Migration[] = [
  {
    // v1 — the two foundational anchor tables. Events / segments / FTS get their
    // own later migrations (Steps 6/9/10) so we don't big-bang the schema.
    version: 1,
    up: `
      -- L0 archive index: one row per captured source-CLI session.
      CREATE TABLE IF NOT EXISTS archives (
        id                  TEXT PRIMARY KEY,
        source              TEXT NOT NULL DEFAULT 'claude',   -- claude|codex|gemini
        source_session_id   TEXT NOT NULL,
        project_dir         TEXT,                              -- normalized (lowercase drive)
        veto_session_id     TEXT,                              -- link to veto.db sessions.id when known
        archive_path        TEXT NOT NULL,                     -- absolute path to the .gz on disk
        content_sha256      TEXT NOT NULL,                     -- of raw source bytes (dedup key)
        source_bytes        INTEGER NOT NULL DEFAULT 0,        -- uncompressed size
        archive_bytes       INTEGER NOT NULL DEFAULT 0,        -- gz size on disk
        source_format_hint  TEXT,                              -- e.g. 'claude-jsonl'
        parser_version      INTEGER NOT NULL DEFAULT 0,
        indexed_through_seq INTEGER NOT NULL DEFAULT 0,        -- lazy-index watermark
        captured_at         TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(source, source_session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_archives_project ON archives(project_dir);
      CREATE INDEX IF NOT EXISTS idx_archives_sha     ON archives(content_sha256);

      -- Live host-session -> transcript-file mapping, UPSERTed fire-and-forget by
      -- the statusline (Step 4) so save-time capture knows which file to read.
      CREATE TABLE IF NOT EXISTS session_map (
        source            TEXT NOT NULL DEFAULT 'claude',
        source_session_id TEXT NOT NULL,
        transcript_path   TEXT NOT NULL,
        project_dir       TEXT,
        last_seen_at      TEXT NOT NULL,
        PRIMARY KEY (source, source_session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_map_project ON session_map(project_dir);
    `,
  },
];

export type ArchiveRow = {
  id: string;
  source: string;
  source_session_id: string;
  project_dir: string | null;
  veto_session_id: string | null;
  archive_path: string;
  content_sha256: string;
  source_bytes: number;
  archive_bytes: number;
  source_format_hint: string | null;
  parser_version: number;
  indexed_through_seq: number;
  captured_at: string;
  updated_at: string;
};

export type SessionMapRow = {
  source: string;
  source_session_id: string;
  transcript_path: string;
  project_dir: string | null;
  last_seen_at: string;
};
