import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../../src/transcripts/adapters/claude.js';

// Pinned real-format Claude fixture (all 11 observed line types + one malformed
// line). This is the drift canary: if a future adapter change stops recognizing a
// real Claude line type, its events fall to 'unknown' and the unknown-rate check
// below trips — turning silent format drift into a loud test failure.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'claude-sample.jsonl'), 'utf8');

describe('drift canary — pinned Claude fixture', () => {
  const { events, sessionIds } = parseClaudeTranscript(Buffer.from(FIXTURE, 'utf8'));

  it('recognizes the session id and produces ordered events', () => {
    expect(sessionIds.has('FIXA')).toBe(true);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('maps the conversational types to the right kinds', () => {
    const byType = (t: string) => events.filter(e => e.sourceType === t).map(e => e.kind);
    expect(byType('user')).toContain('user_message');
    expect(byType('assistant')).toEqual(expect.arrayContaining(['reasoning', 'assistant_message', 'tool_call']));
    // Tool results arrive on user lines.
    expect(events.some(e => e.kind === 'tool_result')).toBe(true);
  });

  it('classifies known metadata types as meta, not unknown', () => {
    for (const t of ['mode', 'permission-mode', 'ai-title', 'system', 'attachment', 'file-history-snapshot', 'last-prompt', 'bridge-session', 'pr-link']) {
      const kinds = events.filter(e => e.sourceType === t).map(e => e.kind);
      expect(kinds.length, `type ${t} should produce an event`).toBeGreaterThan(0);
      expect(kinds.every(k => k === 'meta'), `type ${t} should be meta`).toBe(true);
    }
  });

  it('DRIFT ALARM: unknown-kind rate stays low (only the malformed line)', () => {
    const unknown = events.filter(e => e.kind === 'unknown');
    // Only the single malformed JSON line should be unknown.
    expect(unknown.length).toBe(1);
    expect(unknown[0].sourceType).toBe('(unparsed)');
    const unknownRate = unknown.length / events.length;
    expect(unknownRate).toBeLessThan(0.12);
  });

  it('extracts tool names and preserves the parent-uuid tree', () => {
    const toolCalls = events.filter(e => e.kind === 'tool_call');
    expect(toolCalls.map(e => e.toolName).sort()).toEqual(['Bash', 'Write']);
    const a1events = events.filter(e => e.eventUuid === 'a1');
    expect(a1events.length).toBe(3);
    expect(a1events.every(e => e.parentUuid === 'u1')).toBe(true);
  });
});
