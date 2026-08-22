// Shared JSONL line-walker for every transcript adapter (VERSION-3 item 6).
//
// All three host CLIs write line-delimited JSON, and the parts that MUST behave
// identically across them are exactly the parts that are easy to get subtly
// wrong per-adapter:
//   • raw_offset/raw_length are byte offsets into the UNCOMPRESSED L0 buffer —
//     expand.ts slices L0 with them, so an off-by-one here is a wrong quote;
//   • seq is dense and monotonic across the whole file (the TOC, segments and
//     from_seq/to_seq expansion all assume no gaps);
//   • nothing is ever dropped — an oversized or malformed line still produces an
//     ordered event, so format drift degrades instead of losing data;
//   • text is ALWAYS masked before it leaves the adapter.
//
// An adapter therefore describes each line declaratively — an identity `base`
// plus the blocks that line contains — and the walk, the guards, the masking and
// the bookkeeping live here once.

import { mask } from '../mask.js';
import type { EventKind } from '../schema.js';

export type NormalizedEvent = {
  seq: number;
  lineIndex: number;
  blockIndex: number;
  kind: EventKind;
  sourceType: string | null;
  role: string | null;
  toolName: string | null;
  text: string;        // masked
  secretCount: number;
  eventUuid: string | null;
  parentUuid: string | null;
  isSidechain: boolean;
  tsSource: string | null;
  tsUtc: string | null;
  rawOffset: number;
  rawLength: number;
};

export type ParseResult = {
  events: NormalizedEvent[];
  sessionIds: Set<string>;
  secretsRedacted: number;
};

// Lines above this are recorded but not JSON-parsed (guards against a crafted
// giant line). Individual event text is also capped.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
export const TOOL_DIGEST_CHARS = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

/** The identity fields shared by every event derived from one source line. */
export type EventBase = {
  sourceType: string | null;
  role: string | null;
  eventUuid: string | null;
  parentUuid: string | null;
  isSidechain: boolean;
  tsSource: string | null;
  tsUtc: string | null;
};

/** One conversational unit within a line. `text` is masked by the walker. */
export type Block = {
  kind: EventKind;
  text: string;
  toolName?: string | null;
  /** Index of the originating block in the source line; defaults to position. */
  blockIndex?: number;
};

export type MappedLine = { base: EventBase; blocks: Block[] };

/**
 * Turns one parsed JSON line into its identity + blocks. Returning zero blocks is
 * allowed; the walker still records an ordered placeholder so seq never gaps.
 */
export type LineMapper = (obj: Obj, sessionIds: Set<string>) => MappedLine;

export function normalizeTs(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const d = Date.parse(ts);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

/** `name {json args}` — the shape pyramid.ts's FILE_RE / COMMAND_RE read facts out of. */
export function digestArgs(name: string, args: unknown): string {
  let input = '';
  if (typeof args === 'string') input = args;
  else { try { input = JSON.stringify(args ?? {}); } catch { input = ''; } }
  return `${name} ${input}`.slice(0, TOOL_DIGEST_CHARS);
}

/** Collapse a Claude/Gemini-style content array (or plain string) to text. */
export function contentText(content: unknown, sep = ''): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (x && typeof x === 'object' && typeof (x as { text?: string }).text === 'string' ? (x as { text: string }).text : ''))
      .join(sep);
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

export const EMPTY_BASE: EventBase = {
  sourceType: null, role: null, eventUuid: null, parentUuid: null,
  isSidechain: false, tsSource: null, tsUtc: null,
};

function emit(
  out: NormalizedEvent[],
  base: EventBase,
  blocks: Block[],
  lineIndex: number,
  rawOffset: number,
  rawLength: number,
): void {
  blocks.forEach((b, i) => {
    const m = mask((b.text ?? '').slice(0, MAX_TEXT_CHARS));
    out.push({
      ...base,
      seq: 0,
      lineIndex,
      blockIndex: b.blockIndex ?? i,
      kind: b.kind,
      toolName: b.toolName ?? null,
      text: m.text,
      secretCount: m.count,
      rawOffset,
      rawLength,
    });
  });
}

/**
 * Walk an L0 JSONL buffer, delegating each parsed line to `mapLine`.
 * Byte-addressed, order-preserving and drift-safe; never throws on bad input.
 */
export function walkJsonl(buf: Buffer, mapLine: LineMapper): ParseResult {
  const events: NormalizedEvent[] = [];
  const sessionIds = new Set<string>();
  let secretsRedacted = 0;
  let seq = 0;
  let lineIndex = 0;
  let pos = 0;
  const len = buf.length;

  while (pos < len) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl === -1) nl = len;
    const start = pos;
    const end = nl;           // exclusive; excludes the newline
    const rawLength = end - start;
    pos = nl + 1;
    const li = lineIndex++;
    if (rawLength === 0) continue; // blank line

    const emitted: NormalizedEvent[] = [];
    if (rawLength > MAX_LINE_BYTES) {
      emit(emitted, { ...EMPTY_BASE, sourceType: '(oversized)' }, [{ kind: 'unknown', text: '' }], li, start, rawLength);
    } else {
      const lineStr = buf.toString('utf8', start, end);
      let obj: Obj | null = null;
      try { obj = JSON.parse(lineStr) as Obj; } catch { obj = null; }
      if (!obj || typeof obj !== 'object') {
        emit(emitted, { ...EMPTY_BASE, sourceType: '(unparsed)' }, [{ kind: 'unknown', text: '' }], li, start, rawLength);
      } else {
        const mapped = mapLine(obj, sessionIds);
        // Never drop a line: a mapper that produced nothing still owes one event.
        const blocks = mapped.blocks.length > 0 ? mapped.blocks : [{ kind: 'unknown' as EventKind, text: '' }];
        emit(emitted, mapped.base, blocks, li, start, rawLength);
      }
    }

    for (const e of emitted) {
      e.seq = seq++;
      secretsRedacted += e.secretCount;
      events.push(e);
    }
  }

  return { events, sessionIds, secretsRedacted };
}
