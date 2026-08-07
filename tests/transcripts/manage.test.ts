import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-manage-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping, getSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession, getEvents } = await import('../../src/transcripts/ingest.js');
const { listArchives, showArchive, purgeSession, purgeProject, purgeAll, transcriptsDiskUsage } = await import('../../src/transcripts/manage.js');
const { getTranscriptsDb, resetTranscriptsDb } = await import('../../src/transcripts/store.js');

async function seed(sessionId: string, project: string) {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'user', uuid: `${sessionId}-0`, timestamp: '2026-07-21T10:00:00.000Z', sessionId, message: { role: 'user', content: `work in ${project}` } }),
    JSON.stringify({ type: 'assistant', uuid: `${sessionId}-1`, timestamp: '2026-07-21T10:00:02.000Z', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: project });
  await captureSession({ sourceSessionId: sessionId });
  ingestSession(sessionId);
}

function orphanCounts() {
  const db = getTranscriptsDb();
  const events = (db.prepare(`SELECT COUNT(*) n FROM events WHERE archive_id NOT IN (SELECT id FROM archives)`).get() as { n: number }).n;
  const docs = (db.prepare(`SELECT COUNT(*) n FROM search_docs WHERE archive_id NOT IN (SELECT id FROM archives)`).get() as { n: number }).n;
  const postings = (db.prepare(`SELECT COUNT(*) n FROM search_postings WHERE event_id NOT IN (SELECT event_id FROM search_docs)`).get() as { n: number }).n;
  return { events, docs, postings };
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('list / show', () => {
  it('lists archived sessions and scopes by project', async () => {
    await seed('M1', 'd:\\alpha');
    await seed('M2', 'd:\\beta');
    expect(listArchives().length).toBeGreaterThanOrEqual(2);
    const alpha = listArchives({ projectDir: 'd:\\alpha' });
    expect(alpha.map(a => a.sourceSessionId)).toEqual(['M1']);
    expect(alpha[0].events).toBe(2);
  });

  it('show returns TOC + facts for a session, null for unknown', async () => {
    const d = showArchive('M1');
    expect(d).not.toBeNull();
    expect(d!.toc.length).toBeGreaterThanOrEqual(1);
    expect(d!.facts.counts.user).toBe(1);
    expect(showArchive('ghost')).toBeNull();
  });
});

describe('purge — true cascade, zero orphans', () => {
  it('purgeSession removes archive + events + index + mapping + L0 file', async () => {
    const arch = getArchive('M1')!;
    const file = arch.archive_path;
    expect(existsSync(file)).toBe(true);
    expect(getEvents(arch.id).length).toBe(2);

    const r = purgeSession('M1');
    expect(r.archives).toBe(1);
    expect(r.events).toBe(2);
    expect(r.files).toBe(1);
    expect(r.mappings).toBe(1);

    expect(getArchive('M1')).toBeNull();
    expect(getSessionMapping('M1')).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(orphanCounts()).toEqual({ events: 0, docs: 0, postings: 0 }); // nothing dangling
  });

  it('purgeAll clears everything with no orphans left', async () => {
    await seed('M3', 'd:\\alpha');
    await seed('M4', 'd:\\gamma');
    purgeAll();
    expect(listArchives().length).toBe(0);
    expect(orphanCounts()).toEqual({ events: 0, docs: 0, postings: 0 });
    const db = getTranscriptsDb();
    expect((db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) n FROM session_map`).get() as { n: number }).n).toBe(0);
  });

  it('purgeProject removes only that project', async () => {
    await seed('P1', 'd:\\one');
    await seed('P2', 'd:\\two');
    purgeProject('d:\\one');
    expect(getArchive('P1')).toBeNull();
    expect(getArchive('P2')).not.toBeNull();
    expect(orphanCounts()).toEqual({ events: 0, docs: 0, postings: 0 });
  });
});

describe('disk usage', () => {
  it('reports archive + index bytes', async () => {
    await seed('D1', 'd:\\disk');
    const du = transcriptsDiskUsage();
    expect(du.archives).toBeGreaterThanOrEqual(1);
    expect(du.archiveBytes).toBeGreaterThan(0);
    expect(du.totalBytes).toBeGreaterThanOrEqual(du.archiveBytes);
  });
});

