import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-search-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { searchEvents, toFtsQuery } = await import('../../src/transcripts/search.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

async function addSession(sessionId: string, project: string, lines: string[]) {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((text, i) =>
    JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', uuid: `${sessionId}-${i}`, timestamp: `2026-07-21T10:0${i}:00.000Z`, sessionId, message: { role: i % 2 === 0 ? 'user' : 'assistant', content: i % 2 === 0 ? text : [{ type: 'text', text }] } }),
  ).join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: project });
  await captureSession({ sourceSessionId: sessionId });
  ingestSession(sessionId);
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('toFtsQuery — safe MATCH building', () => {
  it('quotes each token and neutralizes FTS operators/quotes', () => {
    expect(toFtsQuery('E404 publish')).toBe('"E404" "publish"');
    expect(toFtsQuery('normalizeProjectDir')).toBe('"normalizeProjectDir"');
    // A crafted operator string cannot inject — it becomes quoted phrases.
    expect(toFtsQuery('foo OR bar" AND')).toBe('"foo" "OR" "bar" "AND"');
    expect(toFtsQuery('   ')).toBe('');
  });
});

describe('searchEvents — BM25 recall with snippets', () => {
  it('finds the event that mentions an identifier and returns a snippet', async () => {
    await addSession('SS1', 'd:\\proj-a', [
      'we hit an npm E404 error on publish',
      'the fix was to run npm login again',
      'now deploying the release',
    ]);

    const hits = searchEvents('E404 publish', { projectDir: 'd:\\proj-a' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet.toLowerCase()).toContain('e404');
    expect(hits[0].sourceSessionId).toBe('SS1');
    expect(typeof hits[0].score).toBe('number');
    expect(hits[0].eventId).toBeTruthy();
  });

  it('scopes results by project (no cross-project leakage)', async () => {
    await addSession('SS2', 'd:\\proj-b', ['a totally unrelated conversation about widgets']);
    const hits = searchEvents('widgets', { projectDir: 'd:\\proj-a' });
    expect(hits.length).toBe(0); // widgets is in proj-b only
    const hits2 = searchEvents('widgets', { projectDir: 'd:\\proj-b' });
    expect(hits2.length).toBeGreaterThan(0);
  });

  it('can scope to a single session', async () => {
    const hits = searchEvents('npm', { sourceSessionId: 'SS1' });
    expect(hits.every(h => h.sourceSessionId === 'SS1')).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns [] for an empty query', () => {
    expect(searchEvents('   ', {})).toEqual([]);
  });

  it('re-ingest does not duplicate FTS rows', async () => {
    ingestSession('SS1'); // already indexed → no-op
    const hits = searchEvents('login', { sourceSessionId: 'SS1' });
    // exactly one event mentions "login"
    expect(hits.length).toBe(1);
  });
});
