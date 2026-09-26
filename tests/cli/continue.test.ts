import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, listSessions, resolveSessionId, saveSession, countSessions } from '../../src/memory/local.js';
import { continueSession } from '../../src/adapters/index.js';
import { parseContinueArgs } from '../../src/cli/continue.js';

beforeEach(() => { getDb().exec('DELETE FROM sessions'); });

describe('session id prefixes', () => {
  it('resolves a unique prefix, and refuses an ambiguous or too-short one', () => {
    const a = saveSession({ platform: 'gemini', summary: 'first' }).session_id;
    const b = saveSession({ platform: 'codex', summary: 'second' }).session_id;
    expect(resolveSessionId(a)).toEqual({ kind: 'found', id: a });
    expect(resolveSessionId(a.slice(0, 8).toUpperCase())).toEqual({ kind: 'found', id: a });
    expect(resolveSessionId('abc')).toEqual({ kind: 'none' });
    expect(resolveSessionId("x' OR 1=1 --")).toEqual({ kind: 'none' });

    getDb().prepare('UPDATE sessions SET id = ? WHERE id = ?').run('abcd1111-0000-0000-0000-000000000000', a);
    getDb().prepare('UPDATE sessions SET id = ? WHERE id = ?').run('abcd2222-0000-0000-0000-000000000000', b);
    const r = resolveSessionId('abcd');
    expect(r.kind).toBe('ambiguous');
  });

  it('lets veto_continue restore from the 8-character prefix listings show', () => {
    const id = saveSession({ platform: 'gemini', summary: 'restore me' }).session_id;
    const r = continueSession(id.slice(0, 8), 'antigravity');
    expect(r).toMatchObject({ found: true, session_id: id, summary: 'restore me', active_client: 'antigravity' });
  });

  it('finds a session by id prefix through the ordinary search', () => {
    const id = saveSession({ platform: 'claude', summary: 'x' }).session_id;
    saveSession({ platform: 'claude', summary: 'y' });
    expect(listSessions(10, id.slice(0, 8)).map(s => s.id)).toEqual([id]);
    expect(countSessions()).toBe(2);
  });
});

describe('veto continue arguments', () => {
  it('parses id, --as and --json', () => {
    expect(parseContinueArgs(['eaca51c0', '--as', 'Antigravity', '--json'])).toEqual({ id: 'eaca51c0', as: 'antigravity', json: true });
    expect(parseContinueArgs(['--as=codex'])).toEqual({ as: 'codex', json: false });
  });

  it('rejects an unknown client or option', () => {
    expect(parseContinueArgs(['x', '--as', 'chatgpt']).error).toMatch(/--as must be one of/);
    expect(parseContinueArgs(['x', '--force']).error).toMatch(/Unknown option --force/);
  });
});
