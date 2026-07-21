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
import { parseClaudeTranscript } from './adapters/claude.js';
import type { ArchiveRow, EventRow } from './schema.js';

// Bump when the parser changes in a way that should re-derive existing archives.
export const PARSER_VERSION = 1;

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
    const { events, sessionIds, secretsRedacted } = parseClaudeTranscript(buf);

    if (sessionIds.size > 0 && !sessionIds.has(row.source_session_id)) {
      return { status: 'session_mismatch', reason: 'archive session id not present in transcript' };
    }

    const ins = db.prepare(
      `INSERT INTO events (id, archive_id, source_session_id, seq, line_index, block_index, kind,
         source_type, role, tool_name, text, secret_count, event_uuid, parent_uuid, is_sidechain,
         ts_source, ts_utc, raw_offset, raw_length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM events WHERE archive_id = ?`).run(archiveId);
      for (const e of events) {
        ins.run(
          randomUUID(), archiveId, row.source_session_id, e.seq, e.lineIndex, e.blockIndex, e.kind,
          e.sourceType, e.role, e.toolName, e.text, e.secretCount, e.eventUuid, e.parentUuid, e.isSidechain ? 1 : 0,
          e.tsSource, e.tsUtc, e.rawOffset, e.rawLength,
        );
      }
      db.prepare(`UPDATE archives SET indexed_through_seq = ?, parser_version = ? WHERE id = ?`)
        .run(events.length, PARSER_VERSION, archiveId);
      db.exec('COMMIT');
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
