// Codex CLI rollout adapter (VERSION-3 item 6, v3.2).
//
// Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, where each
// line is an envelope `{timestamp, type, payload}` carrying TWO interleaved
// streams of the same conversation:
//
//   • `response_item` — the model-API transcript (what the model actually saw);
//   • `event_msg`     — the TUI event stream (what the user actually saw).
//
// Indexing both would double-count every message in BM25, so exactly one stream
// is canonical per role. Which one is not a coin flip — it was measured over 12
// real rollouts spanning six CLI versions (0.118 → 0.130):
//
//   • ASSISTANT: `event_msg/agent_message` is a strict SUPERSET — every one of
//     the 196 `response_item` assistant messages had an agent_message twin, and
//     143 interim "commentary" messages existed ONLY as agent_message (older
//     builds did not persist commentary as response_items). Canonical:
//     agent_message; the response_item twin is demoted to meta.
//   • USER: `response_item/message(role=user)` is the strict superset — zero
//     real user messages appeared only as `event_msg/user_message`, while 21
//     synthetic-but-real inputs (<environment_context>, <subagent_notification>,
//     <turn_aborted>) existed only as response_items. Canonical: the
//     response_item; the event_msg twin is demoted to meta.
//   • TOOLS: `response_item` function_call/function_call_output pair up exactly
//     (543/543), so the tool spine is the response_item stream and the
//     `event_msg` echoes (exec_command_end, patch_apply_end, …) are meta.
//
// Demoted lines are still stored and ordered — nothing is dropped, they just do
// not enter the search index.
//
// `reasoning` payloads carry only `encrypted_content` (an opaque base64 blob;
// summary was empty in 342/342 observed) — that is deliberately NEVER indexed.

import {
  walkJsonl, normalizeTs, contentText, digestArgs, TOOL_DIGEST_CHARS,
  type Obj, type Block, type EventBase, type MappedLine, type ParseResult,
} from './jsonl.js';

// response_item payload types that are the canonical tool spine.
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

function toolNameOf(p: Obj): string {
  if (typeof p.name === 'string' && p.name) return p.name;
  if (p.type === 'web_search_call') return 'web_search';
  return 'tool';
}

function mapResponseItem(p: Obj): Block[] {
  const t = p.type;

  if (t === 'message') {
    const text = contentText(p.content);
    // Assistant text is canonical on the event_msg stream (see header note).
    if (p.role === 'assistant') return [{ kind: 'meta', text: '' }];
    if (p.role === 'user') return [{ kind: 'user_message', text }];
    return [{ kind: 'meta', text: '' }];   // developer/system instruction injections
  }
  if (t === 'reasoning') {
    // summary[] is the only readable part; encrypted_content is never indexed.
    const summary = Array.isArray(p.summary) ? contentText(p.summary, '\n') : '';
    return [{ kind: 'reasoning', text: summary }];
  }
  if (TOOL_CALL_TYPES.has(t)) {
    const name = toolNameOf(p);
    return [{ kind: 'tool_call', text: digestArgs(name, p.arguments ?? p.input ?? p.action ?? {}), toolName: name }];
  }
  if (t === 'web_search_call') {
    return [{ kind: 'tool_call', text: digestArgs('web_search', p.action ?? {}), toolName: 'web_search' }];
  }
  if (TOOL_OUTPUT_TYPES.has(t)) {
    return [{ kind: 'tool_result', text: contentText(p.output ?? p.result ?? '').slice(0, TOOL_DIGEST_CHARS) }];
  }
  return [{ kind: 'meta', text: '' }];
}

function mapEventMsg(p: Obj): Block[] {
  // Only the assistant stream is canonical here; user_message duplicates the
  // response_item and every other event type is UI telemetry.
  if (p.type === 'agent_message') {
    return [{ kind: 'assistant_message', text: typeof p.message === 'string' ? p.message : contentText(p.message) }];
  }
  return [{ kind: 'meta', text: '' }];
}

function mapLine(obj: Obj, sessionIds: Set<string>): MappedLine {
  const p: Obj = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  const outerType = typeof obj.type === 'string' ? obj.type : null;
  const innerType = typeof p.type === 'string' ? p.type : null;

  const base: EventBase = {
    // `response_item/function_call` reads better in the TOC than a bare
    // `response_item`, so the source type records both envelope and payload.
    sourceType: outerType && innerType ? `${outerType}/${innerType}` : outerType,
    role: typeof p.role === 'string' ? p.role : null,
    // call_id links a tool call to its output; turn_id groups one turn.
    eventUuid: typeof p.call_id === 'string' ? p.call_id : null,
    parentUuid: typeof p.turn_id === 'string' ? p.turn_id : null,
    isSidechain: false,
    tsSource: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    tsUtc: normalizeTs(obj.timestamp),
  };

  if (outerType === 'session_meta') {
    if (typeof p.id === 'string') sessionIds.add(p.id);
    // A subagent rollout replays its parent's session_meta too; both ids are
    // recorded so ingest's session-id verification accepts either binding.
    if (typeof p.forked_from_id === 'string') sessionIds.add(p.forked_from_id);
    return { base, blocks: [{ kind: 'meta', text: '' }] };
  }
  if (outerType === 'response_item') return { base, blocks: mapResponseItem(p) };
  if (outerType === 'event_msg') {
    if (p.type === 'agent_message') base.role = 'assistant';
    return { base, blocks: mapEventMsg(p) };
  }
  if (outerType === 'turn_context') return { base, blocks: [{ kind: 'meta', text: '' }] };

  return { base, blocks: [{ kind: 'unknown', text: '' }] };
}

/** Parse a Codex rollout JSONL L0 buffer into ordered, masked, byte-addressed events. */
export function parseCodexTranscript(buf: Buffer): ParseResult {
  return walkJsonl(buf, mapLine);
}
