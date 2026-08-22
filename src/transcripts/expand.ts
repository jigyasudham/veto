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

/**
 * Hard ceiling on what one expansion may return, in characters.
 *
 * Expansion used to be unbounded: it served the whole raw L0 line, and measured
 * across a real archive that reached 139.6KB from a SINGLE call — roughly 35,000
 * tokens, a third of a 128k context window, spent on one excerpt (council
 * 06b7b55c). ~12k characters is about 3k tokens: enough for any real message,
 * bounded enough that an AI can afford to ask.
 */
export const MAX_EXPAND_CHARS = 12_000;

function clip(text: string, form: 'text' | 'raw' = 'text'): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXPAND_CHARS) return { text, truncated: false };
  const advice = form === 'raw'
    ? 'Narrow the range, or drop raw:true for the readable form, which is far smaller.'
    : 'Narrow the range.';
  return {
    text: text.slice(0, MAX_EXPAND_CHARS)
      + `\n\n[… truncated: ${text.length - MAX_EXPAND_CHARS} more characters. ${advice}]`,
    truncated: true,
  };
}

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
  /** True when the payload hit MAX_EXPAND_CHARS and was cut. */
  truncated?: boolean;
  /** 'text' = normalized readable content; 'raw' = exact L0 source bytes. */
  form?: 'text' | 'raw';
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
  const c = clip(m.text, 'raw');
  return {
    ok: true, text: c.text, secretsRedacted: m.count, truncated: c.truncated, form: 'raw',
    source: archive.source, sourceSessionId: archive.source_session_id,
    provenance: cite(archive, { offset, length }),
  };
}

/**
 * Expand one event.
 *
 * Returns the NORMALIZED, readable content by default. It used to return the raw
 * L0 line, which meant an AI asking for one message received a JSON envelope —
 * `{"parentUuid":"…","isSidechain":false,"type":"user","message":{…}}` — rather
 * than the message. `events.text` already holds that content, normalized and
 * masked at ingest, so serving it needs no new parsing and no per-source
 * coupling in this module (council 06b7b55c).
 *
 * Rule 0 is intact: `raw: true` still serves the exact L0 bytes, and the archive
 * on disk is untouched either way. Both forms are masked on serve and capped.
 */
export function expandEvent(eventId: string, raw = false): ExpandResult {
  const db = getTranscriptsDb();
  const ev = (db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId) as EventRow | undefined) ?? null;
  if (!ev) return { ok: false, reason: 'event_not_found' };
  const archive = getArchiveById(ev.archive_id);
  if (!archive) return { ok: false, reason: 'archive_not_found' };

  if (raw) {
    const r = expandBytes(archive, ev.raw_offset, ev.raw_length);
    if (r.ok) { r.provenance = cite(archive, { seq: ev.seq, ts: ev.ts_utc }); r.fromSeq = ev.seq; r.toSeq = ev.seq; }
    return r;
  }

  // Masked again on serve even though ingest already masked it: the mask-on-serve
  // guarantee must not depend on what a past parser version wrote.
  const m = mask(labelled(ev));
  const c = clip(m.text);
  return {
    // Ingest masked this text already, so the serve-time pass usually finds
    // nothing new. Report what was redacted FROM THIS CONTENT (counted at
    // ingest) as well, or the number would read 0 on correctly-masked content
    // and look like nothing was ever protected.
    ok: true, text: c.text, secretsRedacted: Math.max(ev.secret_count, m.count),
    truncated: c.truncated, form: 'text',
    source: archive.source, sourceSessionId: archive.source_session_id,
    provenance: cite(archive, { seq: ev.seq, ts: ev.ts_utc }),
    fromSeq: ev.seq, toSeq: ev.seq,
  };
}

/** One event as readable text, prefixed with who said it (and which tool). */
function labelled(ev: EventRow): string {
  const who = ev.kind === 'user_message' ? 'user'
    : ev.kind === 'assistant_message' ? 'assistant'
    : ev.kind === 'tool_call' ? `tool call${ev.tool_name ? ` (${ev.tool_name})` : ''}`
    : ev.kind === 'tool_result' ? `tool result${ev.tool_name ? ` (${ev.tool_name})` : ''}`
    : ev.kind;
  return `[turn ${ev.seq} · ${who}] ${ev.text ?? ''}`.trimEnd();
}

/**
 * Expand a seq range as readable text — the conversation, not the file format.
 * `raw` falls back to the exact contiguous L0 byte slice.
 */
export function expandRangeText(archiveId: string, fromSeq: number, toSeq: number): ExpandResult {
  const db = getTranscriptsDb();
  const archive = getArchiveById(archiveId);
  if (!archive) return { ok: false, reason: 'archive_not_found' };
  const lo = Math.min(fromSeq, toSeq), hi = Math.max(fromSeq, toSeq);
  const rows = db.prepare(
    `SELECT * FROM events WHERE archive_id = ? AND seq BETWEEN ? AND ? AND text IS NOT NULL AND text != ''
      ORDER BY seq`
  ).all(archiveId, lo, hi) as EventRow[];
  if (rows.length === 0) return { ok: false, reason: 'no_events' };
  const m = mask(rows.map(labelled).join('\n\n'));
  const c = clip(m.text);
  const storedSecrets = rows.reduce((a, r) => a + (r.secret_count ?? 0), 0);
  return {
    ok: true, text: c.text, secretsRedacted: Math.max(storedSecrets, m.count),
    truncated: c.truncated, form: 'text',
    source: archive.source, sourceSessionId: archive.source_session_id,
    provenance: cite(archive, { seq: rows[0].seq, toSeq: rows[rows.length - 1].seq, ts: rows[0].ts_utc }),
    fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq,
  };
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
