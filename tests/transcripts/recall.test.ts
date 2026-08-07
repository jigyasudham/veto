import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-recall-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { recallQuery, recallExpand } = await import('../../src/transcripts/recall.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const SECRET = 'ghp_' + 'z'.repeat(36);

async function captureOnly(sessionId: string, project: string, lines: Array<{ role: 'user' | 'assistant'; text: string }>) {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l, i) =>
    JSON.stringify({ type: l.role, uuid: `${sessionId}-${i}`, timestamp: `2026-07-21T10:0${i}:00.000Z`, sessionId, message: { role: l.role, content: l.role === 'user' ? l.text : [{ type: 'text', text: l.text }] } }),
  ).join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: project });
  await captureSession({ sourceSessionId: sessionId });
  // NOTE: deliberately NOT ingesting — recallQuery must index lazily.
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('recallQuery — Phase 1 (lazy-indexes, then searches)', () => {
  it('indexes on demand and returns hits + a TOC for a single-session scope', async () => {
    await captureOnly('R1', 'd:\\recall-proj', [
      { role: 'user', text: `deploy failed with an npm E404 and I pasted ${SECRET} by mistake` },
      { role: 'assistant', text: 'the fix was npm login, then republish' },
    ]);

    const res = recallQuery({ query: 'E404 deploy', projectDir: 'd:\\recall-proj' });
    expect(res.ok).toBe(true);
    expect(res.scope.archivesIndexed).toBeGreaterThanOrEqual(1); // lazily indexed
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].eventId).toBeTruthy();
    expect(res.toc).toBeDefined();
    // The snippet must not leak the pasted secret.
    expect(JSON.stringify(res.hits)).not.toContain(SECRET);
  });

  it('returns empty hits with guidance when nothing matches', async () => {
    const res = recallQuery({ query: 'zzz-nonexistent-term', projectDir: 'd:\\recall-proj' });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBe(0);
    expect(res.guidance).toContain('No lexical matches');
  });
});

describe('recallExpand — Phase 2 (exact masked lines + provenance)', () => {
  it('the full two-call loop: a hit expands to its masked source line', async () => {
    const q = recallQuery({ query: 'E404', projectDir: 'd:\\recall-proj' });
    const hit = q.hits[0];

    const ex = recallExpand({ eventId: hit.eventId });
    expect(ex.ok).toBe(true);
    expect(ex.text).toContain('E404');
    expect(ex.text).not.toContain(SECRET);                  // masked on expansion
    expect(ex.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
    expect(ex.provenance).toContain('session R1');
    expect(ex.disclaimer).toContain('HISTORICAL TRANSCRIPT DATA');
  });

  it('expands by segment_index and by seq range', async () => {
    const arch = getArchive('R1')!;
    const bySeg = recallExpand({ archiveId: arch.id, segmentIndex: 0 });
    expect(bySeg.ok).toBe(true);
    expect(bySeg.text).toContain('E404');

    const byRange = recallExpand({ sourceSessionId: 'R1', fromSeq: 0, toSeq: 5 });
    expect(byRange.ok).toBe(true);
    expect(byRange.text).toContain('npm login');
  });

  it('reports a clear reason when the target is under-specified or missing', () => {
    expect(recallExpand({}).ok).toBe(false);
    expect(recallExpand({ archiveId: 'nope', fromSeq: 0 }).ok).toBe(false);
  });
});
