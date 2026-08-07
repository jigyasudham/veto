// Mask-on-expansion: serve exact L0 bytes, always masked (VERSION-3 item 6, Step 7).
//
// L0 is stored RAW (Rule 0), but nothing leaves this module unmasked. Every byte
// range served out of an archive passes through mask() first, so even though a
// secret may sit in the raw archive on disk, it can never transit into an AI
// context through Veto. Offsets are validated against the archive length before
// any slice (S6) so a corrupt index can never read out of bounds. This is the
// read-side counterpart to Step 6's mask-on-write, and it is tested here BEFORE
// the recall tool (Step 11) is allowed to trust it.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getTranscriptsDb } from './store.js';
import { mask } from './mask.js';
import type { ArchiveRow, EventRow } from './schema.js';

// Small 1-entry cache so a recall that expands several ranges gunzips once.
let _cache: { path: string; mtimeMs: number; buf: Buffer } | null = null;
function loadArchive(path: string): Buffer {
  const { mtimeMs } = statSync(path);
  if (_cache && _cache.path === path && _cache.mtimeMs === mtimeMs) return _cache.buf;
  const buf = gunzipSync(readFileSync(path));
  _cache = { path, mtimeMs, buf };
  return buf;
}

export function _resetExpandCache(): void { _cache = null; }

export type ExpandResult = {
  ok: boolean;
  reason?: string;
  text?: string;            // ALWAYS masked
  secretsRedacted?: number;
  source?: string;
  sourceSessionId?: string;
  provenance?: string;
  fromSeq?: number;
  toSeq?: number;
};

function getArchiveById(id: string): ArchiveRow | null {
  const db = getTranscriptsDb();
  return (db.prepare(`SELECT * FROM archives WHERE id = ?`).get(id) as ArchiveRow | undefined) ?? null;
}

type Loc = { offset?: number; length?: number; seq?: number; toSeq?: number; ts?: string | null };
function cite(archive: ArchiveRow, loc: Loc): string {
  const parts = [archive.source, `session ${archive.source_session_id}`];
  if (loc.seq !== undefined) {
    parts.push(loc.toSeq !== undefined && loc.toSeq !== loc.seq ? `turns ${loc.seq}-${loc.toSeq}` : `turn ${loc.seq}`);
  }
  if (loc.ts) parts.push(loc.ts);
  if (loc.offset !== undefined && loc.length !== undefined) parts.push(`bytes ${loc.offset}-${loc.offset + loc.length}`);
  return `[${parts.join(' · ')}]`;
}

/** Serve a byte range from an archive, masked. Bounds are validated first. */
export function expandBytes(archive: ArchiveRow, offset: number, length: number): ExpandResult {
  if (!existsSync(archive.archive_path)) return { ok: false, reason: 'archive_missing' };
  let buf: Buffer;
  try { buf = loadArchive(archive.archive_path); } catch { return { ok: false, reason: 'unreadable' }; }
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buf.length) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  const m = mask(buf.toString('utf8', offset, offset + length));
  return {
    ok: true, text: m.text, secretsRedacted: m.count,
    source: archive.source, sourceSessionId: archive.source_session_id,
    provenance: cite(archive, { offset, length }),
  };
}

/** Expand a single event to its exact source line (masked), with a turn/timestamp citation. */
export function expandEvent(eventId: string): ExpandResult {
  const db = getTranscriptsDb();
  const ev = (db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId) as EventRow | undefined) ?? null;
  if (!ev) return { ok: false, reason: 'event_not_found' };
  const archive = getArchiveById(ev.archive_id);
  if (!archive) return { ok: false, reason: 'archive_not_found' };
  const r = expandBytes(archive, ev.raw_offset, ev.raw_length);
  if (r.ok) { r.provenance = cite(archive, { seq: ev.seq, ts: ev.ts_utc }); r.fromSeq = ev.seq; r.toSeq = ev.seq; }
  return r;
}

/** Expand a seq range to the exact contiguous L0 lines it covers (masked). */
export function expandRange(archiveId: string, fromSeq: number, toSeq: number): ExpandResult {
  const db = getTranscriptsDb();
  const archive = getArchiveById(archiveId);
  if (!archive) return { ok: false, reason: 'archive_not_found' };
  const rows = db.prepare(
    `SELECT raw_offset, raw_length FROM events WHERE archive_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`
  ).all(archiveId, Math.min(fromSeq, toSeq), Math.max(fromSeq, toSeq)) as { raw_offset: number; raw_length: number }[];
  if (rows.length === 0) return { ok: false, reason: 'no_events' };
  const start = Math.min(...rows.map(r => r.raw_offset));
  const end = Math.max(...rows.map(r => r.raw_offset + r.raw_length));
  const r = expandBytes(archive, start, end - start);
  if (r.ok) { r.provenance = cite(archive, { seq: fromSeq, toSeq }); r.fromSeq = fromSeq; r.toSeq = toSeq; }
  return r;
}
