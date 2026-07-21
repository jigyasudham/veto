import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-toc-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { buildTOC, renderTOC } = await import('../../src/transcripts/toc.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const TRANSCRIPT = join(ROOT, 'toc.jsonl');

async function setup() {
  // Two user prompts → two phases; a preamble 'mode' line first.
  writeFileSync(TRANSCRIPT, [
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'TC' }),
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-21T10:00:00.000Z', sessionId: 'TC', message: { role: 'user', content: 'add a login form to the app' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-21T10:00:05.000Z', sessionId: 'TC', message: { role: 'assistant', content: [ { type: 'tool_use', name: 'Write', input: { file_path: 'login.tsx' } } ] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-07-21T10:05:00.000Z', sessionId: 'TC', message: { role: 'user', content: 'now run the tests' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-07-21T10:05:05.000Z', sessionId: 'TC', message: { role: 'assistant', content: [ { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } ] } }),
    JSON.stringify({ type: 'user', uuid: 'u3', timestamp: '2026-07-21T10:05:10.000Z', sessionId: 'TC', message: { role: 'user', content: [ { type: 'tool_result', content: 'Error: 2 tests failed' } ] } }),
  ].join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: 'TC', transcriptPath: TRANSCRIPT });
  await captureSession({ sourceSessionId: 'TC' });
  ingestSession('TC');
  return getArchive('TC')!;
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('buildTOC — phase segmentation', () => {
  it('opens a preamble then one segment per user prompt', async () => {
    const arch = await setup();
    const toc = buildTOC(arch.id);
    // preamble + 2 user-prompt phases
    expect(toc.length).toBe(3);
    expect(toc[0].title).toBe('(session start)');
    expect(toc[1].title).toContain('add a login form');
    expect(toc[2].title).toContain('now run the tests');
  });

  it('captures per-segment files, tools, and error flags; ranges are contiguous', async () => {
    const arch = await setup();
    const toc = buildTOC(arch.id);
    const loginPhase = toc.find(s => s.title.includes('login form'))!;
    expect(loginPhase.files).toContain('login.tsx');
    expect(loginPhase.tools).toContain('Write');
    expect(loginPhase.hasError).toBe(false);

    const testPhase = toc.find(s => s.title.includes('run the tests'))!;
    expect(testPhase.tools).toContain('Bash');
    expect(testPhase.hasError).toBe(true); // the "Error: 2 tests failed" tool_result

    // Segments are ordered and non-overlapping.
    for (let i = 1; i < toc.length; i++) {
      expect(toc[i].fromSeq).toBeGreaterThan(toc[i - 1].toSeq);
    }
  });

  it('renders a compact one-line-per-segment map', async () => {
    const arch = await setup();
    const text = renderTOC(buildTOC(arch.id));
    expect(text).toContain('login form');
    expect(text).toContain('⚠err');
    expect(text).toContain('files:login.tsx');
  });

  it('returns [] for an archive with no events', () => {
    expect(buildTOC('nonexistent')).toEqual([]);
  });
});
