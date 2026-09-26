import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { hostStartsPath, PROBE_CLIENT, readHostStarts, recordHostStart, startsForHost } from '../src/host-starts.js';

const roots: string[] = [];
const ledger = () => { const r = mkdtempSync(join(tmpdir(), 'veto-starts-')); roots.push(r); return join(r, 'host-starts.json'); };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('host-start ledger', () => {
  it('records who started Veto, with which Node, and whether SQLite loaded', () => {
    const path = ledger();
    recordHostStart({ client: 'claude-code', client_version: '2.1.0', platform: 'claude', veto_version: '3.7.0', sqlite_ok: true }, { path, now: new Date('2026-09-26T10:00:00Z') });
    recordHostStart({ client: 'claude-code', client_version: '2.1.1', platform: 'claude', veto_version: '3.7.0', sqlite_ok: false }, { path, now: new Date('2026-09-26T11:00:00Z') });
    const [s] = readHostStarts(path);
    expect(s).toMatchObject({ client: 'claude-code', client_version: '2.1.1', starts: 2, sqlite_ok: false, first_seen: '2026-09-26T10:00:00.000Z', last_seen: '2026-09-26T11:00:00.000Z', node_version: process.version });
  });

  it("does not count doctor's own launch test as a host start", () => {
    const path = ledger();
    recordHostStart({ client: PROBE_CLIENT, veto_version: '3.7.0', sqlite_ok: true }, { path });
    expect(readHostStarts(path)).toEqual([]);
  });

  it('survives a damaged ledger and never throws', () => {
    const path = ledger();
    writeFileSync(path, '{not json');
    expect(readHostStarts(path)).toEqual([]);
    expect(() => recordHostStart({ client: 'codex-mcp-client', veto_version: '3.7.0', sqlite_ok: true }, { path })).not.toThrow();
    expect(readHostStarts(path)).toHaveLength(1);
    expect(() => recordHostStart({ client: 'x', veto_version: '1', sqlite_ok: true }, { path: join(path, 'nested', 'impossible\0') })).not.toThrow();
  });

  it('stays bounded', () => {
    const path = ledger();
    for (let i = 0; i < 40; i++) recordHostStart({ client: `client-${i}`, veto_version: '3.7.0', sqlite_ok: true }, { path, now: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    const kept = readHostStarts(path);
    expect(kept).toHaveLength(32);
    expect(kept.some(s => s.client === 'client-39')).toBe(true);
    expect(kept.some(s => s.client === 'client-0')).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  it('is never written by tests unless a path is named', () => {
    expect(hostStartsPath({ VETO_TEST_DB: ':memory:' })).toBeNull();
    expect(hostStartsPath({ VETO_TEST_DB: ':memory:', VETO_HOST_STARTS_PATH: '/x.json' })).toBe('/x.json');
  });
});

describe('startsForHost', () => {
  const s = (client: string) => ({ client, client_version: null, platform: null, veto_version: '3.7.0', node_version: 'v24', sqlite_ok: true, exec_path: 'node', first_seen: '', last_seen: '', starts: 1 });
  it('matches hosts by marker, and never files Antigravity under Gemini CLI', () => {
    const all = [s('claude-code'), s('codex-mcp-client'), s('antigravity'), s('gemini-cli-mcp-client')];
    expect(startsForHost('claude', all).map(x => x.client)).toEqual(['claude-code']);
    expect(startsForHost('antigravity', all).map(x => x.client)).toEqual(['antigravity']);
    expect(startsForHost('gemini', [...all, s('antigravity-gemini')]).map(x => x.client)).toEqual(['gemini-cli-mcp-client']);
  });
});
