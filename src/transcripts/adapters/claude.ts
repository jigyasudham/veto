// Claude Code JSONL adapter (VERSION-3 item 6, Step 6).
//
// Parses the UNCOMPRESSED L0 bytes into normalized events. Design constraints:
//   • one row per conversational unit — an assistant line with thinking/text/
//     tool_use blocks becomes reasoning + assistant_message + tool_call events;
//   • text is ALWAYS masked (Step 3) before it leaves this function;
//   • raw_offset/raw_length are byte offsets into the L0 buffer (for expansion);
//   • nothing is ever dropped — unparseable lines and unknown types become
//     kind='unknown'/'meta', preserved and ordered (drift-safe);
//   • bounded: oversized lines are recorded but not JSON-parsed (DoS guard).
//
// Real Claude line types observed: user, assistant, system, attachment, mode,
// permission-mode, ai-title, last-prompt, bridge-session, pr-link,
// file-history-snapshot. Only user/assistant carry conversation text.

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
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const TOOL_DIGEST_CHARS = 500;

const META_TYPES = new Set([
  'mode', 'permission-mode', 'ai-title', 'last-prompt', 'bridge-session', 'pr-link',
  'file-history-snapshot', 'system', 'attachment',
]);

function normalizeTs(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const d = Date.parse(ts);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

function digestToolUse(b: Record<string, unknown>): string {
  const name = typeof b.name === 'string' ? b.name : 'tool';
  let input = '';
  try { input = JSON.stringify(b.input ?? {}); } catch { input = ''; }
  return `${name} ${input}`.slice(0, TOOL_DIGEST_CHARS);
}

function digestToolResult(b: Record<string, unknown>): string {
  const c = b.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: string }).text === 'string' ? (x as { text: string }).text : '')).join(' ');
  } else if (c && typeof c === 'object') {
    try { text = JSON.stringify(c); } catch { text = ''; }
  }
  return text.slice(0, TOOL_DIGEST_CHARS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

function baseFrom(obj: Obj, lineIndex: number, rawOffset: number, rawLength: number) {
  return {
    lineIndex,
    rawOffset,
    rawLength,
    sourceType: typeof obj.type === 'string' ? obj.type : null,
    eventUuid: typeof obj.uuid === 'string' ? obj.uuid : null,
    parentUuid: typeof obj.parentUuid === 'string' ? obj.parentUuid : null,
    isSidechain: obj.isSidechain === true,
    tsSource: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    tsUtc: normalizeTs(obj.timestamp),
    role: obj.message && typeof obj.message.role === 'string' ? obj.message.role : null,
  };
}

function mapLine(obj: Obj, lineIndex: number, rawOffset: number, rawLength: number): NormalizedEvent[] {
  const base = baseFrom(obj, lineIndex, rawOffset, rawLength);
  const out: NormalizedEvent[] = [];
  const push = (kind: EventKind, rawText: string, blockIndex = 0, toolName: string | null = null) => {
    const m = mask((rawText ?? '').slice(0, MAX_TEXT_CHARS));
    out.push({ ...base, seq: 0, blockIndex, kind, toolName, text: m.text, secretCount: m.count });
  };

  const type = obj.type;
  if (type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') push('user_message', content);
    else if (Array.isArray(content)) {
      content.forEach((b: Obj, bi: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'tool_result') push('tool_result', digestToolResult(b), bi);
        else if (b.type === 'text') push('user_message', typeof b.text === 'string' ? b.text : '', bi);
        else push('meta', '', bi);
      });
    } else push('user_message', '');
  } else if (type === 'assistant') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      content.forEach((b: Obj, bi: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text') push('assistant_message', typeof b.text === 'string' ? b.text : '', bi);
        else if (b.type === 'thinking') push('reasoning', typeof b.thinking === 'string' ? b.thinking : (typeof b.text === 'string' ? b.text : ''), bi);
        else if (b.type === 'tool_use') push('tool_call', digestToolUse(b), bi, typeof b.name === 'string' ? b.name : null);
        else if (b.type === 'tool_result') push('tool_result', digestToolResult(b), bi);
        else push('meta', '', bi);
      });
    } else if (typeof content === 'string') push('assistant_message', content);
    else push('assistant_message', '');
  } else if (META_TYPES.has(type)) {
    push('meta', '');
  } else {
    push('unknown', '');
  }

  // Never drop a line: guarantee at least one ordered event.
  if (out.length === 0) push(META_TYPES.has(type) ? 'meta' : 'unknown', '');
  return out;
}

/** Parse a Claude JSONL L0 buffer into ordered, masked, byte-addressed events. */
export function parseClaudeTranscript(buf: Buffer): ParseResult {
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

    let emitted: NormalizedEvent[];
    if (rawLength > MAX_LINE_BYTES) {
      const m = mask('');
      emitted = [{
        seq: 0, lineIndex: li, blockIndex: 0, kind: 'unknown', sourceType: '(oversized)', role: null,
        toolName: null, text: m.text, secretCount: 0, eventUuid: null, parentUuid: null, isSidechain: false,
        tsSource: null, tsUtc: null, rawOffset: start, rawLength,
      }];
    } else {
      const lineStr = buf.toString('utf8', start, end);
      let obj: Obj | null = null;
      try { obj = JSON.parse(lineStr) as Obj; } catch { obj = null; }
      if (!obj || typeof obj !== 'object') {
        emitted = [{
          seq: 0, lineIndex: li, blockIndex: 0, kind: 'unknown', sourceType: '(unparsed)', role: null,
          toolName: null, text: '', secretCount: 0, eventUuid: null, parentUuid: null, isSidechain: false,
          tsSource: null, tsUtc: null, rawOffset: start, rawLength,
        }];
      } else {
        if (typeof obj.sessionId === 'string') sessionIds.add(obj.sessionId);
        emitted = mapLine(obj, li, start, rawLength);
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
