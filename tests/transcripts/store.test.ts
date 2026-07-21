import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolate the sidecar DB to a real temp file BEFORE importing the store — the
// path is read per-call but a real file (not :memory:) lets us exercise WAL and
// reopen to prove migration idempotency.
const TEST_DB = join(tmpdir(), `veto-transcripts-${Date.now()}-${process.pid}.db`);
process.env.VETO_TRANSCRIPTS_DB = TEST_DB;

const {
  getTranscriptsDb,
  resetTranscriptsDb,
  runMigrations,
  schemaVersion,
  transcriptsDbPath,
  archiveDir,
  transcriptsRoot,
  transcriptsAvailable,
  TRANSCRIPTS_SCHEMA_VERSION,
} = await import('../../src/transcripts/store.js');

function tableNames(db: ReturnType<typeof getTranscriptsDb>): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
    .map(r => r.name);
}

afterAll(() => {
  resetTranscriptsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TRANSCRIPTS_DB;
});

describe('transcripts sidecar DB — foundation', () => {
  it('is available on this runtime (node:sqlite present)', () => {
    expect(transcriptsAvailable()).toBe(true);
  });

  it('honors the VETO_TRANSCRIPTS_DB override', () => {
    expect(transcriptsDbPath()).toBe(TEST_DB);
  });

  it('opens at the current schema version with the foundation tables', () => {
    const db = getTranscriptsDb();
    expect(schemaVersion(db)).toBe(TRANSCRIPTS_SCHEMA_VERSION);
    expect(schemaVersion(db)).toBe(3);
    const tables = tableNames(db);
    expect(tables).toContain('archives');
    expect(tables).toContain('session_map');
    expect(tables).toContain('events');
    expect(tables).toContain('events_fts');
  });

  it('runs in WAL with a busy_timeout (so the HUD can read veto.db uncontended)', () => {
    const db = getTranscriptsDb();
    const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    expect(mode.toLowerCase()).toBe('wal');
    const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    expect(busy).toBe(5000);
  });

  it('foundation tables accept round-trip rows', () => {
    const db = getTranscriptsDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO archives (id, source, source_session_id, project_dir, archive_path, content_sha256, captured_at, updated_at)
       VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)`
    ).run('a1', 'sess-1', 'd:\\veto', '/tmp/a1.gz', 'deadbeef', now, now);
    db.prepare(
      `INSERT INTO session_map (source, source_session_id, transcript_path, project_dir, last_seen_at)
       VALUES ('claude', ?, ?, ?, ?)`
    ).run('sess-1', '/home/me/.claude/projects/x/sess-1.jsonl', 'd:\\veto', now);

    const arch = db.prepare(`SELECT source_session_id, indexed_through_seq FROM archives WHERE id='a1'`).get() as { source_session_id: string; indexed_through_seq: number };
    expect(arch.source_session_id).toBe('sess-1');
    expect(arch.indexed_through_seq).toBe(0); // default watermark
    const map = db.prepare(`SELECT transcript_path FROM session_map WHERE source_session_id='sess-1'`).get() as { transcript_path: string };
    expect(map.transcript_path).toContain('sess-1.jsonl');
  });

  it('enforces UNIQUE(source, source_session_id) on archives', () => {
    const db = getTranscriptsDb();
    const now = new Date().toISOString();
    const insertDup = () => db.prepare(
      `INSERT INTO archives (id, source, source_session_id, archive_path, content_sha256, captured_at, updated_at)
       VALUES (?, 'claude', 'sess-1', '/tmp/dup.gz', 'x', ?, ?)`
    ).run('a2', now, now);
    expect(insertDup).toThrow(); // sess-1 already archived above
  });
});

describe('additive migrations are idempotent', () => {
  it('re-running runMigrations is a no-op and never throws', () => {
    const db = getTranscriptsDb();
    const before = schemaVersion(db);
    expect(runMigrations(db)).toBe(before);
    expect(runMigrations(db)).toBe(before); // twice, still fine
    expect(schemaVersion(db)).toBe(TRANSCRIPTS_SCHEMA_VERSION);
  });

  it('reopening the DB re-applies nothing (version persisted, data intact)', () => {
    resetTranscriptsDb();
    const db = getTranscriptsDb();
    expect(schemaVersion(db)).toBe(TRANSCRIPTS_SCHEMA_VERSION);
    // Row inserted in the earlier suite survived the reopen.
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM archives`).get() as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('path resolution', () => {
  it('derives archiveDir under the transcripts root', () => {
    const root = transcriptsRoot().replace(/\\/g, '/');
    const arch = archiveDir().replace(/\\/g, '/');
    expect(arch).toBe(`${root}/archives`);
  });
});
