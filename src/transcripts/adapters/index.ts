// Adapter registry — one place that knows which parser owns which source.
//
// `archives.source` is the routing key, so a row captured from Codex is always
// re-derived by the Codex parser even if the ingest that reads it runs inside a
// different host CLI. An unrecognized source falls back to the Claude parser
// rather than failing: a mis-tagged archive still gets ordered, masked,
// byte-addressed events (mostly kind='unknown'), which the drift canaries catch.

import { parseClaudeTranscript } from './claude.js';
import { parseCodexTranscript } from './codex.js';
import { parseGeminiTranscript } from './gemini.js';
import type { ParseResult } from './jsonl.js';

export type { NormalizedEvent, ParseResult } from './jsonl.js';
export { parseClaudeTranscript, parseCodexTranscript, parseGeminiTranscript };

/** Host CLIs Veto can capture transcripts from. */
export const TRANSCRIPT_SOURCES = ['claude', 'codex', 'gemini'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export function isTranscriptSource(s: string): s is TranscriptSource {
  return (TRANSCRIPT_SOURCES as readonly string[]).includes(s);
}

/** Recorded on the archive row so a later reader knows what the bytes are. */
export const FORMAT_HINTS: Record<TranscriptSource, string> = {
  claude: 'claude-jsonl',
  codex: 'codex-rollout-jsonl',
  gemini: 'gemini-chat-jsonl',
};

export function formatHint(source: string): string {
  return isTranscriptSource(source) ? FORMAT_HINTS[source] : source;
}

const PARSERS: Record<TranscriptSource, (buf: Buffer) => ParseResult> = {
  claude: parseClaudeTranscript,
  codex: parseCodexTranscript,
  gemini: parseGeminiTranscript,
};

/** Parse an L0 buffer with the parser that owns `source`. */
export function parseTranscript(source: string, buf: Buffer): ParseResult {
  const parse = isTranscriptSource(source) ? PARSERS[source] : parseClaudeTranscript;
  return parse(buf);
}
