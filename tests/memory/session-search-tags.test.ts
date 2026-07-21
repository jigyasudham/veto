import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolated on-disk DB (reopen-safe) bound before importing the memory layer.
const TEST_DB = join(tmpdir(), `veto-search-tags-${Date.now()}-${process.pid}.db`);
process.env.VETO_TEST_DB = TEST_DB;

const { saveSession, updateSession, listSessions, resetDb } = await import('../../src/memory/local.js');

afterAll(() => {
  resetDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TEST_DB;
});

describe('updateSession — tags are updated in place (regression)', () => {
  it('overwrites tags when provided on an in-place update', () => {
    const { session_id } = saveSession({ summary: 'first', platform: 'claude', tags: ['old-a', 'old-b'] });
    updateSession(session_id, { summary: 'updated', platform: 'claude', tags: ['new-x', 'new-y'] });

    const [row] = listSessions(5, 'new-x');
    expect(row).toBeDefined();
    expect(JSON.parse(row.tags ?? '[]')).toEqual(['new-x', 'new-y']);
    // The old tags are gone.
    expect(listSessions(5, 'old-a').length).toBe(0);
  });

  it('keeps existing tags when an update omits them (no accidental wipe)', () => {
    const { session_id } = saveSession({ summary: 'keeps tags', platform: 'claude', tags: ['keep-me'] });
    updateSession(session_id, { summary: 'changed body only', platform: 'claude' }); // no tags
    const [row] = listSessions(5, 'keep-me');
    expect(row).toBeDefined();
    expect(JSON.parse(row.tags ?? '[]')).toEqual(['keep-me']);
  });
});

describe('listSessions — multi-word search (regression)', () => {
  it('matches when all terms are present but not contiguous', () => {
    saveSession({
      summary: 'v3.0 transcript capture built in an isolated worktree, value gate passed',
      platform: 'claude',
    });
    // The exact phrase never appears, but every term is present.
    const hits = listSessions(10, 'transcript capture value gate worktree');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('requires every term to appear somewhere (AND semantics)', () => {
    saveSession({ summary: 'only auth here, nothing about payments', platform: 'claude' });
    expect(listSessions(10, 'auth').length).toBeGreaterThanOrEqual(1);
    // "auth" present but "payments-missing-term" is not → excluded.
    expect(listSessions(10, 'auth zzzznotpresent').length).toBe(0);
  });

  it('matches a term across different columns (summary vs project_dir vs tags)', () => {
    saveSession({ summary: 'body text', platform: 'claude', project_dir: 'd:\\special-proj', tags: ['releasable'] });
    // term1 in project_dir, term2 in tags.
    const hits = listSessions(10, 'special-proj releasable');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('still returns recent sessions when no query is given', () => {
    expect(listSessions(3).length).toBeGreaterThan(0);
  });
});
