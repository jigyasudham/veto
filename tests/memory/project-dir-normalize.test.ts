import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Bind an isolated on-disk DB BEFORE importing the memory layer — DB_PATH is
// captured at module-eval time, so the env must be set before the dynamic
// import resolves. A real file (not :memory:) lets us reopen to re-run migrations.
const TEST_DB = join(tmpdir(), `veto-normalize-${Date.now()}.db`);
process.env.VETO_TEST_DB = TEST_DB;

const { normalizeProjectDir, saveSession, storeKnowledge, searchKnowledge, listSessions, resetDb, getDb } =
  await import('../../src/memory/local.js');

afterAll(() => {
  resetDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TEST_DB;
});

describe('normalizeProjectDir', () => {
  it('lowercases a Windows drive letter', () => {
    expect(normalizeProjectDir('D:\\sales-support-automation')).toBe('d:\\sales-support-automation');
    expect(normalizeProjectDir('C:\\Users\\me\\Project')).toBe('c:\\Users\\me\\Project');
  });

  it('preserves the rest of the path case (only the drive letter changes)', () => {
    expect(normalizeProjectDir('D:\\Veto')).toBe('d:\\Veto');
  });

  it('is idempotent on an already-lowercase drive', () => {
    expect(normalizeProjectDir('d:\\Veto')).toBe('d:\\Veto');
  });

  it('leaves posix paths and empty values untouched', () => {
    expect(normalizeProjectDir('/home/me/project')).toBe('/home/me/project');
    expect(normalizeProjectDir(undefined)).toBeUndefined();
    expect(normalizeProjectDir(null)).toBeNull();
  });
});

describe('project_dir canonicalization on write (matches VS Code fsPath)', () => {
  it('stores sessions with a lowercase drive letter regardless of caller case', () => {
    saveSession({ project_dir: 'D:\\sales-support-automation', summary: 'unit-test session' });
    const found = listSessions(20).filter(s => s.project_dir === 'd:\\sales-support-automation');
    expect(found.length).toBeGreaterThan(0);
  });

  it('knowledge is queryable via the lowercase-drive path the extension uses', () => {
    storeKnowledge({ title: 'kn', content: 'c', project_dir: 'D:\\sales-support-automation' });
    const hits = searchKnowledge({ project_dir: 'd:\\sales-support-automation' });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('migrateProjectDirCase (existing rows)', () => {
  it('lowercases uppercase drive letters already present in the table', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO sessions (id, started_at, platform, connection_type, project_dir) VALUES (?, ?, 'claude', 'subscription', ?)`
    ).run('legacy-uppercase-1', new Date().toISOString(), 'D:\\legacy-project');
    // Reopen the same file → migrations re-run over existing data.
    resetDb();
    const row = getDb().prepare('SELECT project_dir FROM sessions WHERE id = ?').get('legacy-uppercase-1') as { project_dir: string };
    expect(row.project_dir).toBe('d:\\legacy-project');
  });
});
