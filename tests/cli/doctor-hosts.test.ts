import { describe, expect, it } from 'vitest';
import { hostSpecs } from '../../src/cli/hosts.js';
import { diagnoseHost } from '../../src/cli/doctor-hosts.js';
import type { HostReport } from '../../src/cli/register.js';
import type { ProbeResult } from '../../src/cli/probe.js';
import type { HostStart } from '../../src/host-starts.js';
import { isStalled } from '../../src/transcripts/freshness.js';

const spec = (id: string) => hostSpecs('/home/u', 'linux', {}).find(s => s.id === id)!;
const report = (id: string, over: Partial<HostReport> = {}): HostReport => ({
  spec: spec(id), installed: { installed: true, via: 'path', binary: id }, state: 'enabled', source: `${id} mcp list`,
  legacyOnly: false, entry: { command: 'npx', args: [] }, note: null, ...over,
});
const probeOk: ProbeResult = { ok: true, ms: 1200, serverVersion: '3.7.0', tools: 93, error: null, hint: null };
const start = (over: Partial<HostStart> = {}): HostStart => ({
  client: 'antigravity', client_version: '1.2.2', platform: null, veto_version: '3.7.0', node_version: 'v24.1.0',
  sqlite_ok: true, exec_path: '/usr/bin/node', first_seen: '2026-09-26T10:00:00Z', last_seen: '2026-09-26T10:00:00Z', starts: 1, ...over,
});
const NOW = Date.parse('2026-09-26T12:00:00Z');

describe('diagnoseHost — a ✓ only for what the app has shown', () => {
  it('is healthy when the app lists Veto, the launch works and the app has started it', () => {
    const d = diagnoseHost(report('antigravity'), probeOk, [start()], '3.7.0', NOW);
    expect(d.level).toBe('ok');
    expect(d.details.join('\n')).toMatch(/last started by antigravity 1\.2\.2 2 h ago — Veto 3\.7\.0, Node v24\.1\.0/);
  });

  it('fails the exact 2026-09-26 case: Veto only in the file Antigravity stopped reading', () => {
    const d = diagnoseHost(report('antigravity', { state: 'missing', legacyOnly: true, source: 'agy mcp list' }), null, [], null, NOW);
    expect(d.level).toBe('fail');
    expect(d.headline).toMatch(/a file Antigravity no longer reads/);
    expect(d.fix).toMatch(/veto init/);
  });

  it('fails when the app launched Veto with a Node that cannot load node:sqlite', () => {
    const d = diagnoseHost(report('claude'), probeOk, [start({ client: 'claude-code', sqlite_ok: false, node_version: 'v22.9.0' })], null, NOW);
    expect(d.level).toBe('fail');
    expect(d.details.join('\n')).toMatch(/cannot load node:sqlite/);
  });

  it('fails a disabled entry and a failed launch test', () => {
    expect(diagnoseHost(report('antigravity', { state: 'disabled' }), null, [], null, NOW)).toMatchObject({ level: 'fail', fix: 'agy mcp enable veto' });
    const failed = diagnoseHost(report('codex'), { ...probeOk, ok: false, error: 'exited with code 1 before answering', tools: 0 }, [], null, NOW);
    expect(failed.level).toBe('fail');
  });

  it("gives Claude Code's own command when claude is not on PATH (veto init could not fix it)", () => {
    const d = diagnoseHost(report('claude', { state: 'missing', installed: { installed: true, via: 'dir', binary: null } }), null, [], null, NOW);
    expect(d.fix).toMatch(/^claude mcp add veto -s user -- npx(\.cmd)? -y --package @jigyasudham\/veto@latest veto-server/);
  });

  it('warns on a start slow enough for an app to give up', () => {
    const d = diagnoseHost(report('codex'), { ...probeOk, ms: 25_000, hint: 'started, but took 25 s' }, [], null, NOW);
    expect(d.level).toBe('warn');
  });

  it('says plainly when no start has been recorded yet', () => {
    const d = diagnoseHost(report('codex'), probeOk, [], null, NOW);
    expect(d.level).toBe('ok');
    expect(d.details.join('\n')).toMatch(/no start by Codex CLI recorded yet/);
  });
});

describe('isStalled — capture that quietly stopped', () => {
  const base = { source: 'codex' as const, captureSince: '2026-09-01T00:00:00Z' };
  it('flags a save after the newest archive when newer session files exist', () => {
    expect(isStalled({ ...base, newestArchive: '2026-09-10T00:00:00Z', lastSave: '2026-09-20T00:00:00Z', newestOnDisk: '2026-09-20T00:00:00Z' })).toBe(true);
  });
  it('does not flag when nothing newer is on disk, or the save is within the grace window', () => {
    expect(isStalled({ ...base, newestArchive: '2026-09-10T00:00:00Z', lastSave: '2026-09-20T00:00:00Z', newestOnDisk: '2026-09-09T00:00:00Z' })).toBe(false);
    expect(isStalled({ ...base, newestArchive: '2026-09-20T00:00:00Z', lastSave: '2026-09-20T01:00:00Z', newestOnDisk: '2026-09-20T01:00:00Z' })).toBe(false);
  });
  it('flags a host never archived only for saves made after capture was on', () => {
    expect(isStalled({ ...base, newestArchive: null, lastSave: '2026-08-01T00:00:00Z', newestOnDisk: '2026-09-20T00:00:00Z' })).toBe(false);
    expect(isStalled({ ...base, newestArchive: null, lastSave: '2026-09-15T00:00:00Z', newestOnDisk: '2026-09-20T00:00:00Z' })).toBe(true);
  });
});
