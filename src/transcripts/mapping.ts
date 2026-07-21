// Live host-session -> transcript-file mapping (VERSION-3 item 6, Step 4).
//
// The statusline (which is the one place that reliably sees Claude Code's
// session_id + transcript_path on every render) UPSERTs into session_map
// fire-and-forget. Save-time capture (Step 5) then looks up which file to
// archive for the session being saved. All writes land in the sidecar
// transcripts.db — veto.db is never touched.

import { getTranscriptsDb } from './store.js';
import { normalizeProjectDir } from '../memory/local.js';
import type { SessionMapRow } from './schema.js';

export type RecordMappingInput = {
  source?: string; // defaults to 'claude'
  sourceSessionId: string;
  transcriptPath: string;
  projectDir?: string | null;
};

/**
 * UPSERT a session's transcript path. Idempotent on (source, source_session_id):
 * a later render just refreshes transcript_path/project_dir/last_seen_at. The
 * caller treats this as fire-and-forget; it must not throw on the hot path, so
 * hot-path callers wrap it — but keep it cheap regardless.
 */
export function recordSessionMapping(m: RecordMappingInput): void {
  const db = getTranscriptsDb();
  const now = new Date().toISOString();
  const proj = m.projectDir ? normalizeProjectDir(m.projectDir) : null;
  db.prepare(
    `INSERT INTO session_map (source, source_session_id, transcript_path, project_dir, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, source_session_id) DO UPDATE SET
       transcript_path = excluded.transcript_path,
       project_dir     = excluded.project_dir,
       last_seen_at    = excluded.last_seen_at`
  ).run(m.source ?? 'claude', m.sourceSessionId, m.transcriptPath, proj, now);
}

/** Look up the mapping for an exact session id. */
export function getSessionMapping(sourceSessionId: string, source = 'claude'): SessionMapRow | null {
  const db = getTranscriptsDb();
  return (db.prepare(
    `SELECT * FROM session_map WHERE source = ? AND source_session_id = ?`
  ).get(source, sourceSessionId) as SessionMapRow | undefined) ?? null;
}

/**
 * Newest ACTIVE mapping for a project from a given source. Save-time capture
 * uses this when it knows the project but not the exact source_session_id
 * (S5 concurrency rule: bind the newest active mapping, ties broken by recency).
 */
export function latestMappingForProject(projectDir: string, source = 'claude'): SessionMapRow | null {
  const db = getTranscriptsDb();
  const proj = normalizeProjectDir(projectDir);
  return (db.prepare(
    `SELECT * FROM session_map WHERE source = ? AND project_dir = ? ORDER BY last_seen_at DESC LIMIT 1`
  ).get(source, proj) as SessionMapRow | undefined) ?? null;
}
