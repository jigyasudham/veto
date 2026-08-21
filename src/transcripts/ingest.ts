// Ingest: derive normalized events from an L0 archive (VERSION-3 item 6, Step 6).
//
// Idempotent + lazy via the archive's parser_version + indexed_through_seq
// watermark: a fresh or grown archive (Step 5 resets both) gets (re)indexed; an
// unchanged, already-indexed archive is a no-op; a parser upgrade re-derives.
// Session-id verification (council/devil): if the archive's session id does not
// appear anywhere in the parsed file, the mapping pointed at the wrong transcript
// and we SKIP rather than index a mismatched file.

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { getTranscriptsDb } from './store.js';
import { resetCaches } from './cache.js';
import { parseTranscript } from './adapters/index.js';
import { tokenize } from './tokenize.js';
import { SEARCHABLE_KINDS, type ArchiveRow, type EventRow } from './schema.js';

const SEARCHABLE = new Set<string>(SEARCHABLE_KINDS);

// Bump when the parser changes in a way that should re-derive existing archives.
// v2: the portable search index replaced events_fts — archives ingested at v1
// have events but no search_docs/postings rows, so they must re-derive.
export const PARSER_VERSION = 2;

export type IngestStatus =
  | 'indexed' | 'already_indexed' | 'not_found' | 'archive_missing' | 'session_mismatch' | 'error';

export type IngestResult = {
  status: IngestStatus;
  events?: number;
  secretsRedacted?: number;
  reason?: string;
};

function getArchiveById(archiveId: string): ArchiveRow | null {
  const db = getTranscriptsDb();
  return (db.prepare(`SELECT * FROM archives WHERE id = ?`).get(archiveId) as ArchiveRow | undefined) ?? null;
}

function needsIndexing(row: ArchiveRow): boolean {
  return row.parser_version !== PARSER_VERSION;
}

/** (Re)derive events for one archive. Best-effort: never throws. */
export function ingestArchive(archiveId: string): IngestResult {
  try {
    const db = getTranscriptsDb();
    const row = getArchiveById(archiveId);
    if (!row) return { status: 'not_found' };
    if (!needsIndexing(row)) return { status: 'already_indexed', events: row.indexed_through_seq };
    if (!existsSync(row.archive_path)) return { status: 'archive_missing' };

    const buf = gunzipSync(readFileSync(row.archive_path));
    const { events, sessionIds, secretsRedacted } = parseTranscript(row.source, buf);

    if (sessionIds.size > 0 && !sessionIds.has(row.source_session_id)) {
      return { status: 'session_mismatch', reason: 'archive session id not present in transcript' };
    }

    const ins = db.prepare(
      `INSERT INTO events (id, archive_id, source_session_id, seq, line_index, block_index, kind,
         source_type, role, tool_name, text, secret_count, event_uuid, parent_uuid, is_sidechain,
         ts_source, ts_utc, raw_offset, raw_length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insDoc = db.prepare(
      `INSERT INTO search_docs (event_id, archive_id, source_session_id, project_dir, seq, kind, len)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    );
    const insTerm = db.prepare(
      `INSERT INTO search_terms (term) VALUES (?)
       ON CONFLICT(term) DO UPDATE SET term = term RETURNING id`
    );
    const insPosting = db.prepare(
      `INSERT INTO search_postings (term_id, doc_id, tf) VALUES (?, ?, ?)`
    );
    // Term ids are cached per ingest run — a session reuses its vocabulary
    // heavily, so most lookups never hit the upsert.
    const termIds = new Map<string, number>();
    const termId = (term: string): number => {
      let id = termIds.get(term);
      if (id === undefined) {
        id = Number((insTerm.get(term) as { id: number | bigint }).id);
        termIds.set(term, id);
      }
      return id;
    };
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM events WHERE archive_id = ?`).run(archiveId);
      db.prepare(
        `DELETE FROM search_postings WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).run(archiveId);
      // Doc ids are reassigned by this re-derive, so stale vectors would not
      // just orphan — they would silently re-attach to the wrong events.
      db.prepare(
        `DELETE FROM search_vectors WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).run(archiveId);
      db.prepare(`DELETE FROM search_docs WHERE archive_id = ?`).run(archiveId);
      for (const e of events) {
        const eventId = randomUUID();
        ins.run(
          eventId, archiveId, row.source_session_id, e.seq, e.lineIndex, e.blockIndex, e.kind,
          e.sourceType, e.role, e.toolName, e.text, e.secretCount, e.eventUuid, e.parentUuid, e.isSidechain ? 1 : 0,
          e.tsSource, e.tsUtc, e.rawOffset, e.rawLength,
        );
        // Index the searchable, non-empty events (text is already masked).
        if (SEARCHABLE.has(e.kind) && e.text && e.text.trim()) {
          const tokens = tokenize(e.text);
          const tf = new Map<string, number>();
          for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
          const docId = Number((insDoc.get(
            eventId, archiveId, row.source_session_id, row.project_dir, e.seq, e.kind, tokens.length,
          ) as { id: number | bigint }).id);
          for (const [term, count] of tf) insPosting.run(termId(term), docId, count);
        }
      }
      // Vectors were just dropped with their docs; clearing the marker lets
      // the lazy embed pass rebuild them without re-parsing the transcript.
      db.prepare(
        `UPDATE archives SET indexed_through_seq = ?, parser_version = ?, chunker_version = 0, embed_model = NULL
          WHERE id = ?`
      ).run(events.length, PARSER_VERSION, archiveId);
      db.exec('COMMIT');
      resetCaches();
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return { status: 'indexed', events: events.length, secretsRedacted };
  } catch (e) {
    return { status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Ensure an archive is indexed at the current parser version (lazy trigger for recall). */
export function ensureIndexed(archiveId: string): IngestResult {
  return ingestArchive(archiveId);
}

/** Ingest by source session id (looks up its archive). */
export function ingestSession(sourceSessionId: string, source = 'claude'): IngestResult {
  const db = getTranscriptsDb();
  const row = (db.prepare(
    `SELECT id FROM archives WHERE source = ? AND source_session_id = ?`
  ).get(source, sourceSessionId) as { id: string } | undefined) ?? null;
  if (!row) return { status: 'not_found' };
  return ingestArchive(row.id);
}

export function getEvents(archiveId: string): EventRow[] {
  const db = getTranscriptsDb();
  return db.prepare(`SELECT * FROM events WHERE archive_id = ? ORDER BY seq`).all(archiveId) as EventRow[];
}
