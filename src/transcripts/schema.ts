// Sidecar transcripts.db — schema & additive migrations (VERSION-3 item 6, Step 2).
//
// A SEPARATE database file from veto.db. The HUD / veto-vscode read-contract
// lives entirely in veto.db and is never touched by transcript capture — that
// isolation is the whole point of the sidecar. Migrations are additive and
// versioned via `PRAGMA user_version`: each later step APPENDS a migration
// rather than editing an existing one, so the schema grows without churn and
// re-open is idempotent.

// Highest migration version defined below.
export const TRANSCRIPTS_SCHEMA_VERSION = 3;

// The common vocabulary every source normalizes into.
export const EVENT_KINDS = [
  'user_message', 'assistant_message', 'tool_call', 'tool_result', 'reasoning', 'meta', 'unknown',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

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
  {
    // v2 — normalized events, one row per conversational unit derived from L0.
    // text is ALWAYS masked (Step 3). raw_offset/raw_length point into the
    // UNCOMPRESSED L0 bytes for exact expansion (Step 11). Unknown/unparsed lines
    // are stored+ordered (kind='unknown') so format drift never loses data.
    version: 2,
    up: `
      CREATE TABLE IF NOT EXISTS events (
        id                TEXT PRIMARY KEY,
        archive_id        TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        seq               INTEGER NOT NULL,        -- monotonic per archive, per event
        line_index        INTEGER NOT NULL,        -- source JSONL line (0-based)
        block_index       INTEGER NOT NULL DEFAULT 0,
        kind              TEXT NOT NULL,           -- EVENT_KINDS
        source_type       TEXT,                    -- verbatim source 'type' (user/assistant/system/…)
        role              TEXT,
        tool_name         TEXT,                    -- for tool_call/tool_result
        text              TEXT,                    -- normalized + MASKED content for FTS
        secret_count      INTEGER NOT NULL DEFAULT 0,
        event_uuid        TEXT,                    -- native uuid (Claude)
        parent_uuid       TEXT,                    -- native parentUuid (tree)
        is_sidechain      INTEGER NOT NULL DEFAULT 0,
        ts_source         TEXT,                    -- verbatim timestamp string
        ts_utc            TEXT,                    -- normalized ISO
        raw_offset        INTEGER NOT NULL DEFAULT 0,
        raw_length        INTEGER NOT NULL DEFAULT 0,
        UNIQUE(archive_id, seq),
        FOREIGN KEY (archive_id) REFERENCES archives(id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_archive ON events(archive_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(source_session_id);
      CREATE INDEX IF NOT EXISTS idx_events_kind    ON events(kind);
    `,
  },
  {
    // v3 — portable lexical index: plain tables + JS scoring (B2, redone).
    // The FTS5 version of this migration never shipped: PR #28 died on
    // `no such module: fts5` because node:sqlite bundles SQLite with NODE's
    // build flags, so ANY compile-time feature (FTS5, even math functions)
    // is a version lottery. Rule: core SQL only. BM25 is scored in JS.
    //
    // Postings carry no positions — the query path ANDs independent terms and
    // never phrase-matches, so positions are pure cost. Snippets are rebuilt
    // in JS from events.text for the few returned rows. No stored df: purge /
    // re-ingest would have to decrement it transactionally or IDF drifts;
    // COUNT(*) on the postings PK answers it per query term instead.
    //
    // NOTE: never CREATE or DROP events_fts here — touching a virtual table
    // loads its module, which throws on exactly the Nodes this redo supports.
    // Databases that ran the old dev-only v3 keep an inert orphan table.
    version: 3,
    up: `
      -- One row per indexed event. project_dir/session denormalized so the
      -- hot query is a single join (same shape events_fts had). The INTEGER id
      -- exists so postings never carry a 36-char uuid — measured, that uuid
      -- (stored twice per posting: PK + purge index) was ~3x the entire
      -- index's justified size.
      CREATE TABLE IF NOT EXISTS search_docs (
        id                INTEGER PRIMARY KEY,
        event_id          TEXT NOT NULL UNIQUE,
        archive_id        TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        project_dir       TEXT,
        seq               INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        len               INTEGER NOT NULL   -- token count, for BM25 length norm
      );
      CREATE INDEX IF NOT EXISTS idx_search_docs_archive ON search_docs(archive_id);
      CREATE INDEX IF NOT EXISTS idx_search_docs_scope
        ON search_docs(project_dir, source_session_id);

      -- Term dictionary: term text stored once, compact integer join key.
      CREATE TABLE IF NOT EXISTS search_terms (
        id   INTEGER PRIMARY KEY,
        term TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS search_postings (
        term_id INTEGER NOT NULL,
        doc_id  INTEGER NOT NULL,
        tf      INTEGER NOT NULL,
        PRIMARY KEY (term_id, doc_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_postings_doc ON search_postings(doc_id);
    `,
  },
];

// Event kinds worth indexing for recall — spine + tool digests. Reasoning
// (verbose thinking) and meta/unknown are excluded.
export const SEARCHABLE_KINDS: EventKind[] = ['user_message', 'assistant_message', 'tool_call', 'tool_result'];

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

export type SearchDocRow = {
  id: number;
  event_id: string;
  archive_id: string;
  source_session_id: string;
  project_dir: string | null;
  seq: number;
  kind: EventKind;
  len: number;
};

export type SearchPostingRow = {
  term_id: number;
  doc_id: number;
  tf: number;
};

export type EventRow = {
  id: string;
  archive_id: string;
  source_session_id: string;
  seq: number;
  line_index: number;
  block_index: number;
  kind: EventKind;
  source_type: string | null;
  role: string | null;
  tool_name: string | null;
  text: string | null;
  secret_count: number;
  event_uuid: string | null;
  parent_uuid: string | null;
  is_sidechain: number;
  ts_source: string | null;
  ts_utc: string | null;
  raw_offset: number;
  raw_length: number;
};
