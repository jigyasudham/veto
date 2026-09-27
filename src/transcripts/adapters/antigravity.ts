// Antigravity CLI transcript adapter.
//
// Antigravity (`agy`) keeps one folder per conversation under
// ~/.gemini/antigravity-cli/brain/<conversation-id>/, and writes the
// conversation to .system_generated/logs/transcript_full.jsonl: one line per
// STEP, `{step_index, source, type, status, created_at, ...}`. A sibling
// transcript.jsonl holds the same steps with long fields cut short
// (`truncated_fields`) and tool arguments double-encoded as JSON strings, so the
// full file is the one archived.
//
// Measured on 13 real conversations (2,000+ steps), 2026-09-27:
//   • each step is written once and never revised — no step_index repeats — so
//     unlike Gemini CLI there are no partial copies to demote;
//   • lines are not always in step order (a background step is written when it
//     settles), so order is the file's, and step_index is kept as the event id;
//   • a step still RUNNING when the file was last written stays RUNNING.
//
// The line carries no session id; the conversation id is the folder name, which
// discovery records. `source` says who produced the step:
//   USER_EXPLICIT/USER_INPUT   what the user typed, inside <USER_REQUEST>, with
//                              Antigravity's own metadata blocks around it;
//   MODEL/PLANNER_RESPONSE     the model's turn: `thinking`, `content` (the reply)
//                              and `tool_calls` [{name, args}];
//   MODEL/<anything else>      a tool's result (GENERIC, VIEW_FILE, RUN_COMMAND,
//                              CODE_ACTION, GREP_SEARCH, LIST_DIRECTORY …), its
//                              text prefixed with Created At / Completed At lines;
//   SYSTEM/*                   notices, errors, checkpoints (a summary Antigravity
//                              writes when it truncates the conversation) — meta.

import {
  walkJsonl, normalizeTs, digestArgs, TOOL_DIGEST_CHARS,
  type Obj, type Block, type EventBase, type MappedLine, type ParseResult,
} from './jsonl.js';

const REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
// Blocks Antigravity wraps around a request: the local time, model switches.
const METADATA_RE = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g;
// Every tool result opens with when it ran; that is not what it said.
const TIMING_RE = /^(?:\s*(?:Created|Completed) At: [^\n]*\n)+/;

/** What the user typed: the <USER_REQUEST> body, or the content with Antigravity's metadata removed. */
export function userRequestText(content: unknown): string {
  if (typeof content !== 'string') return '';
  const m = REQUEST_RE.exec(content);
  return (m ? m[1] : content.replace(METADATA_RE, '')).trim();
}

function toolCallBlocks(calls: unknown): Block[] {
  let list = calls;
  // transcript.jsonl double-encodes; accept it too, in case only that file exists.
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const out: Block[] = [];
  for (const c of list as Obj[]) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name : 'tool';
    out.push({ kind: 'tool_call', text: digestArgs(name, c.args), toolName: name });
  }
  return out;
}

function mapLine(obj: Obj): MappedLine {
  const type = typeof obj.type === 'string' ? obj.type : null;
  const who = typeof obj.source === 'string' ? obj.source : null;
  const base: EventBase = {
    sourceType: type,
    role: who === 'USER_EXPLICIT' ? 'user' : who === 'MODEL' ? 'assistant' : null,
    eventUuid: typeof obj.step_index === 'number' ? `step-${obj.step_index}` : null,
    parentUuid: null,
    isSidechain: false,
    tsSource: typeof obj.created_at === 'string' ? obj.created_at : null,
    tsUtc: normalizeTs(obj.created_at),
  };

  if (type === 'USER_INPUT') return { base, blocks: [{ kind: 'user_message', text: userRequestText(obj.content) }] };

  if (who === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const blocks: Block[] = [];
    if (typeof obj.thinking === 'string' && obj.thinking.trim()) blocks.push({ kind: 'reasoning', text: obj.thinking.trim() });
    if (typeof obj.content === 'string' && obj.content.trim()) blocks.push({ kind: 'assistant_message', text: obj.content });
    blocks.push(...toolCallBlocks(obj.tool_calls));
    if (blocks.length === 0) blocks.push({ kind: 'assistant_message', text: '' });
    return { base, blocks };
  }

  if (who === 'MODEL' && type) {
    const text = typeof obj.content === 'string' ? obj.content.replace(TIMING_RE, '').trim() : '';
    return { base, blocks: [{ kind: 'tool_result', text: text.slice(0, TOOL_DIGEST_CHARS), toolName: type.toLowerCase() }] };
  }

  if (who === 'SYSTEM') return { base, blocks: [{ kind: 'meta', text: '' }] };

  return { base, blocks: [{ kind: 'unknown', text: '' }] };
}

/** Parse an Antigravity transcript_full.jsonl L0 buffer into ordered, masked, byte-addressed events. */
export function parseAntigravityTranscript(buf: Buffer): ParseResult {
  return walkJsonl(buf, mapLine);
}
