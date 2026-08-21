// Gemini CLI chat adapter (VERSION-3 item 6, v3.2).
//
// Gemini writes ~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl. Line 1 is
// a header `{sessionId, projectHash, startTime, lastUpdated, kind}`; the rest are
// records `{id, timestamp, type, ...}` with type user | gemini | info | error,
// interleaved with `{"$set":{...}}` header patches and re-written header lines.
//
// THE FORMAT IS AN APPEND-ONLY LOG OF REVISIONS, NOT OF MESSAGES. As a turn
// streams, Gemini appends a NEW line carrying the SAME `id` with the message
// grown a little further — content, then content + thoughts, then content +
// thoughts + toolCalls. Measured on a real session: 202 id-bearing records for
// 79 distinct ids (65 ids revised more than once), and in 65/65 cases the text
// only ever GREW — later revisions are strict supersets of earlier ones.
//
// Indexing every revision would inflate a Gemini session's index ~2.5x with
// partial duplicates of its own messages and let a half-streamed sentence
// outrank the finished one. So the last revision of each id stays searchable and
// its earlier revisions are demoted to `meta`: still stored, still ordered, still
// byte-addressable back into L0 — just not in the search index.
//
// Header/`$set` lines are meta. `info`/`error` are UI notices (e.g. "Request
// cancelled."), not conversation, so they are meta too.

import {
  walkJsonl, normalizeTs, contentText, digestArgs, TOOL_DIGEST_CHARS,
  type Obj, type Block, type EventBase, type MappedLine, type ParseResult, type NormalizedEvent,
} from './jsonl.js';

/** A `gemini` record's toolCalls[] entry → one tool_call + one tool_result. */
function toolBlocks(calls: unknown): Block[] {
  if (!Array.isArray(calls)) return [];
  const out: Block[] = [];
  for (const c of calls as Obj[]) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name : 'tool';
    out.push({ kind: 'tool_call', text: digestArgs(name, c.args), toolName: name });
    if (c.result !== undefined || typeof c.resultDisplay === 'string') {
      const text = typeof c.resultDisplay === 'string' && c.resultDisplay
        ? c.resultDisplay
        : contentText(c.result, ' ');
      out.push({ kind: 'tool_result', text: text.slice(0, TOOL_DIGEST_CHARS), toolName: name });
    }
  }
  return out;
}

function mapLine(obj: Obj, sessionIds: Set<string>): MappedLine {
  // Header lines (the first one and every later rewrite) carry the session id.
  if (typeof obj.sessionId === 'string' && typeof obj.startTime === 'string') {
    sessionIds.add(obj.sessionId);
    return {
      base: {
        sourceType: 'header', role: null, eventUuid: null, parentUuid: null, isSidechain: false,
        tsSource: typeof obj.lastUpdated === 'string' ? obj.lastUpdated : null,
        tsUtc: normalizeTs(obj.lastUpdated ?? obj.startTime),
      },
      blocks: [{ kind: 'meta', text: '' }],
    };
  }

  const type = typeof obj.type === 'string' ? obj.type : null;
  const base: EventBase = {
    sourceType: type ?? (obj.$set ? '$set' : null),
    role: type === 'gemini' ? 'assistant' : type === 'user' ? 'user' : null,
    // The record id is the supersession key; keeping it in event_uuid is both
    // the native identifier AND what supersede() below reads.
    eventUuid: typeof obj.id === 'string' ? obj.id : null,
    parentUuid: null,
    isSidechain: false,
    tsSource: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    tsUtc: normalizeTs(obj.timestamp),
  };

  if (type === 'user') return { base, blocks: [{ kind: 'user_message', text: contentText(obj.content) }] };

  if (type === 'gemini') {
    const blocks: Block[] = [];
    if (Array.isArray(obj.thoughts) && obj.thoughts.length) {
      const text = (obj.thoughts as Obj[])
        .map(t => [t?.subject, t?.description].filter(x => typeof x === 'string').join(': '))
        .filter(Boolean).join('\n');
      if (text) blocks.push({ kind: 'reasoning', text });
    }
    const content = contentText(obj.content);
    if (content) blocks.push({ kind: 'assistant_message', text: content });
    blocks.push(...toolBlocks(obj.toolCalls));
    // An empty streaming placeholder still owes the line an ordered event.
    if (blocks.length === 0) blocks.push({ kind: 'assistant_message', text: '' });
    return { base, blocks };
  }

  if (type === 'info' || type === 'error' || obj.$set) return { base, blocks: [{ kind: 'meta', text: '' }] };

  return { base, blocks: [{ kind: 'unknown', text: '' }] };
}

/**
 * Demote every revision of a record except its last to `meta`, so a message that
 * was appended five times is indexed once. Keyed on (event_uuid, line_index): the
 * several blocks a single line produces share a line and are all kept.
 */
function supersede(events: NormalizedEvent[]): number {
  const lastLine = new Map<string, number>();
  for (const e of events) {
    if (!e.eventUuid) continue;
    const seen = lastLine.get(e.eventUuid);
    if (seen === undefined || e.lineIndex > seen) lastLine.set(e.eventUuid, e.lineIndex);
  }
  let demoted = 0;
  for (const e of events) {
    if (!e.eventUuid || e.kind === 'meta' || e.kind === 'unknown') continue;
    if (e.lineIndex < (lastLine.get(e.eventUuid) ?? e.lineIndex)) {
      e.kind = 'meta';
      e.text = '';
      demoted++;
    }
  }
  return demoted;
}

/** Parse a Gemini CLI chat JSONL L0 buffer into ordered, masked, byte-addressed events. */
export function parseGeminiTranscript(buf: Buffer): ParseResult {
  const result = walkJsonl(buf, mapLine);
  supersede(result.events);
  return result;
}
