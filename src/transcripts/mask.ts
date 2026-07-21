// Secret detection + masking for transcript capture (VERSION-3 item 6, Step 3).
//
// The single shared primitive both write-side (ingest into derived layers) and
// read-side (mask-on-expansion of L0 bytes) call, so a secret can never transit
// into an AI context through Veto. A detected secret is replaced with a STABLE
// fingerprint token — REDACTED[sha256:xxxxxxxx] — of the secret value, so:
//   • the value itself is never stored in an indexable/servable layer, and
//   • recurrences of the same secret share a token, so recall can still say
//     "a secret was here" and correlate without ever revealing it.
//
// Patterns extend src/agents/security/secrets.ts (that scanner is code-oriented
// and display-only). Here we redact the VALUE span (keeping surrounding prose
// readable) and add a multiline private-key block + a few creds people paste
// into chat. Detection is best-effort defense-in-depth — the non-synced archive
// dir and `veto transcripts redact` are the backstops for what it misses.

import { createHash } from 'node:crypto';

export type MaskPattern = {
  type: string;
  regex: RegExp;
  /** Capture group that is the secret VALUE; 0 = redact the whole match. */
  group: number;
};

// group 1 (where present) is the sensitive value; the label/quotes/host around
// it are preserved so a recalled line stays readable.
const MASK_PATTERNS: MaskPattern[] = [
  // Multiline block first — redact the ENTIRE key, not just the header line.
  { type: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/, group: 0 },
  { type: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/, group: 0 },
  { type: 'AWS Secret Access Key', regex: /aws_secret_access_key\s*=\s*['"]?([A-Za-z0-9/+]{40})['"]?/i, group: 1 },
  { type: 'GitHub Token', regex: /gh[posru]_[A-Za-z0-9]{36,}/, group: 0 },
  { type: 'GitHub Token (env)', regex: /github_token\s*[:=]\s*['"]([A-Za-z0-9_]{20,})['"]/i, group: 1 },
  { type: 'Slack Token', regex: /xox[baprs]-[0-9A-Za-z-]{10,}/, group: 0 },
  { type: 'Google API Key', regex: /AIza[0-9A-Za-z_-]{35}/, group: 0 },
  { type: 'Provider Key (sk-)', regex: /sk-[A-Za-z0-9_-]{20,}/, group: 0 },
  { type: 'Bearer Token', regex: /bearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/i, group: 1 },
  { type: 'MongoDB URI Password', regex: /mongodb(?:\+srv)?:\/\/[^\s:@/]+:([^\s@/]+)@/i, group: 1 },
  { type: 'Postgres URI Password', regex: /postgres(?:ql)?:\/\/[^\s:@/]+:([^\s@/]+)@/i, group: 1 },
  { type: 'MySQL URI Password', regex: /mysql:\/\/[^\s:@/]+:([^\s@/]+)@/i, group: 1 },
  // JSON-style "key":"value" (tool inputs are JSON) — the quote sits before the
  // colon, so the key[:=]value patterns above don't catch it.
  { type: 'JSON secret field', regex: /"(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|jwt[_-]?secret|auth[_-]?token|private[_-]?key|passphrase)"\s*:\s*"([^"]{4,})"/i, group: 1 },
  { type: 'API Key (generic)', regex: /(?:api[_-]?key)\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/i, group: 1 },
  { type: 'JWT Secret', regex: /jwt_secret\s*[:=]\s*['"]([^'"]{8,})['"]/i, group: 1 },
  { type: 'Password', regex: /password\s*[:=]\s*['"]([^'"]{4,})['"]/i, group: 1 },
  { type: 'Generic High-Entropy Secret', regex: /(?:secret|token|passwd)\s*[:=]\s*['"]([A-Za-z0-9+/=_-]{24,})['"]/i, group: 1 },
];

/** Matches an emitted mask token — lets callers detect already-masked content. */
export const REDACTED_RE = /REDACTED\[sha256:[0-9a-f]{8}\]/g;

// Anchored form: true when a string IS exactly a mask token (used to keep mask()
// idempotent — a token sitting inside quotes must not be re-matched as a value).
const IS_TOKEN_RE = /^REDACTED\[sha256:[0-9a-f]{8}\]$/;

export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

export function maskToken(secret: string): string {
  return `REDACTED[sha256:${fingerprint(secret)}]`;
}

export type MaskResult = {
  /** The input with every detected secret value replaced by a fingerprint token. */
  text: string;
  /** Number of secrets redacted (deduped by span). */
  count: number;
  /** Distinct fingerprints seen, in order of first appearance. */
  fingerprints: string[];
};

type Span = { start: number; end: number; secret: string };

/** Recompile a pattern with the global + indices flags (idempotent on flags). */
function withScanFlags(re: RegExp): RegExp {
  const base = re.flags.replace(/[gd]/g, '');
  return new RegExp(re.source, base + 'gd');
}

/**
 * Detect and redact secrets. Operates on the WHOLE string (so multiline keys and
 * global offsets work). Overlapping matches resolve to a single redaction.
 */
export function mask(input: string): MaskResult {
  if (!input) return { text: input, count: 0, fingerprints: [] };

  const spans: Span[] = [];
  for (const p of MASK_PATTERNS) {
    const re = withScanFlags(p.regex);
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      let start: number, end: number, secret: string;
      const gi = p.group;
      const idx = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
      if (gi > 0 && idx && idx[gi]) {
        [start, end] = idx[gi]!;
        secret = input.slice(start, end);
      } else {
        start = m.index;
        end = m.index + m[0].length;
        secret = m[0];
      }
      // Idempotency: never re-redact an already-emitted mask token (it can sit
      // inside quotes and re-match a value pattern).
      if (IS_TOKEN_RE.test(secret)) continue;
      spans.push({ start, end, secret });
    }
  }
  if (spans.length === 0) return { text: input, count: 0, fingerprints: [] };

  // Earliest-start, then widest, then drop anything overlapping an accepted span.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) { merged.push(s); lastEnd = s.end; }
  }

  let out = '';
  let cursor = 0;
  const fingerprints: string[] = [];
  for (const s of merged) {
    out += input.slice(cursor, s.start) + maskToken(s.secret);
    const fp = fingerprint(s.secret);
    if (!fingerprints.includes(fp)) fingerprints.push(fp);
    cursor = s.end;
  }
  out += input.slice(cursor);
  return { text: out, count: merged.length, fingerprints };
}

/** Convenience: true when the input contains at least one detectable secret. */
export function hasSecrets(input: string): boolean {
  return mask(input).count > 0;
}
