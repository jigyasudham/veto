import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { detectHost, entryDisabled, findOnPath, hostSpecs, parseMcpList, serverCommand } from '../../src/cli/hosts.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-hosts-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('parseMcpList — what a host itself reports', () => {
  it('reads Claude Code health lines', () => {
    expect(parseMcpList('Checking MCP server health…\n\nveto: npx.cmd -y --package @jigyasudham/veto@latest veto-server - ✔ Connected')).toBe('connected');
    expect(parseMcpList('veto: npx -y --package @jigyasudham/veto@latest veto-server - ✗ Failed to connect')).toBe('failed');
  });

  it('reads the Codex and Antigravity tables, including a disabled entry', () => {
    expect(parseMcpList('Name  Command  Args  Env  Cwd  Status   Auth\nveto  npx.cmd  -y --package @jigyasudham/veto@latest veto-server  -  -  enabled  Unsupported')).toBe('enabled');
    expect(parseMcpList('NAME  TYPE   STATUS   COMMAND/URL\nveto  stdio  disabled  npx.cmd -y --package @jigyasudham/veto@latest veto-server')).toBe('disabled');
  });

  it('does not count a differently named server as Veto', () => {
    expect(parseMcpList('veto-dev: node D:/Veto/dist/server.js - ✔ Connected')).toBe('absent');
    expect(parseMcpList('my-veto  stdio  enabled  node x')).toBe('absent');
    expect(parseMcpList('')).toBe('absent');
  });
});

describe('host table', () => {
  it('points Antigravity at the file it reads, and lists the old one only as legacy', () => {
    const home = makeRoot();
    const ag = hostSpecs(home, 'win32', {}).find(s => s.id === 'antigravity')!;
    expect(ag.config?.path).toBe(join(home, '.gemini', 'config', 'mcp_config.json'));
    expect(ag.legacyConfigs).toEqual([join(home, '.gemini', 'antigravity-cli', 'mcp_config.json')]);
    expect(ag.cli?.add('npx.cmd', ['-y'])).toEqual(['mcp', 'add', 'veto', '--', 'npx.cmd', '-y']);
  });

  it('never treats ~/.gemini alone as Gemini CLI being installed (Antigravity creates it too)', () => {
    const home = makeRoot();
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    const env = { PATH: makeRoot() };
    const specs = hostSpecs(home, process.platform, env);
    expect(detectHost(specs.find(s => s.id === 'gemini')!, env).installed).toBe(false);
    expect(detectHost(specs.find(s => s.id === 'antigravity')!, env)).toMatchObject({ installed: true, via: 'dir' });
  });

  it('uses npx.cmd on Windows and npx elsewhere, always pinned to @latest', () => {
    expect(serverCommand('win32')).toEqual({ command: 'npx.cmd', args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] });
    expect(serverCommand('linux').command).toBe('npx');
  });
});

describe('findOnPath', () => {
  it('finds an executable through PATHEXT on Windows, without spawning anything', () => {
    const bin = makeRoot();
    writeFileSync(join(bin, 'agy.cmd'), '@echo off');
    expect(findOnPath('agy', { PATH: bin, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(bin, 'agy.cmd'));
    expect(findOnPath('claude', { PATH: bin, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
  });

  it('ignores directories with the same name', () => {
    const bin = makeRoot();
    mkdirSync(join(bin, 'codex'));
    expect(findOnPath('codex', { PATH: bin }, 'linux')).toBeNull();
  });
});

describe('entryDisabled', () => {
  it('recognises both spellings hosts use', () => {
    expect(entryDisabled({ command: 'x', disabled: true })).toBe(true);
    expect(entryDisabled({ command: 'x', enabled: false })).toBe(true);
    expect(entryDisabled({ command: 'x', disabled: false })).toBe(false);
    expect(entryDisabled(undefined)).toBe(false);
  });
});
