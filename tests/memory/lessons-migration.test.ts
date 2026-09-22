import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// On disk, not :memory:, so resetDb() reopens the same file and the migrations
// run over a database in the shape 3.4.0 left it. Bound before importing the
// memory layer: DB_PATH is captured at module-eval time.
const TEST_DB = join(tmpdir(), `veto-lessons-migration-${Date.now()}-${process.pid}.db`);
process.env.VETO_TEST_DB = TEST_DB;

const { getDb, resetDb } = await import('../../src/memory/local.js');
const { explainLesson } = await import('../../src/lessons/manage.js');

afterAll(() => {
  resetDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TEST_DB;
});

const columns = (table: string) => (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

describe('upgrading a 3.4.0 database', () => {
  it('adds the scope reason and the forget/exclude tables, keeping existing rows', () => {
    const db = getDb();
    // The lessons table exactly as 3.4.0 shipped it, with no forget or exclude tables yet.
    db.exec(`
      DROP TABLE lessons;
      DROP TABLE lesson_tombstones;
      DROP TABLE lesson_project_exclusions;
      CREATE TABLE lessons (
        id TEXT PRIMARY KEY, source_cli TEXT NOT NULL, source_path TEXT NOT NULL, section_anchor TEXT NOT NULL,
        project_identity TEXT NOT NULL, project_label TEXT, scope TEXT NOT NULL DEFAULT 'project', kind TEXT NOT NULL DEFAULT 'note',
        text_masked TEXT NOT NULL, source_hash TEXT NOT NULL, source_mtime TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_cli, source_path, section_anchor)
      );
    `);
    db.prepare(`INSERT INTO lessons (id, source_cli, source_path, section_anchor, project_identity, project_label, scope, kind, text_masked,
      source_hash, source_mtime, created_at, updated_at) VALUES ('old-row', 'claude', '/m/feedback_x.md', 'body', 'git:abc', 'demo', 'user', 'feedback',
      'Keep diffs small', 'h', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`).run();
    expect(columns('lessons')).not.toContain('scope_reason');

    resetDb();

    expect(columns('lessons')).toContain('scope_reason');
    expect(columns('lesson_tombstones')).toContain('forget_id');
    expect(columns('lesson_project_exclusions')).toContain('project_identity');
    const row = getDb().prepare("SELECT * FROM lessons WHERE id = 'old-row'").get() as Parameters<typeof explainLesson>[0];
    expect(row.scope_reason).toBeNull();
    expect(explainLesson(row).scope).toBe('user: classified before Veto recorded why');
  });
});

describe('upgrading a 3.5.0 database', () => {
  const tables = () => new Set((getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name));
  const shadowLog = `CREATE TABLE IF NOT EXISTS lesson_shadow_log (
    id TEXT PRIMARY KEY, query TEXT NOT NULL, target_project_identity TEXT NOT NULL, target_host TEXT NOT NULL,
    lesson_ids TEXT NOT NULL, estimated_tokens INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`;

  it('drops the empty shadow log, whose query column could have held a prompt, and adds the trial table', () => {
    getDb().exec(shadowLog);
    resetDb();
    expect(tables().has('lesson_shadow_log')).toBe(false);
    expect(columns('lesson_trial_sessions')).toEqual(expect.arrayContaining(['source_session_id', 'outcome', 'lesson_ids', 'archive_state']));
    expect(columns('lesson_trial_sessions')).not.toContain('query');
  });

  it('never drops a shadow log that holds rows: `veto lessons off` empties it instead', async () => {
    getDb().exec(shadowLog);
    getDb().prepare(`INSERT INTO lesson_shadow_log VALUES ('x', 'a prompt', 'git:a', 'claude', '[]', 0, 'no_match', '2026-09-20T00:00:00.000Z')`).run();
    resetDb();
    expect(tables().has('lesson_shadow_log')).toBe(true);

    const { turnLessonsOff } = await import('../../src/lessons/manage.js');
    expect(turnLessonsOff()).toMatchObject({ trialSessions: 1, remaining: 0 });
    resetDb();
    expect(tables().has('lesson_shadow_log')).toBe(false);
  });
});
