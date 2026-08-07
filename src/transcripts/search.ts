// Portable BM25 search over indexed events (VERSION-3 item 6, Step 10 — redone).
//
// Plain-SQLite inverted index (search_docs / search_terms / search_postings),
// scored in JS. Core SQL only — no FTS5, no math functions, nothing behind a
// compile-time flag; that is the lesson of PR #28 (`no such module: fts5`).
// Query terms are bound parameters resolved against the term dictionary, so
// there is no query language and no injection surface at all.
//
// Contract change vs the FTS5 version: score is positive, HIGHER is better
// (FTS5's bm25() was negative-lower-is-better). Snippets are built in JS from
// events.text for the returned rows only.

import { getTranscriptsDb } from './store.js';
import { normalizeProjectDir } from '../memory/local.js';
import { tokenize } from './tokenize.js';
import type { SearchDocRow } from './schema.js';

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

const K1 = 1.2;
const B = 0.75;
// Terms present in more than half the corpus carry ~no signal but force
// materializing huge posting lists (there is no LIMIT that is safe before
// ranking). Dropped at the dictionary, before any postings are read — unless
// every query term is that common, in which case they are all kept.
const DF_CAP_RATIO = 0.5;
const SNIPPET_TOKENS = 12;

/** BM25, scored in JS because log() in SQL is a compile-time lottery. */
function bm25(tf: number, df: number, n: number, len: number, avgdl: number): number {
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  return idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (avgdl > 0 ? len / avgdl : 1)));
}

/**
 * Build a highlighted excerpt in JS — the moral equivalent of FTS5's
 * snippet(…, '[', ']', '…', 12): the SNIPPET_TOKENS-token window containing
 * the most matched terms, matches wrapped in [ ], ellipses when clipped.
 */
export function buildSnippet(text: string, terms: Set<string>): string {
  const re = /[\p{L}\p{N}_\-./@+]+/gu;
  const tokens: { start: number; end: number; matched: boolean }[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const matched = tokenize(raw).some(t => terms.has(t));
    tokens.push({ start: m.index, end: m.index + raw.length, matched });
  }
  if (tokens.length === 0) return text.slice(0, 120);

  // Best SNIPPET_TOKENS-token window = most matches, earliest wins ties.
  let best = 0;
  let bestCount = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const windowEnd = Math.min(i + SNIPPET_TOKENS, tokens.length);
    let count = 0;
    for (let j = i; j < windowEnd; j += 1) if (tokens[j].matched) count += 1;
    if (count > bestCount) { bestCount = count; best = i; }
    if (windowEnd === tokens.length) break;
  }
  const windowEnd = Math.min(best + SNIPPET_TOKENS, tokens.length);

  let out = '';
  let pos = tokens[best].start;
  for (let j = best; j < windowEnd; j += 1) {
    const t = tokens[j];
    out += text.slice(pos, t.start);
    out += t.matched ? `[${text.slice(t.start, t.end)}]` : text.slice(t.start, t.end);
    pos = t.end;
  }
  const prefix = tokens[best].start > 0 ? '…' : '';
  const suffix = windowEnd < tokens.length || tokens[windowEnd - 1].end < text.length ? '…' : '';
  return (prefix + out.replace(/\s+/g, ' ').trim() + suffix);
}

export function searchEvents(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getTranscriptsDb();
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const stats = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(len), 0) AS avgdl FROM search_docs`
  ).get() as { n: number; avgdl: number };
  if (stats.n === 0) return [];

  // Resolve terms against the dictionary in one round trip.
  const marks = terms.map(() => '?').join(', ');
  const found = db.prepare(
    `SELECT id, term FROM search_terms WHERE term IN (${marks})`
  ).all(...terms) as { id: number; term: string }[];
  if (found.length === 0) return [];

  // df per term — an index-only range count on the postings PK.
  const dfStmt = db.prepare(`SELECT COUNT(*) AS n FROM search_postings WHERE term_id = ?`);
  const withDf = found.map(t => ({ ...t, df: (dfStmt.get(t.id) as { n: number }).n }));
  let kept = withDf.filter(t => t.df / stats.n <= DF_CAP_RATIO);
  if (kept.length === 0) kept = withDf; // every term is that common — keep them all

  const where: string[] = [`p.term_id IN (${kept.map(() => '?').join(', ')})`];
  const params: (string | number)[] = kept.map(t => t.id);
  if (opts.projectDir) { where.push('d.project_dir = ?'); params.push(normalizeProjectDir(opts.projectDir)); }
  if (opts.sourceSessionId) { where.push('d.source_session_id = ?'); params.push(opts.sourceSessionId); }

  const rows = db.prepare(
    `SELECT p.term_id, p.tf, d.event_id, d.archive_id, d.source_session_id, d.project_dir, d.seq, d.kind, d.len
       FROM search_postings p JOIN search_docs d ON d.id = p.doc_id
      WHERE ${where.join(' AND ')}`
  ).all(...params) as ({ term_id: number; tf: number } & SearchDocRow)[];
  if (rows.length === 0) return [];

  const dfById = new Map(kept.map(t => [t.id, t.df]));
  const acc = new Map<string, { doc: SearchDocRow; score: number }>();
  for (const r of rows) {
    const df = dfById.get(r.term_id) ?? 1;
    const prev = acc.get(r.event_id);
    const inc = bm25(r.tf, df, stats.n, r.len, stats.avgdl);
    if (prev) prev.score += inc;
    else acc.set(r.event_id, { doc: r, score: inc });
  }

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const top = [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  // Snippets: fetch text for the returned rows only.
  const ids = top.map(t => t.doc.event_id);
  const textRows = db.prepare(
    `SELECT id, text FROM events WHERE id IN (${ids.map(() => '?').join(', ')})`
  ).all(...ids) as { id: string; text: string | null }[];
  const textById = new Map(textRows.map(r => [r.id, r.text ?? '']));
  const termSet = new Set(kept.map(t => t.term));

  return top.map(({ doc, score }) => ({
    eventId: doc.event_id,
    archiveId: doc.archive_id,
    sourceSessionId: doc.source_session_id,
    seq: doc.seq,
    kind: doc.kind,
    snippet: buildSnippet(textById.get(doc.event_id) ?? '', termSet),
    score,
  }));
}
