import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

// Retention (council a9ac51e4): the consent text promised archives older than
// the window are pruned automatically, and that it can be changed or turned off.

const ROOT = join(tmpdir(), `veto-retention-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { expiredArchives, pruneExpiredArchives, oldestArchiveAt, isArchiveFile, purgeAll } = await import('../../src/transcripts/manage.js');
const { getTranscriptsDb, resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const { pruneOnSave } = await import('../../src/transcripts/on-save.js');
const { enableCapture, disableCapture, captureStatus, consentText } = await import('../../src/transcripts/config.js');
const { getConfig, setConfig } = await import('../../src/memory/config.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2027-06-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

async function seed(sessionId: string, lastCapturedDaysAgo: number) {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'user', uuid: `${sessionId}-0`, sessionId, message: { role: 'user', content: `hello from ${sessionId}` } }) + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: 'd:\\retention' });
  await captureSession({ sourceSessionId: sessionId });
  ingestSession(sessionId);
  getTranscriptsDb().prepare('UPDATE archives SET updated_at = ? WHERE source_session_id = ?').run(daysAgo(lastCapturedDaysAgo), sessionId);
  return getArchive(sessionId)!;
}

function orphans() {
  const db = getTranscriptsDb();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    events: n(`SELECT COUNT(*) n FROM events WHERE archive_id NOT IN (SELECT id FROM archives)`),
    docs: n(`SELECT COUNT(*) n FROM search_docs WHERE archive_id NOT IN (SELECT id FROM archives)`),
    postings: n(`SELECT COUNT(*) n FROM search_postings WHERE doc_id NOT IN (SELECT id FROM search_docs)`),
  };
}

const ids = () => (getTranscriptsDb().prepare('SELECT source_session_id s FROM archives ORDER BY s').all() as Array<{ s: string }>).map(r => r.s);

beforeEach(() => { purgeAll(); });
afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('pruneExpiredArchives', () => {
  it('deletes only archives last captured before the window, with no orphans and no L0 file left', async () => {
    const old = await seed('OLD', 200);
    await seed('EDGE', 179);
    await seed('NEW', 3);
    expect(expiredArchives(180, NOW).map(a => a.source_session_id)).toEqual(['OLD']);
    const r = pruneExpiredArchives(180, NOW);
    expect(r.archives).toBe(1);
    expect(r.files).toBe(1);
    expect(existsSync(old.archive_path)).toBe(false);
    expect(ids()).toEqual(['EDGE', 'NEW']);
    expect(orphans()).toEqual({ events: 0, docs: 0, postings: 0 });
  });

  it('deletes nothing when retention is off', async () => {
    await seed('ANCIENT', 2000);
    expect(expiredArchives(0, NOW)).toEqual([]);
    expect(pruneExpiredArchives(0, NOW).archives).toBe(0);
    expect(ids()).toEqual(['ANCIENT']);
  });

  it('skips the whole pass when an archive is dated after now (the clock is not to be trusted)', async () => {
    await seed('OLD', 400);
    await seed('FUTURE', -30);
    const r = pruneExpiredArchives(180, NOW);
    expect(r.skipped).toBe('clock_behind');
    expect(r.archives).toBe(0);
    expect(ids()).toEqual(['FUTURE', 'OLD']);
  });

  it('removes the row but never a file outside an archives folder', async () => {
    const outside = join(ROOT, 'not-an-archive.txt');
    writeFileSync(outside, 'keep me');
    await seed('TAMPERED', 300);
    getTranscriptsDb().prepare('UPDATE archives SET archive_path = ? WHERE source_session_id = ?').run(outside, 'TAMPERED');
    expect(pruneExpiredArchives(180, NOW).archives).toBe(1);
    expect(existsSync(outside)).toBe(true);
    expect(ids()).toEqual([]);
  });

  it('reports when the least recently captured archive was captured', async () => {
    expect(oldestArchiveAt()).toBeNull();
    await seed('A', 10);
    await seed('B', 40);
    expect(oldestArchiveAt()).toBe(daysAgo(40));
  });
});

describe('isArchiveFile', () => {
  it('accepts only <source>__<id>.gz inside an archives folder', () => {
    expect(isArchiveFile(join(ROOT, 'archives', 'claude__abc-123.gz'))).toBe(true);
    expect(isArchiveFile(join(ROOT, 'elsewhere', 'claude__abc-123.gz'))).toBe(false);
    expect(isArchiveFile(join(ROOT, 'archives', 'index.db'))).toBe(false);
    expect(isArchiveFile(join(ROOT, 'archives', '..', 'claude__x.gz'))).toBe(false);
  });
});

describe('pruneOnSave', () => {
  it('prunes with capture off, because archives kept after disable are covered too', async () => {
    enableCapture();
    disableCapture();
    await seed('OLD', 200);
    await seed('NEW', 1);
    expect(await pruneOnSave(NOW)).toBe(1);
    expect(ids()).toEqual(['NEW']);
  });

  it('does nothing when retention is off', async () => {
    setConfig({ transcripts: { ...getConfig().transcripts, retention_days: 0 } });
    await seed('OLD', 900);
    expect(await pruneOnSave(NOW)).toBe(0);
    expect(ids()).toEqual(['OLD']);
  });

  it('never creates a transcripts store for someone who never had one', async () => {
    const missing = join(ROOT, 'never', 'index.db');
    process.env.VETO_TRANSCRIPTS_DB = missing;
    try {
      expect(await pruneOnSave(NOW)).toBe(0);
      expect(existsSync(missing)).toBe(false);
    } finally {
      delete process.env.VETO_TRANSCRIPTS_DB;
    }
  });
});

describe('retention setting', () => {
  it('keeps 0 as off instead of resetting it to 180, including across enable', () => {
    setConfig({ transcripts: { ...getConfig().transcripts, retention_days: 0 } });
    expect(getConfig().transcripts.retention_days).toBe(0);
    expect(enableCapture().retention_days).toBe(0);
    expect(captureStatus().retention_days).toBe(0);
  });

  it('falls back to 180 for a value that is not a whole number of days', () => {
    setConfig({ transcripts: { ...getConfig().transcripts, retention_days: -5 } });
    expect(getConfig().transcripts.retention_days).toBe(180);
    setConfig({ transcripts: { ...getConfig().transcripts, retention_days: 1.5 } });
    expect(getConfig().transcripts.retention_days).toBe(180);
  });

  it('the consent text names the command, and says plainly when retention is off', () => {
    expect(consentText('/x', 180)).toMatch(/older than 180 days are pruned automatically/);
    expect(consentText('/x', 180)).toMatch(/veto transcripts retention <days>\|off/);
    expect(consentText('/x', 0)).toMatch(/RETENTION: off\. Archives are kept until you purge them/);
  });
});
