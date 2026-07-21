// FTS5 + BM25 lexical search over indexed events (VERSION-3 item 6, Step 10).
//
// B2 of the vectorless pipeline. Queries are sanitized into a safe FTS5 MATCH
// expression (each term quoted → no operator injection). Ranked by bm25 (lower =
// better) with snippet() for a highlighted excerpt. Scoped by project_dir and/or
// session. Zero new deps — node:sqlite's built-in FTS5.

import { getTranscriptsDb } from './store.js';
import { normalizeProjectDir } from '../memory/local.js';

export type SearchHit = {
  eventId: string;
  archiveId: string;
  sourceSessionId: string;
  seq: number;
  kind: string;
  snippet: string;
  score: number;
};

export type SearchOptions = {
  projectDir?: string;
  sourceSessionId?: string;
  limit?: number;
};

/**
 * Turn free text into a safe FTS5 MATCH string: extract identifier-ish tokens and
 * quote each as a phrase, so FTS5 operators/quotes in user input can't inject.
 * Returns '' when there is nothing to search.
 */
export function toFtsQuery(raw: string): string {
  const tokens = raw.match(/[\w./@+-]+/g) ?? [];
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

export function searchEvents(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getTranscriptsDb();
  const match = toFtsQuery(query);
  if (!match) return [];

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const where: string[] = ['events_fts MATCH ?'];
  const params: (string | number)[] = [match];
  if (opts.projectDir) { where.push('project_dir = ?'); params.push(normalizeProjectDir(opts.projectDir)); }
  if (opts.sourceSessionId) { where.push('source_session_id = ?'); params.push(opts.sourceSessionId); }
  params.push(limit);

  return db.prepare(
    `SELECT event_id AS eventId, archive_id AS archiveId, source_session_id AS sourceSessionId,
            seq, kind,
            snippet(events_fts, 0, '[', ']', '…', 12) AS snippet,
            bm25(events_fts) AS score
     FROM events_fts
     WHERE ${where.join(' AND ')}
     ORDER BY score
     LIMIT ?`
  ).all(...params) as SearchHit[];
}
