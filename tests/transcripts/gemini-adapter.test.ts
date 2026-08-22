import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGeminiTranscript } from '../../src/transcripts/adapters/gemini.js';

// Pinned real-format Gemini CLI chat fixture: header line, a header rewrite, a
// $set patch, a message revised three times (the format's defining trait), tool
// calls, info/error notices, an unknown type and a malformed line.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'gemini-sample.jsonl'));

describe('parseGeminiTranscript — normalization', () => {
  const { events, sessionIds, secretsRedacted } = parseGeminiTranscript(FIXTURE);

  it('assigns a dense monotonic seq and preserves order', () => {
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('recognizes the session id from the header line', () => {
    expect(sessionIds.has('5dc752e2-f64c-4f68-929e-d0cca523724b')).toBe(true);
  });

  // The defining property of this format: a message is appended once per
  // revision, so only the last revision may enter the search index.
  it('indexes only the LAST revision of a re-written record', () => {
    const assistant = events.filter(e => e.kind === 'assistant_message');
    expect(assistant.map(e => e.text)).toEqual([
      "I'll swap the hard-coded key for an env var.",
      'Done — deploy.ts now reads the key from the environment.',
    ]);
    // The two earlier revisions of g-1 are demoted, not dropped.
    const g1 = events.filter(e => e.eventUuid === 'g-1');
    expect(g1.length).toBeGreaterThan(3);
    expect(g1.filter(e => e.kind === 'assistant_message').length).toBe(1);
    expect(g1.filter(e => e.kind === 'meta').length).toBeGreaterThan(0);
  });

  it('keeps every block of the surviving revision (they share one line)', () => {
    const g1Final = events.filter(e => e.eventUuid === 'g-1' && e.kind !== 'meta');
    expect(g1Final.map(e => e.kind)).toEqual(['reasoning', 'assistant_message', 'tool_call', 'tool_result']);
    expect(new Set(g1Final.map(e => e.lineIndex)).size).toBe(1);
  });

  it('maps user content arrays to user_message', () => {
    const users = events.filter(e => e.kind === 'user_message');
    expect(users.length).toBe(1);
    expect(users[0].role).toBe('user');
  });

  it('extracts tool calls and results with their names', () => {
    const calls = events.filter(e => e.kind === 'tool_call');
    expect(calls.map(e => e.toolName)).toEqual(['replace', 'run_shell_command']);
    expect(calls[0].text).toContain('file_path');
    const results = events.filter(e => e.kind === 'tool_result');
    expect(results.map(e => e.text)).toEqual([
      'Successfully modified file: D:\\proj\\deploy.ts (1 replacement)',
      '12 passing',
    ]);
  });

  it('turns thoughts into reasoning', () => {
    const reasoning = events.filter(e => e.kind === 'reasoning');
    expect(reasoning.length).toBe(1);
    expect(reasoning[0].text).toContain('Locating the key');
  });

  it('classifies header rewrites, $set patches and UI notices as meta', () => {
    expect(events.filter(e => e.sourceType === 'header').every(e => e.kind === 'meta')).toBe(true);
    expect(events.filter(e => e.sourceType === '$set').every(e => e.kind === 'meta')).toBe(true);
    for (const t of ['info', 'error']) {
      const rows = events.filter(e => e.sourceType === t);
      expect(rows.length, `type ${t} should produce an event`).toBeGreaterThan(0);
      expect(rows.every(e => e.kind === 'meta')).toBe(true);
    }
  });

  it('masks secrets before they leave the adapter', () => {
    expect(secretsRedacted).toBeGreaterThan(0);
    expect(events.every(e => !e.text.includes('AKIA1234567890ABCDEF'))).toBe(true);
  });

  it('preserves byte addressing back into L0', () => {
    const call = events.find(e => e.kind === 'tool_call')!;
    const slice = FIXTURE.subarray(call.rawOffset, call.rawOffset + call.rawLength).toString('utf8');
    expect(JSON.parse(slice).id).toBe('g-1');
  });

  it('keeps unknown types and malformed lines ordered instead of dropping them', () => {
    expect(events.some(e => e.sourceType === 'brand-new-future-type')).toBe(true);
    expect(events.some(e => e.sourceType === '(unparsed)')).toBe(true);
  });
});
