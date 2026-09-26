import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { hostSpecs } from '../../src/cli/hosts.js';
import { inspectHost, isWorking, registerHost, writeVetoTomlEntry, type CliRun } from '../../src/cli/register.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-register-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ok = (stdout = ''): CliRun => ({ ok: true, stdout, stderr: '', timedOut: false });
const fail = (stderr = ''): CliRun => ({ ok: false, stdout: '', stderr, timedOut: false });
const spec = (home: string, id: string) => hostSpecs(home, process.platform, {}).find(s => s.id === id)!;
const noPath = () => ({ PATH: makeRoot() });

describe('registerHost', () => {
  it("uses the host's own CLI when it is on PATH", () => {
    const home = makeRoot();
    const calls: string[][] = [];
    const out = registerHost(spec(home, 'antigravity'), { installed: true, via: 'path', binary: 'agy' }, (bin, args) => { calls.push([bin, ...args]); return ok(); });
    expect(out).toMatchObject({ status: 'registered', via: 'cli' });
    expect(calls[0].slice(0, 5)).toEqual(['agy', 'mcp', 'add', 'veto', '--']);
    // Nothing written behind the host's back.
    expect(existsSync(join(home, '.gemini', 'config', 'mcp_config.json'))).toBe(false);
  });

  it('falls back to the file Antigravity reads — never the legacy one — when agy is not on PATH', () => {
    const home = makeRoot();
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), '');
    const out = registerHost(spec(home, 'antigravity'), { installed: true, via: 'dir', binary: null });
    expect(out).toMatchObject({ status: 'registered', via: 'file' });
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers.veto).toBeTruthy();
    expect(existsSync(join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'))).toBe(false);
  });

  it('never claims Claude Code is configured by writing a file Claude Code does not read', () => {
    const home = makeRoot();
    mkdirSync(join(home, '.claude'));
    const out = registerHost(spec(home, 'claude'), { installed: true, via: 'dir', binary: null });
    expect(out.status).toBe('manual');
    if (out.status === 'manual') expect(out.instructions[0]).toMatch(/^claude mcp add veto -s user -- npx/);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('reports "already" when the host says so', () => {
    const out = registerHost(spec(makeRoot(), 'claude'), { installed: true, via: 'path', binary: 'claude' }, () => fail('MCP server veto already exists in user config'));
    expect(out).toMatchObject({ status: 'already', via: 'cli' });
  });
});

describe('inspectHost', () => {
  it('flags Veto sitting only in the file Antigravity stopped reading', () => {
    const home = makeRoot();
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'), JSON.stringify({ mcpServers: { veto: { command: 'npx' } } }));
    const r = inspectHost(spec(home, 'antigravity'), { home, env: noPath() });
    expect(r.state).toBe('missing');
    expect(r.legacyOnly).toBe(true);
    expect(isWorking(r.state)).toBe(false);
  });

  it('reports a disabled entry as not working', () => {
    const home = makeRoot();
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { veto: { command: 'npx', args: ['a'], disabled: true } } }));
    const r = inspectHost(spec(home, 'antigravity'), { home, env: noPath() });
    expect(r.state).toBe('in-file-disabled');
    expect(r.entry).toEqual({ command: 'npx', args: ['a'] });
  });

  it("trusts the host's own list over its file", () => {
    const home = makeRoot();
    const bin = makeRoot();
    writeFileSync(join(bin, 'codex'), '');
    writeFileSync(join(bin, 'codex.cmd'), '');
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome);
    // The file says enabled; the host says disabled. The host wins.
    writeFileSync(join(codexHome, 'config.toml'), "[mcp_servers.veto]\ncommand = 'npx'\nargs = ['-y']\n");
    const s = hostSpecs(home, process.platform, { CODEX_HOME: codexHome }).find(x => x.id === 'codex')!;
    const r = inspectHost(s, {
      home,
      env: { PATH: bin, PATHEXT: '.CMD' },
      runner: () => ok('Name  Command  Args  Env  Cwd  Status  Auth\nveto  npx  -y  -  -  disabled  Unsupported'),
    });
    expect(r.source).toBe('codex mcp list');
    expect(r.state).toBe('disabled');
    expect(isWorking(r.state)).toBe(false);
  });

  it('falls back to the file, and says so, when the host CLI times out', () => {
    const home = makeRoot();
    const bin = makeRoot();
    writeFileSync(join(bin, 'agy'), '');
    writeFileSync(join(bin, 'agy.cmd'), '');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { veto: { command: 'npx', args: [] } } }));
    const r = inspectHost(spec(home, 'antigravity'), { home, env: { PATH: bin, PATHEXT: '.CMD' }, runner: () => ({ ok: false, stdout: '', stderr: '', timedOut: true }) });
    expect(r.state).toBe('in-file');
    expect(r.note).toMatch(/timed out — fell back to reading the config file/);
  });

  it('reads Codex config.toml, including enabled = false', () => {
    const home = makeRoot();
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'), "model = 'x'\n\n[mcp_servers.veto]\ncommand = 'npx'\nargs = ['-y', 'veto-server']\nenabled = false\n\n[other]\na = 1\n");
    const s = hostSpecs(home, process.platform, { CODEX_HOME: codexHome }).find(x => x.id === 'codex')!;
    const r = inspectHost(s, { home, env: noPath() });
    expect(r.state).toBe('in-file-disabled');
    expect(r.entry).toEqual({ command: 'npx', args: ['-y', 'veto-server'] });
  });
});

describe('writeVetoTomlEntry', () => {
  it('appends once and recognises its own section afterwards', () => {
    const p = join(makeRoot(), 'config.toml');
    writeFileSync(p, "model = 'x'\n");
    expect(writeVetoTomlEntry(p, 'npx', ['-y', 'veto-server'])).toBe('created');
    expect(writeVetoTomlEntry(p, 'npx', ['-y', 'veto-server'])).toBe('exists');
    expect(readFileSync(p, 'utf8').match(/\[mcp_servers\.veto\]/g)).toHaveLength(1);
  });
});
