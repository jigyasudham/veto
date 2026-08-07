// Shared tokenizer — the single source of truth for the portable index.
//
// The one correctness property the whole search layer hangs on: index-time and
// query-time tokenization are the SAME function. The FTS5 design broke this
// subtly (toFtsQuery kept `foo/bar.ts` whole, FTS5's unicode61 re-split it
// inside the quotes), which is why this file exists instead of two ad-hoc
// paths. Property-tested in tests/transcripts/tokenize.test.ts: every token
// emitted at index time finds its document when fed back as a query.
//
// No stemming — this corpus is identifiers, paths, and error strings, where
// porter folding costs more than it buys (`E404` must survive intact).
// Sub-token expansion (step 3 below) buys the recall stemming was buying.

// Keep letters, digits, and the identifier/path glue chars; split on the rest.
const SPLIT = /[^\p{L}\p{N}_\-./@+]+/u;
// Sub-token boundaries inside a kept token: the glue chars…
const SEP = /[_\-./@+]+/;
// …and camelCase humps, detected before lowercasing.
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

// Masked-secret residue and inline blobs: long pure-hex, or long base64-ish
// runs that actually look like data (digits + mixed case or padding) rather
// than a long camelCase identifier. They bloat postings and are never searched.
const HEXY = /^[0-9a-fA-F]{32,}$/;
const B64_CHARS = /^[A-Za-z0-9+/=]{32,}$/;

function isBlob(tok: string): boolean {
  if (tok.length > 64) return true;
  if (HEXY.test(tok)) return true;
  return B64_CHARS.test(tok) && /\d/.test(tok) && (/[+/=]/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok)));
}

/** Sub-token expansion on by default; the ingest benchmark measures both ways. */
export const SUBTOKENS_DEFAULT = true;

/**
 * Tokenize text for indexing or querying — always the same function.
 *
 * 1. Split on anything that is not a letter, digit, or `_ - . / @ +`.
 * 2. Emit each token lowercased.
 * 3. When it looks compound, also emit its lowercased sub-tokens:
 *    `normalizeProjectDir` → normalizeprojectdir, normalize, project, dir;
 *    `src/transcripts/search.ts` → the full path, src, transcripts, search, ts.
 * 4. Drop blobs (see isBlob) and tokens with no letter or digit at all.
 */
export function tokenize(text: string, subtokens: boolean = SUBTOKENS_DEFAULT): string[] {
  const out: string[] = [];
  for (const raw of text.split(SPLIT)) {
    if (!raw || !/[\p{L}\p{N}]/u.test(raw) || isBlob(raw)) continue;
    const whole = raw.toLowerCase();
    out.push(whole);
    if (!subtokens) continue;
    // Two granularities, both emitted: separator segments AND their camel
    // parts. Needed for symmetry — a lowercased emitted token re-splits by
    // separators only (its camel humps are gone), so those segment-level
    // tokens must exist in the index too.
    for (const seg of raw.split(SEP)) {
      const s = seg.toLowerCase();
      const ok = (t: string) => t && /[\p{L}\p{N}]/u.test(t) && !isBlob(t);
      if (s !== whole && ok(s)) out.push(s);
      for (const part of seg.split(CAMEL)) {
        const p = part.toLowerCase();
        if (p !== s && p !== whole && ok(p)) out.push(p);
      }
    }
  }
  return out;
}
