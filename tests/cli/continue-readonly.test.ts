// Codex's default sandbox lets a command write only inside the workspace. There,
// SQLite opens ~/.veto/veto.db read-only, getDb()'s first write fails, and
// `veto continue` — the command the fallback skill sends Codex to — died with
// "attempt to write a readonly database" (found 2026-09-27). A read-only file
// reproduces the same condition on every OS.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'veto-readonly-'));
const DB = join(DIR, 'veto.db');
process.env.VETO_TEST_DB = DB;

const local = await import('../../src/memory/local.js');
const { runContinueCommand, READ_ONLY_NOTE } = await import('../../src/cli/continue.js');

const id = local.saveSession({
  platform: 'claude', summary: 'restore me in a sandbox', context: 'ctx',
  task_state: JSON.stringify({ nextAction: 'finish the fix' }),
}).session_id;
local.resetDb();
chmodSync(DB, 0o444);

// On Linux SQLite creates the -wal/-shm sidecars with the database file's mode,
// so restoring write access has to cover them too.
const makeWritable = () => { for (const p of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(p)) chmodSync(p, 0o644); };

afterAll(() => {
  local.resetDb();
  try { makeWritable(); } catch { /* ignore */ }
  rmSync(DIR, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    stdout += String(chunk);
    const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    return { code: await runContinueCommand(argv), stdout };
  } finally {
    spy.mockRestore();
  }
}

describe('a database that cannot be written', () => {
  it('is reported as a blocked write, and getDb does not keep the half-opened connection', () => {
    let first: unknown;
    try { local.getDb(); } catch (err) { first = err; }
    expect(local.isWriteBlocked(first)).toBe(true);
    // The same failure again — not a connection whose migrations never ran.
    expect(() => local.getDb()).toThrow();
  });

  it('still restores the session through veto continue, and says what it skipped', async () => {
    const { code, stdout } = await run([id.slice(0, 8), '--as', 'codex', '--json']);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({
      session_id: id, saved_by: 'claude', summary: 'restore me in a sandbox',
      next_action: 'finish the fix', read_only: true, note: READ_ONLY_NOTE,
    });
  });

  it('wrote nothing: the resume is not recorded', () => {
    local.resetDb();
    makeWritable();
    const row = local.getDb().prepare('SELECT active_client, last_resumed_at FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ active_client: null, last_resumed_at: null });
  });
});

describe('isWriteBlocked', () => {
  it('tells a blocked write from other failures', () => {
    expect(local.isWriteBlocked(new Error('attempt to write a readonly database'))).toBe(true);
    expect(local.isWriteBlocked(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true);
    expect(local.isWriteBlocked(new Error('no such table: sessions'))).toBe(false);
  });
});
