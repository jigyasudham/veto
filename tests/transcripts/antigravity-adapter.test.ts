import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAntigravityTranscript, userRequestText } from '../../src/transcripts/adapters/antigravity.js';

// Pinned real-format Antigravity CLI transcript_full.jsonl: every step type seen
// on 13 real conversations, a step written out of order, a step still RUNNING,
// a pasted key, a line cut short and a type from the future.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'antigravity-sample.jsonl'));

describe('parseAntigravityTranscript — normalization', () => {
  const { events, sessionIds, secretsRedacted } = parseAntigravityTranscript(FIXTURE);

  it('assigns a dense monotonic seq in file order, keeping the step index as the id', () => {
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
    // Step 6 was written after step 7; the file's order is kept, not re-sorted.
    const ids = events.map(e => e.eventUuid).filter(Boolean);
    expect(ids.indexOf('step-7')).toBeLessThan(ids.indexOf('step-6'));
  });

  it('carries no session id in its lines — discovery supplies it from the folder name', () => {
    expect(sessionIds.size).toBe(0);
  });

  it('keeps only what the user typed, without Antigravity\'s metadata blocks', () => {
    const users = events.filter(e => e.kind === 'user_message');
    expect(users.map(e => e.text)).toEqual(['Move the deploy key out of deploy.ts and run the tests.', 'thanks']);
    expect(users.every(e => e.role === 'user')).toBe(true);
  });

  it('splits a model turn into reasoning, reply and one tool_call per call', () => {
    const turn = events.filter(e => e.eventUuid === 'step-4');
    expect(turn.map(e => e.kind)).toEqual(['assistant_message', 'tool_call', 'tool_call']);
    expect(turn.filter(e => e.kind === 'tool_call').map(e => e.toolName)).toEqual(['replace_file_content', 'grep_search']);
    expect(turn[1].text).toContain('TargetFile');
    expect(events.find(e => e.eventUuid === 'step-2' && e.kind === 'reasoning')?.text).toBe('Locating the key before changing anything.');
  });

  it('turns every other model step into a tool_result named by its type, without the timing lines', () => {
    const results = events.filter(e => e.kind === 'tool_result');
    expect(results.map(e => e.toolName)).toEqual(['view_file', 'code_action', 'run_command', 'grep_search', 'list_directory', 'generic']);
    expect(results.every(e => !e.text.includes('Created At:'))).toBe(true);
    expect(results.find(e => e.toolName === 'run_command')?.text).toContain('12 passing');
  });

  it('classifies system notices, errors, checkpoints and history markers as meta', () => {
    for (const t of ['SYSTEM_MESSAGE', 'ERROR_MESSAGE', 'CHECKPOINT', 'CONVERSATION_HISTORY']) {
      const rows = events.filter(e => e.sourceType === t);
      expect(rows.length, `type ${t} should produce an event`).toBe(1);
      expect(rows[0].kind).toBe('meta');
    }
  });

  it('masks secrets before they leave the adapter', () => {
    const fakeKey = 'AKIA' + '1234567890ABCDEF'; // the fixture's placeholder key
    expect(secretsRedacted).toBeGreaterThan(0);
    expect(events.every(e => !e.text.includes(fakeKey))).toBe(true);
  });

  it('records the cut-off line and the unknown source instead of dropping them', () => {
    expect(events.filter(e => e.kind === 'unknown').map(e => e.sourceType).sort()).toEqual(['(unparsed)', 'BRAND_NEW_TYPE']);
  });

  it('byte-addresses every event back into the file', () => {
    for (const e of events) {
      const line = FIXTURE.subarray(e.rawOffset, e.rawOffset + e.rawLength).toString('utf8');
      if (e.eventUuid) expect(line).toContain(`"step_index":${e.eventUuid.slice(5)}`);
    }
  });
});

describe('userRequestText', () => {
  it('reads the <USER_REQUEST> body', () => {
    expect(userRequestText('<USER_REQUEST>\n  do it \n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>')).toBe('do it');
  });

  it('strips the metadata blocks when there is no request wrapper', () => {
    expect(userRequestText('hello\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>')).toBe('hello');
  });

  it('accepts double-encoded tool arguments from transcript.jsonl', () => {
    const line = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-09-26T09:26:38Z',
      tool_calls: JSON.stringify([{ name: 'list_dir', args: { DirectoryPath: 'D:\\p' } }]) });
    const { events } = parseAntigravityTranscript(Buffer.from(line + '\n'));
    expect(events.map(e => [e.kind, e.toolName])).toEqual([['tool_call', 'list_dir']]);
  });
});
