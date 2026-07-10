import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Bind an isolated on-disk DB BEFORE importing the memory/statusline layers — DB_PATH is
// captured at module-eval time, and readStatuslineData opens its own read-only handle to
// that same path, so both must resolve the env before the dynamic import.
const TEST_DB = join(tmpdir(), `veto-council-scope-${Date.now()}.db`);
process.env.VETO_TEST_DB = TEST_DB;

const { saveCouncilOutcome, saveSession, resetDb, getDb } = await import('../../src/memory/local.js');
const { readStatuslineData } = await import('../../src/cli/statusline.js');

afterAll(() => {
  resetDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TEST_DB;
});

function outcome(verdict: string, project_dir?: string) {
  return saveCouncilOutcome({
    task: `task for ${project_dir ?? 'global'}`,
    verdict,
    lead_dev: '{}', pm: '{}', architect: '{}', ux: '{}', devil: '{}', legal: '{}', security: '{}',
    recommended: '', project_dir,
  });
}

describe('council verdict is scoped to the current project', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM council_outcomes');
  });

  it('persists project_dir with the drive letter normalized', () => {
    outcome('GREEN', 'D:\\veto-vscode');
    const row = getDb().prepare('SELECT project_dir FROM council_outcomes LIMIT 1').get() as { project_dir: string };
    expect(row.project_dir).toBe('d:\\veto-vscode');
  });

  it('returns the verdict for the requested workspace, not the globally-newest one', () => {
    outcome('RED', 'd:\\sales-support-automation'); // older, different project
    outcome('YELLOW', 'd:\\veto-vscode');           // newest overall
    // Ask for the sales project → must get ITS verdict, not the newer veto-vscode one.
    expect(readStatuslineData('d:\\sales-support-automation').verdict).toBe('RED');
    // Case-insensitive drive letter still matches (normalizeProjectDir).
    expect(readStatuslineData('D:\\veto-vscode').verdict).toBe('YELLOW');
  });

  it('drops the verdict (no cross-project fallback) when the workspace has no debate', () => {
    outcome('GREEN', 'd:\\some-other-project');
    expect(readStatuslineData('d:\\veto-vscode').verdict).toBeNull();
  });

  it('falls back to the global newest verdict when no workspace is provided', () => {
    outcome('RED', 'd:\\a');
    outcome('GREEN', 'd:\\b'); // newest
    expect(readStatuslineData().verdict).toBe('GREEN');
  });

  it('backfills project_dir from the linked session on migration', () => {
    // Simulate a legacy row: a session carries the project, the council row does not.
    const { session_id: sid } = saveSession({ platform: 'claude', project_dir: 'D:\\legacy-proj', summary: 's' });
    const cid = outcome('YELLOW'); // no project_dir
    getDb().prepare('UPDATE council_outcomes SET session_id = ?, project_dir = NULL WHERE id = ?').run(sid, cid);
    // Re-run the migration by reopening the DB.
    resetDb();
    const row = getDb().prepare('SELECT project_dir FROM council_outcomes WHERE id = ?').get(cid) as { project_dir: string | null };
    expect(row.project_dir).toBe('d:\\legacy-proj');
  });
});
