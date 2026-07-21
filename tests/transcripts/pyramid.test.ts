import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-pyramid-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { buildSpine, buildFacts, renderFacts } = await import('../../src/transcripts/pyramid.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const TRANSCRIPT = join(ROOT, 'sp.jsonl');

async function setup() {
  writeFileSync(TRANSCRIPT, [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-21T10:00:00.000Z', sessionId: 'SP', message: { role: 'user', content: 'run the tests and fix auth.ts' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-21T10:00:05.000Z', sessionId: 'SP', message: { role: 'assistant', content: [
      { type: 'text', text: 'running the tests' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-07-21T10:00:10.000Z', sessionId: 'SP', message: { role: 'user', content: [ { type: 'tool_result', content: 'FAIL: 1 test failed with an error' } ] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-07-21T10:00:20.000Z', sessionId: 'SP', message: { role: 'assistant', content: [
      { type: 'text', text: 'fixing it' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'auth.ts', old: 'x', new: 'y' } },
    ] } }),
  ].join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: 'SP', transcriptPath: TRANSCRIPT });
  await captureSession({ sourceSessionId: 'SP' });
  ingestSession('SP');
  return getArchive('SP')!;
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('L2 spine — user + assistant text only, in order', () => {
  it('includes user + assistant messages and strips tool chatter', async () => {
    const arch = await setup();
    const spine = buildSpine(arch.id);
    const texts = spine.map(s => s.text);
    expect(texts).toContain('run the tests and fix auth.ts');
    expect(texts).toContain('running the tests');
    expect(texts).toContain('fixing it');
    // No tool_call/tool_result lines in the spine.
    expect(spine.every(s => s.kind === 'user_message' || s.kind === 'assistant_message')).toBe(true);
    // Ordered by seq.
    expect(spine.map(s => s.seq)).toEqual([...spine.map(s => s.seq)].sort((a, b) => a - b));
  });
});

describe('L1 facts — deterministic aggregates', () => {
  it('counts messages/tools, extracts files + commands, flags errors', async () => {
    const arch = await setup();
    const f = buildFacts(arch.id);
    // The 2nd "user" line carries only a tool_result block → classified as a
    // tool_result, not a user utterance. So one real user message, one tool_result.
    expect(f.counts.user).toBe(1);
    expect(f.counts.tool_results).toBe(1);
    expect(f.counts.assistant).toBe(2);
    expect(f.counts.tool_calls).toBe(2);
    expect(f.files).toContain('auth.ts');
    expect(f.commands).toContain('npm test');
    expect(f.errorCount).toBeGreaterThanOrEqual(1); // the FAIL tool_result
    expect(f.tools.map(t => t.name).sort()).toEqual(['Bash', 'Edit']);
    expect(f.firstTs).toBe('2026-07-21T10:00:00.000Z');
    expect(f.lastTs).toBe('2026-07-21T10:00:20.000Z');
  });

  it('renders a compact fact block for resume injection', async () => {
    const arch = await setup();
    const text = renderFacts(buildFacts(arch.id));
    expect(text).toContain('files: auth.ts');
    expect(text).toContain('npm test');
    expect(text).toContain('errors observed:');
  });
});
