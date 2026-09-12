import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolated on-disk DB (not :memory:) so resetDb() reopens the same file and the
// migrations re-run over rows already in it. Bound before importing the memory
// layer — DB_PATH is captured at module-eval time.
const TEST_DB = join(tmpdir(), `veto-saved-at-${Date.now()}-${process.pid}.db`);
process.env.VETO_TEST_DB = TEST_DB;

const { saveSession, updateSession, listSessions, getMetrics, resetDb, getDb } =
  await import('../../src/memory/local.js');
const { continueSession } = await import('../../src/adapters/index.js');
const { sessionHandlers } = await import('../../src/server/handlers/session.js');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The real UTC date. Tests that pin the fake clock to it keep the pre-fix code
// honest: its created_at came from SQLite's own clock, which fake timers cannot
// move, so both formats land on the same day — the only case the mix sorts wrong.
const TODAY = new Date().toISOString().slice(0, 10);

// Fake only Date, so node:sqlite and real timers are untouched.
function at(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function createdAt(id: string): string {
  return (getDb().prepare('SELECT created_at FROM sessions WHERE id = ?').get(id) as { created_at: string }).created_at;
}

afterEach(() => vi.useRealTimers());

afterAll(() => {
  resetDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TEST_DB;
});

describe('a restored session reports when it was last saved, not when it started', () => {
  // The shape that surfaced this: saved once, updated in place 18 days later,
  // then resumed — and the resume message showed the first save's time.
  function savedThenUpdated(): string {
    at('2026-08-22T14:07:00.000Z');
    const { session_id } = saveSession({ summary: 'first save', platform: 'claude' });
    at('2026-09-09T16:40:00.000Z');
    updateSession(session_id, { summary: 'second save', platform: 'claude' });
    return session_id;
  }

  it('veto_continue', () => {
    const res = continueSession(savedThenUpdated());
    expect(res.message).toContain('(saved 2026-09-09T16:40)');
    expect(res.message).not.toContain('2026-08-22');
  });

  it('veto_session_restore', async () => {
    const session_id = savedThenUpdated();
    const out = await sessionHandlers.veto_session_restore({ args: { session_id }, request: {}, server: null });
    expect(JSON.parse(out.content[0].text).saved_at).toBe('2026-09-09T16:40:00.000Z');
  });
});

describe('created_at is stored in one format', () => {
  it('a new session writes it as ISO, the same instant as started_at', () => {
    const { session_id, saved_at } = saveSession({ summary: 'fresh', platform: 'claude' });
    const row = getDb().prepare('SELECT started_at, created_at FROM sessions WHERE id = ?')
      .get(session_id) as { started_at: string; created_at: string };
    expect(row.created_at).toMatch(ISO);
    expect(row.created_at).toBe(row.started_at);
    expect(row.created_at).toBe(saved_at);
  });

  it('a session first saved late in the day outranks one updated earlier that day', () => {
    getDb().exec('DELETE FROM sessions');
    at(`${TODAY}T00:00:01.000Z`);
    const earlier = saveSession({ summary: 'earlier', platform: 'claude' }).session_id;
    at(`${TODAY}T00:00:02.000Z`);
    updateSession(earlier, { summary: 'earlier, updated', platform: 'claude' });
    at(`${TODAY}T00:00:03.000Z`);
    const later = saveSession({ summary: 'later', platform: 'claude' }).session_id;

    expect(listSessions(2).map(s => s.id)).toEqual([later, earlier]);
    // veto_continue with no id restores the most recent session.
    expect(continueSession().session_id).toBe(later);
  });

  it("veto_metrics counts a session first saved today in today's total", () => {
    getDb().exec('DELETE FROM sessions');
    at(`${TODAY}T12:00:00.000Z`);
    saveSession({ summary: 'saved today, never updated', platform: 'claude' });
    expect(getMetrics().sessions.today).toBe(1);
  });
});

describe('migrateSessionCreatedAtIso (existing rows)', () => {
  it('rewrites legacy SQLite-format values to ISO and leaves everything else alone', () => {
    const insert = getDb().prepare(
      `INSERT INTO sessions (id, started_at, platform, connection_type, created_at) VALUES (?, ?, 'claude', 'subscription', ?)`
    );
    insert.run('legacy-sqlite-format', '2026-08-22T14:07:00.000Z', '2026-08-22 14:07:00');
    insert.run('already-iso', '2026-08-23T09:15:42.123Z', '2026-08-23T09:15:42.123Z');
    insert.run('right-shape-bad-date', '2026-08-24T00:00:00.000Z', '2026-13-45 99:99:99');
    insert.run('not-a-date', '2026-08-25T00:00:00.000Z', 'not-a-date');

    // Reopening the same file re-runs migrations over existing data. It must not
    // throw on a value strftime cannot parse: this runs on every server boot.
    resetDb();
    expect(() => getDb()).not.toThrow();

    expect(createdAt('legacy-sqlite-format')).toBe('2026-08-22T14:07:00.000Z');
    expect(createdAt('already-iso')).toBe('2026-08-23T09:15:42.123Z');
    expect(createdAt('right-shape-bad-date')).toBe('2026-13-45 99:99:99');
    expect(createdAt('not-a-date')).toBe('not-a-date');

    // Idempotent: a second reopen changes nothing.
    resetDb();
    expect(createdAt('legacy-sqlite-format')).toBe('2026-08-22T14:07:00.000Z');
  });
});
