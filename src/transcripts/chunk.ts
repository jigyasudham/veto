// Chunking for the semantic layer (VERSION-3 item 6, Phase B).
//
// One vector per event demonstrably FAILS the paraphrase gate: mean-pooling a
// 1,936-char event dilutes the one sentence that answers the question down to
// ~5% of the vector, and it never surfaces. Splitting events into overlapping
// windows and scoring each event by its BEST window fixed that — the whole
// reason this file exists (council outcome 9b0595ad, spec §11 amendment).
//
// Boundaries here are a compatibility surface: they are pinned by golden tests
// (C1), and CHUNKER_VERSION must be bumped if any of it changes, because
// stored vectors are only meaningful against the chunker that produced them.

/** Bump on ANY boundary change — forces stored vectors to be re-derived. */
export const CHUNKER_VERSION = 1;

/** Validated by the paraphrase-gate prototype. Not a tuning knob: changing
 *  these invalidates the experiment that justified the semantic layer. */
export const WINDOW_CHARS = 240;
export const STRIDE_CHARS = 120;

/** Input-size guard, not a tuning knob (C2). A pathological event must not be
 *  able to emit unbounded rows; the tail is dropped and stays lexically
 *  searchable via BM25, which indexes the whole text regardless. */
export const MAX_WINDOWS_PER_EVENT = 64;

export type Chunk = {
  index: number;
  /** UTF-16 offsets into the source text, so a hit can aim a snippet (C6). */
  start: number;
  end: number;
  text: string;
};

/** Never split a surrogate pair: a lone surrogate would corrupt normalization
 *  and produce a vector for text that does not exist. Boundaries move forward
 *  off a low surrogate, which keeps the result deterministic. */
function safeBoundary(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return i;
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i + 1 : i;
}

/**
 * Split `text` into overlapping windows.
 *
 * Events at or under the window emit exactly one chunk covering the whole
 * text — the median event is ~205 chars, so most events produce a single row
 * and the vector count stays proportional to content, not to event count.
 */
export function chunkText(text: string): Chunk[] {
  if (text.length === 0) return [];
  if (text.length <= WINDOW_CHARS) {
    return [{ index: 0, start: 0, end: text.length, text }];
  }

  const out: Chunk[] = [];
  for (let raw = 0; raw < text.length && out.length < MAX_WINDOWS_PER_EVENT; raw += STRIDE_CHARS) {
    const start = safeBoundary(text, raw);
    const end = safeBoundary(text, Math.min(start + WINDOW_CHARS, text.length));
    out.push({ index: out.length, start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
  }
  return out;
}
