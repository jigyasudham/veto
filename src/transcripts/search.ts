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
import { STRIDE_CHARS, WINDOW_CHARS } from './chunk.js';
import { searchVectors } from './vectors.js';
import { getDocCache, scopeMask } from './cache.js';
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
// Snippet width. This was 12 tokens, which produced ~97-character keyword
// fragments like "…before [we] publish anything [why]…" — below the threshold at
// which an AI can judge whether a hit is worth opening, and the measured reason
// the query→expand loop never completed (council 06b7b55c). Widened to whole
// sentences, with a hard character cap so a token-dense line cannot run away.
const SNIPPET_TOKENS = 60;
const SNIPPET_MAX_CHARS = 500;

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
  if (tokens.length === 0) return text.slice(0, SNIPPET_MAX_CHARS);

  // Best SNIPPET_TOKENS-token window = most matches, earliest wins ties.
  // Sliding sum rather than a nested scan: at 60 tokens the naive O(n·W) pass
  // costs ~5x what it did at 12, on every returned hit.
  let best = 0;
  let bestCount = -1;
  let count = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].matched) count += 1;                       // token entering
    if (i >= SNIPPET_TOKENS && tokens[i - SNIPPET_TOKENS].matched) count -= 1;  // leaving
    const start = Math.max(0, i - SNIPPET_TOKENS + 1);
    if (count > bestCount) { bestCount = count; best = start; }
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
  const body = out.replace(/\s+/g, ' ').trim();
  const clipped = body.length > SNIPPET_MAX_CHARS ? body.slice(0, SNIPPET_MAX_CHARS) + '…' : body + suffix;
  return prefix + clipped;
}

export function searchEvents(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getTranscriptsDb();
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const docs = getDocCache();
  const stats = { n: docs.count, avgdl: docs.avgdl };
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

  // Postings only — three narrow columns, no join. Joining search_docs per
  // POSTING to fetch columns needed for the final handful of rows cost 7.1 ms
  // per common term at 50 sessions; this costs 2.6 ms. Scope and length come
  // from the cached metadata instead, and full rows are read for the top-K.
  const rows = db.prepare(
    `SELECT term_id, doc_id, tf FROM search_postings WHERE term_id IN (${kept.map(() => '?').join(', ')})`
  ).all(...kept.map(t => t.id)) as { term_id: number; doc_id: number; tf: number }[];
  if (rows.length === 0) return [];

  const mask = scopeMask(docs, {
    projectDir: opts.projectDir ? normalizeProjectDir(opts.projectDir) : undefined,
    sourceSessionId: opts.sourceSessionId,
  });

  const dfById = new Map(kept.map(t => [t.id, t.df]));
  const acc = new Map<number, number>();
  for (const r of rows) {
    if (mask && mask[r.doc_id] !== 1) continue;
    const df = dfById.get(r.term_id) ?? 1;
    const inc = bm25(r.tf, df, stats.n, docs.len[r.doc_id] ?? 0, stats.avgdl);
    acc.set(r.doc_id, (acc.get(r.doc_id) ?? 0) + inc);
  }
  if (acc.size === 0) return [];

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  // Metadata and text for the returned rows only.
  const docIds = top.map(([id]) => id);
  const marks2 = docIds.map(() => '?').join(', ');
  const metaRows = db.prepare(
    `SELECT d.id, d.event_id, d.archive_id, d.source_session_id, d.seq, d.kind, e.text
       FROM search_docs d JOIN events e ON e.id = d.event_id
      WHERE d.id IN (${marks2})`
  ).all(...docIds) as (Pick<SearchDocRow, 'id' | 'event_id' | 'archive_id' | 'source_session_id' | 'seq' | 'kind'> & { text: string | null })[];
  const metaById = new Map(metaRows.map(r => [r.id, r]));
  const termSet = new Set(kept.map(t => t.term));

  const out: SearchHit[] = [];
  for (const [docId, score] of top) {
    const m = metaById.get(docId);
    if (!m) continue;
    out.push({
      eventId: m.event_id,
      archiveId: m.archive_id,
      sourceSessionId: m.source_session_id,
      seq: m.seq,
      kind: m.kind,
      snippet: buildSnippet(m.text ?? '', termSet),
      score,
    });
  }
  return out;
}

// --- Hybrid retrieval -------------------------------------------------------

// How deep each ranker is consulted before fusing. Deeper than the returned
// limit so a result ranked mid-list by one ranker can still be lifted by the
// other — the entire mechanism by which a paraphrase beats keyword overlap.
const CANDIDATE_DEPTH = 50;

/**
 * Reciprocal-rank fusion constant.
 *
 * NOT 60. That value comes from the RRF paper's TREC runs over ~1000-document
 * lists; at our candidate depth it is actively harmful. With k=60 and d=50 the
 * whole ranking compresses into a 1.8x spread (rank 1 = 0.0164, rank 50 =
 * 0.0091), which destroys rank information and lets agreement dominate
 * quality: two mid-list agreements (0.011 + 0.011) outscore one top-ranked
 * single-ranker find (0.0164).
 *
 * That is fatal for the case this layer exists to serve. A strict paraphrase
 * shares no vocabulary with its target, so the target is found by the semantic
 * ranker ALONE and earns exactly one contribution — while any keyword-adjacent
 * event earns a comparable one for free. The semantic discovery loses to noise.
 *
 * Requirement: a rank-1 hit from a single ranker must be able to outrank a pair
 * of mid-list agreements. 1/(k+1) > 2/(k+d/2) solves to k < d/2 - 2, i.e.
 * k < 23 at d=50. 10 sits comfortably inside that bound and keeps the top of
 * the list sharply separated (rank 1 = 0.091, rank 10 = 0.050, rank 50 = 0.017).
 */
const RRF_K = 10;

/**
 * BM25 contributes only candidates it is actually confident about: anything
 * below this fraction of its own top score is tail noise that would otherwise
 * occupy fusion slots and crowd out semantic finds.
 *
 * Applied to BM25 only, deliberately. The two rankers have different score
 * geometries: BM25 decays fast and spans orders of magnitude, so relative
 * score is meaningful. Cosines sit in a narrow band — measured on the real
 * corpus, off-topic queries reach 0.40 while on-topic start at 0.45 — so a
 * relative floor there would be noise itself. Depth is the semantic side's
 * only honest control.
 *
 * Only the tail is affected, so a strong keyword hit can never be dropped and
 * lexical survival is preserved by construction.
 */
const BM25_RELATIVE_FLOOR = 0.25;

/**
 * One ranker's contribution for a 0-based rank.
 *
 * Exported so the property the fix turns on can be asserted directly rather
 * than through retrieval, where it is not reliably constructible: with a
 * bag-of-words embedding model, lexical overlap implies semantic similarity,
 * so a document that matches a query's words but not its meaning barely
 * exists. The arithmetic, however, is exact.
 */
export function rrfWeight(rank0: number): number {
  return 1 / (RRF_K + rank0 + 1);
}

/**
 * Fuse ranked id lists by reciprocal rank. Pure, for testing and reuse.
 *
 * The property that matters: a top-ranked find from ONE ranker must be able
 * to outrank a document both rankers place mid-list. That is the case the
 * semantic layer exists to serve — a strict paraphrase is found by the
 * semantic ranker alone — and it is exactly what k=60 at depth 50 broke.
 */
export function fuseByRank(lists: string[][]): { id: string; score: number }[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => acc.set(id, (acc.get(id) ?? 0) + rrfWeight(i)));
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * BM25 and semantic recall, fused by reciprocal rank.
 *
 * RRF over raw score blending is deliberate: BM25 scores are unbounded and
 * corpus-dependent while cosines sit in [-1, 1], so any weighted sum would be
 * a hidden tuning knob that drifts with corpus size. Ranks have neither
 * problem, and lexical survival is measurable (a keyword hit must not be
 * pushed out of the fused list by semantic noise).
 *
 * Degrades silently to BM25 alone when no vectors are stored or the model is
 * not installed (A2) — the caller cannot tell the difference except by score.
 */
export function searchEventsHybrid(query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const lexicalAll = searchEvents(query, { ...opts, limit: CANDIDATE_DEPTH });
  const lexFloor = (lexicalAll[0]?.score ?? 0) * BM25_RELATIVE_FLOOR;
  const lexical = lexicalAll.filter(h => h.score >= lexFloor);

  // Cosine ranking has no notion of "no match" — it always returns its nearest
  // neighbours, however far away they are. A similarity floor cannot fix that
  // here: measured on the real corpus, off-topic queries reach 0.40 while true
  // strict paraphrases go as low as 0.21, so the distributions overlap and any
  // threshold that suppresses noise also cuts the recall this layer exists for.
  //
  // What DOES separate them is whether the query has any footing in the corpus
  // at all. A paraphrase shares no words with its target but still speaks the
  // corpus's language; `zzz-nonexistent-term` shares nothing with anything. So
  // the semantic layer is allowed to generalize, never to extrapolate from a
  // query the corpus has no word of — and "nothing matched" stays expressible.
  // Unfiltered on the fallback paths: the relative floor exists to stop tail
  // noise occupying FUSION slots. With no fusion happening it would just be
  // hiding results the lexical ranker legitimately found.
  if (!queryHasCorpusTerms(query)) return lexicalAll.slice(0, limit);

  let semantic: ReturnType<typeof searchVectors> = [];
  try {
    semantic = searchVectors(query, {
      projectDir: opts.projectDir ? normalizeProjectDir(opts.projectDir) : undefined,
      sourceSessionId: opts.sourceSessionId,
      limit: CANDIDATE_DEPTH,
    });
  } catch {
    semantic = []; // a broken model must not take the lexical path down with it
  }
  if (semantic.length === 0) return lexicalAll.slice(0, limit);

  const db = getTranscriptsDb();

  // Resolve the semantic hits' doc ids to event metadata in one round trip.
  const docIds = semantic.map(s => s.docId);
  const docRows = db.prepare(
    `SELECT id, event_id, archive_id, source_session_id, seq, kind
       FROM search_docs WHERE id IN (${docIds.map(() => '?').join(', ')})`
  ).all(...docIds) as (Pick<SearchDocRow, 'id' | 'event_id' | 'archive_id' | 'source_session_id' | 'seq' | 'kind'>)[];
  const docById = new Map(docRows.map(r => [r.id, r]));

  type Entry = { hit?: SearchHit; doc?: typeof docRows[number]; chunkIndex?: number; rrf: number };
  const fused = new Map<string, Entry>();

  lexical.forEach((hit, i) => {
    fused.set(hit.eventId, { hit, rrf: rrfWeight(i) });
  });
  semantic.forEach((s, i) => {
    const doc = docById.get(s.docId);
    if (!doc) return;
    const prev = fused.get(doc.event_id);
    const inc = rrfWeight(i);
    if (prev) { prev.rrf += inc; prev.chunkIndex = s.chunkIndex; }
    else fused.set(doc.event_id, { doc, chunkIndex: s.chunkIndex, rrf: inc });
  });

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .slice(0, limit);

  // Text is needed only for entries that arrived semantically — lexical hits
  // already carry a snippet built from their matched terms.
  const needText = ranked.filter(([, e]) => !e.hit).map(([eventId]) => eventId);
  const textById = new Map<string, string>();
  if (needText.length > 0) {
    const rows = db.prepare(
      `SELECT id, text FROM events WHERE id IN (${needText.map(() => '?').join(', ')})`
    ).all(...needText) as { id: string; text: string | null }[];
    for (const r of rows) textById.set(r.id, r.text ?? '');
  }
  const terms = new Set(tokenize(query));

  return ranked.map(([eventId, e]) => {
    if (e.hit) return { ...e.hit, score: e.rrf };
    const doc = e.doc!;
    const text = textById.get(eventId) ?? '';
    return {
      eventId,
      archiveId: doc.archive_id,
      sourceSessionId: doc.source_session_id,
      seq: doc.seq,
      kind: doc.kind,
      // Aim the excerpt at the window that actually matched, so a long event
      // does not open on an unrelated first paragraph (C6's opportunity).
      snippet: buildSnippet(windowAround(text, e.chunkIndex ?? 0), terms),
      score: e.rrf,
    };
  });
}

/** True when at least one query token appears in the corpus dictionary. */
function queryHasCorpusTerms(query: string): boolean {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return false;
  const db = getTranscriptsDb();
  const hit = db.prepare(
    `SELECT 1 AS present FROM search_terms WHERE term IN (${terms.map(() => '?').join(', ')}) LIMIT 1`
  ).get(...terms) as { present: number } | undefined;
  return hit !== undefined;
}

/** The slice of `text` the winning chunk covered, widened by one stride each
 *  way so the snippet has context to work with. */
function windowAround(text: string, chunkIndex: number): string {
  if (text.length <= WINDOW_CHARS) return text;
  const start = Math.max(0, chunkIndex * STRIDE_CHARS - STRIDE_CHARS);
  return text.slice(start, start + WINDOW_CHARS + STRIDE_CHARS * 2);
}
