// Claude Code JSONL adapter (VERSION-3 item 6, Step 6).
//
// Maps one Claude transcript line to normalized blocks; the byte-addressed walk,
// masking and ordering guarantees live in jsonl.ts and are shared with the Codex
// and Gemini adapters. Design constraints:
//   • one row per conversational unit — an assistant line with thinking/text/
//     tool_use blocks becomes reasoning + assistant_message + tool_call events;
//   • nothing is ever dropped — unknown types become kind='unknown'/'meta',
//     preserved and ordered (drift-safe).
//
// Real Claude line types observed: user, assistant, system, attachment, mode,
// permission-mode, ai-title, last-prompt, bridge-session, pr-link,
// file-history-snapshot. Only user/assistant carry conversation text.

import {
  walkJsonl, normalizeTs, contentText, digestArgs, TOOL_DIGEST_CHARS,
  type Obj, type Block, type EventBase, type MappedLine, type ParseResult,
} from './jsonl.js';

export type { NormalizedEvent, ParseResult } from './jsonl.js';

const META_TYPES = new Set([
  'mode', 'permission-mode', 'ai-title', 'last-prompt', 'bridge-session', 'pr-link',
  'file-history-snapshot', 'system', 'attachment',
]);

function digestToolResult(b: Obj): string {
  return contentText(b.content, ' ').slice(0, TOOL_DIGEST_CHARS);
}

function baseFrom(obj: Obj): EventBase {
  return {
    sourceType: typeof obj.type === 'string' ? obj.type : null,
    eventUuid: typeof obj.uuid === 'string' ? obj.uuid : null,
    parentUuid: typeof obj.parentUuid === 'string' ? obj.parentUuid : null,
    isSidechain: obj.isSidechain === true,
    tsSource: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    tsUtc: normalizeTs(obj.timestamp),
    role: obj.message && typeof obj.message.role === 'string' ? obj.message.role : null,
  };
}

function mapLine(obj: Obj, sessionIds: Set<string>): MappedLine {
  if (typeof obj.sessionId === 'string') sessionIds.add(obj.sessionId);
  const base = baseFrom(obj);
  const blocks: Block[] = [];
  const type = obj.type;

  if (type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') blocks.push({ kind: 'user_message', text: content });
    else if (Array.isArray(content)) {
      content.forEach((b: Obj, bi: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'tool_result') blocks.push({ kind: 'tool_result', text: digestToolResult(b), blockIndex: bi });
        else if (b.type === 'text') blocks.push({ kind: 'user_message', text: typeof b.text === 'string' ? b.text : '', blockIndex: bi });
        else blocks.push({ kind: 'meta', text: '', blockIndex: bi });
      });
    } else blocks.push({ kind: 'user_message', text: '' });
  } else if (type === 'assistant') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      content.forEach((b: Obj, bi: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text') blocks.push({ kind: 'assistant_message', text: typeof b.text === 'string' ? b.text : '', blockIndex: bi });
        else if (b.type === 'thinking') blocks.push({ kind: 'reasoning', text: typeof b.thinking === 'string' ? b.thinking : (typeof b.text === 'string' ? b.text : ''), blockIndex: bi });
        else if (b.type === 'tool_use') blocks.push({ kind: 'tool_call', text: digestArgs(typeof b.name === 'string' ? b.name : 'tool', b.input), blockIndex: bi, toolName: typeof b.name === 'string' ? b.name : null });
        else if (b.type === 'tool_result') blocks.push({ kind: 'tool_result', text: digestToolResult(b), blockIndex: bi });
        else blocks.push({ kind: 'meta', text: '', blockIndex: bi });
      });
    } else if (typeof content === 'string') blocks.push({ kind: 'assistant_message', text: content });
    else blocks.push({ kind: 'assistant_message', text: '' });
  } else if (META_TYPES.has(type)) {
    blocks.push({ kind: 'meta', text: '' });
  } else {
    blocks.push({ kind: 'unknown', text: '' });
  }

  // Never drop a line: guarantee at least one ordered event.
  if (blocks.length === 0) blocks.push({ kind: META_TYPES.has(type) ? 'meta' : 'unknown', text: '' });
  return { base, blocks };
}

/** Parse a Claude JSONL L0 buffer into ordered, masked, byte-addressed events. */
export function parseClaudeTranscript(buf: Buffer): ParseResult {
  return walkJsonl(buf, mapLine);
}
