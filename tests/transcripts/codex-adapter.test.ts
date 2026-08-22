import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexTranscript } from '../../src/transcripts/adapters/codex.js';

// Pinned real-format Codex rollout fixture: session_meta, both interleaved
// streams (response_item + event_msg), all four tool shapes, an encrypted
// reasoning payload, an unknown envelope type and a malformed line.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'codex-sample.jsonl'));

describe('parseCodexTranscript — normalization', () => {
  const { events, sessionIds, secretsRedacted } = parseCodexTranscript(FIXTURE);
  const kindsOf = (sourceType: string) => events.filter(e => e.sourceType === sourceType).map(e => e.kind);

  it('assigns a dense monotonic seq and preserves order', () => {
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('recognizes the session id from session_meta', () => {
    expect(sessionIds.has('CODEXA')).toBe(true);
  });

  it('records the envelope and payload type together as source_type', () => {
    expect(events.some(e => e.sourceType === 'response_item/function_call')).toBe(true);
    expect(events.some(e => e.sourceType === 'event_msg/agent_message')).toBe(true);
  });

  // The dedupe contract, measured over 12 real rollouts: assistant text is
  // canonical on event_msg, user text on response_item, and each twin is meta.
  it('takes assistant text from event_msg and demotes the response_item twin', () => {
    expect(kindsOf('event_msg/agent_message')).toEqual(['assistant_message', 'assistant_message']);
    expect(kindsOf('response_item/message')).not.toContain('assistant_message');
    const assistant = events.filter(e => e.kind === 'assistant_message').map(e => e.text);
    expect(assistant).toContain('Checking the deploy script first.');
    expect(assistant).toContain('Replaced the hard-coded key in deploy.ts with process.env.AWS_KEY.');
  });

  it('takes user text from response_item and demotes the event_msg twin', () => {
    expect(kindsOf('event_msg/user_message')).toEqual(['meta']);
    const users = events.filter(e => e.kind === 'user_message');
    expect(users.length).toBe(2); // the environment_context injection + the real prompt
    expect(users.some(e => e.text.includes('environment_context'))).toBe(true);
  });

  it('indexes each message exactly once (no double-counting across the two streams)', () => {
    const finalMsg = 'Replaced the hard-coded key in deploy.ts with process.env.AWS_KEY.';
    const hits = events.filter(e => e.kind === 'assistant_message' && e.text === finalMsg);
    expect(hits.length).toBe(1);
    // task_complete echoes it a third time; that must stay meta.
    expect(kindsOf('event_msg/task_complete')).toEqual(['meta']);
  });

  it('treats developer-role instruction injections as meta, not user text', () => {
    const dev = events.find(e => e.role === 'developer')!;
    expect(dev.kind).toBe('meta');
    expect(dev.text).toBe('');
  });

  it('maps every tool shape to a call/result pair with its tool name', () => {
    const calls = events.filter(e => e.kind === 'tool_call');
    expect(calls.map(e => e.toolName)).toEqual(['shell_command', 'apply_patch', 'web_search']);
    const results = events.filter(e => e.kind === 'tool_result');
    expect(results.length).toBe(2);
    expect(results[0].text).toContain('Exit code: 0');
  });

  it('links a tool call to its output through call_id and groups turns by turn_id', () => {
    const pair = events.filter(e => e.eventUuid === 'call_A1' && (e.kind === 'tool_call' || e.kind === 'tool_result'));
    expect(pair.map(e => e.kind)).toEqual(['tool_call', 'tool_result']);
    expect(events.some(e => e.parentUuid === 'T1')).toBe(true);
  });

  it('NEVER indexes the opaque encrypted reasoning blob', () => {
    const reasoning = events.filter(e => e.kind === 'reasoning');
    expect(reasoning.length).toBe(1);
    expect(reasoning[0].text).toBe('');
    expect(events.every(e => !e.text.includes('gAAAAABp_L89'))).toBe(true);
  });

  it('masks secrets in both streams before they leave the adapter', () => {
    expect(secretsRedacted).toBeGreaterThan(0);
    expect(events.every(e => !e.text.includes('AKIA1234567890ABCDEF'))).toBe(true);
    const user = events.find(e => e.kind === 'user_message' && e.text.includes('deploy.ts'))!;
    expect(user.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
  });

  it('preserves timestamps and byte addressing back into L0', () => {
    const call = events.find(e => e.kind === 'tool_call')!;
    expect(call.tsUtc).toBe('2026-05-07T16:35:10.490Z');
    const slice = FIXTURE.subarray(call.rawOffset, call.rawOffset + call.rawLength).toString('utf8');
    expect(JSON.parse(slice).payload.call_id).toBe('call_A1');
  });

  it('keeps unknown envelopes and malformed lines ordered instead of dropping them', () => {
    expect(events.some(e => e.sourceType === 'brand_new_future_envelope/whatever')).toBe(true);
    expect(events.some(e => e.sourceType === '(unparsed)')).toBe(true);
  });
});
