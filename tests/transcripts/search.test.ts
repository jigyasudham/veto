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
const { searchEvents, buildSnippet } = await import('../../src/transcripts/search.js');
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

describe('buildSnippet — JS excerpt with highlights', () => {
  it('wraps matched terms in brackets and clips with ellipses', () => {
    const text = 'a very long preamble that goes on for quite a while before we hit an npm E404 error on publish and then keeps going afterwards too';
    const snip = buildSnippet(text, new Set(['e404', 'publish']));
    expect(snip).toContain('[E404]');
    expect(snip).toContain('[publish]');
    expect(snip.startsWith('…')).toBe(true);
  });

  it('matches through sub-tokens (camelCase and paths)', () => {
    const snip = buildSnippet('the fix landed in normalizeProjectDir yesterday', new Set(['project']));
    expect(snip).toContain('[normalizeProjectDir]');
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

  it('re-ingest does not duplicate index rows', async () => {
    ingestSession('SS1'); // already indexed → no-op
    const hits = searchEvents('login', { sourceSessionId: 'SS1' });
    // exactly one event mentions "login"
    expect(hits.length).toBe(1);
  });

  it('scores are positive and sorted descending (contract flip vs FTS5)', async () => {
    const hits = searchEvents('npm E404 publish', { projectDir: 'd:\\proj-a' });
    expect(hits.length).toBeGreaterThan(1);
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it('ranks the event with the rare term above one with only common terms', async () => {
    await addSession('SS3', 'd:\\proj-rank', [
      'the deploy failed with EIDENTMISMATCH on the registry',
      'the deploy went fine',
      'the deploy went fine again',
      'the deploy went fine as always',
    ]);
    const hits = searchEvents('deploy EIDENTMISMATCH', { projectDir: 'd:\\proj-rank' });
    expect(hits[0].snippet).toContain('[EIDENTMISMATCH]');
  });

  it('df cap: a term present in every document does not blow up or dominate', async () => {
    // "deploy" is in all 4 SS3 events (df/N > 0.5 within that project's corpus
    // contribution); query still works and stays scoped.
    const hits = searchEvents('deploy', { projectDir: 'd:\\proj-rank' });
    // Either capped-but-kept (all terms common) or returned normally — must not throw
    // and must return only proj-rank docs.
    expect(hits.every(h => h.sourceSessionId === 'SS3')).toBe(true);
  });
});
