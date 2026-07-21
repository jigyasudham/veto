import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript } from '../../src/transcripts/adapters/claude.js';

// A compact but representative Claude JSONL fixture: metadata line, string-content
// user message, multi-block assistant (thinking + text + tool_use), a tool_result
// carried on a user line, an unknown type, and a deliberately malformed line.
const FIXTURE = [
  JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'S1' }),
  JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-07-21T10:00:00.000Z', sessionId: 'S1', message: { role: 'user', content: 'fix the AKIA1234567890ABCDEF leak in auth.ts' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-21T10:00:05.000Z', sessionId: 'S1', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'the user pasted a secret' },
    { type: 'text', text: 'I will rotate the key.' },
    { type: 'tool_use', name: 'Edit', input: { file: 'auth.ts', password: 'hunter2very' } },
  ] } }),
  JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-07-21T10:00:06.000Z', sessionId: 'S1', message: { role: 'user', content: [ { type: 'tool_result', content: 'edited auth.ts ok' } ] } }),
  JSON.stringify({ type: 'brand-new-future-type', sessionId: 'S1', foo: 1 }),
  '{ this is not valid json',
  '', // blank line
].join('\n') + '\n';

describe('parseClaudeTranscript — normalization', () => {
  const { events, sessionIds, secretsRedacted } = parseClaudeTranscript(Buffer.from(FIXTURE, 'utf8'));

  it('assigns a monotonic seq and preserves order', () => {
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.length).toBeGreaterThanOrEqual(6);
  });

  it('maps each line type to the right kind', () => {
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('user_message');
    expect(kinds).toContain('assistant_message');
    expect(kinds).toContain('reasoning');    // thinking block
    expect(kinds).toContain('tool_call');    // tool_use block
    expect(kinds).toContain('tool_result');  // on the user line
    expect(kinds).toContain('meta');         // the 'mode' line
    expect(kinds).toContain('unknown');      // future type + malformed line
  });

  it('splits a multi-block assistant line into separate ordered events', () => {
    const a = events.filter(e => e.sourceType === 'assistant');
    expect(a.map(e => e.kind)).toEqual(['reasoning', 'assistant_message', 'tool_call']);
    expect(a[2].toolName).toBe('Edit');
    expect(a.every(e => e.eventUuid === 'a1')).toBe(true); // native uuid preserved
  });

  it('masks secrets in event text (user message + tool_use input)', () => {
    const user = events.find(e => e.kind === 'user_message')!;
    expect(user.text).not.toContain('AKIA1234567890ABCDEF');
    expect(user.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
    expect(user.secretCount).toBeGreaterThanOrEqual(1);

    const toolCall = events.find(e => e.kind === 'tool_call')!;
    expect(toolCall.text).not.toContain('hunter2very');
    expect(secretsRedacted).toBeGreaterThanOrEqual(2);
  });

  it('preserves native uuid/parentUuid, timestamps, and byte offsets', () => {
    const user = events.find(e => e.eventUuid === 'u1')!;
    expect(user.parentUuid).toBeNull();
    expect(user.tsUtc).toBe('2026-07-21T10:00:00.000Z');
    expect(user.rawLength).toBeGreaterThan(0);
    // Offsets are within the buffer and non-overlapping-forward.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].rawOffset).toBeGreaterThanOrEqual(events[i - 1].rawOffset);
    }
  });

  it('collects the session id and never drops a line to garbage', () => {
    expect(sessionIds.has('S1')).toBe(true);
    // The malformed JSON line still yields exactly one ordered 'unknown' event.
    const unparsed = events.filter(e => e.sourceType === '(unparsed)');
    expect(unparsed.length).toBe(1);
  });
});
