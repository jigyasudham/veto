import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeServerEntry, readJsonConfig, stripJsonComments, vetoEntry } from '../../src/cli/json-config.js';

const roots: string[] = [];
const file = (name = 'mcp_config.json') => { const r = mkdtempSync(join(tmpdir(), 'veto-jsoncfg-')); roots.push(r); return join(r, name); };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ENTRY = { command: 'npx.cmd', args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] };

describe('mergeServerEntry', () => {
  it('fills a 0-byte file — the exact file Antigravity ships, which the old writer skipped as "unreadable"', () => {
    const p = file();
    writeFileSync(p, '');
    expect(readJsonConfig(p).state).toBe('empty');
    expect(mergeServerEntry(p, 'mcpServers', ENTRY)).toMatchObject({ result: 'created' });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ mcpServers: { veto: ENTRY } });
  });

  it('keeps every other server and setting, and backs the old file up', () => {
    const p = file();
    writeFileSync(p, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
    const r = mergeServerEntry(p, 'mcpServers', ENTRY);
    expect(r).toMatchObject({ result: 'updated', backup: `${p}.veto-bak` });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' }, veto: ENTRY } });
    expect(JSON.parse(readFileSync(`${p}.veto-bak`, 'utf8')).mcpServers.veto).toBeUndefined();
  });

  it('does not rewrite a file that already has the same entry', () => {
    const p = file();
    writeFileSync(p, JSON.stringify({ mcpServers: { veto: ENTRY } }));
    expect(mergeServerEntry(p, 'mcpServers', ENTRY)).toEqual({ result: 'unchanged', backup: null });
    expect(existsSync(`${p}.veto-bak`)).toBe(false);
  });

  it('refuses to rewrite a JSONC file (it would delete the comments) and hands back a snippet', () => {
    const p = file('settings.json');
    const original = '// Zed settings\n{\n  "theme": "One Dark", // mine\n  "context_servers": {},\n}\n';
    writeFileSync(p, original);
    const r = mergeServerEntry(p, 'context_servers', ENTRY);
    expect(r.result).toBe('manual');
    expect(readFileSync(p, 'utf8')).toBe(original);
    if (r.result === 'manual') expect(JSON.parse(r.snippet)).toEqual({ context_servers: { veto: ENTRY } });
  });

  it('refuses invalid JSON and leaves it byte for byte', () => {
    const p = file();
    writeFileSync(p, '{ "mcpServers": ');
    expect(mergeServerEntry(p, 'mcpServers', ENTRY).result).toBe('manual');
    expect(readFileSync(p, 'utf8')).toBe('{ "mcpServers": ');
  });
});

describe('reading JSONC', () => {
  it('reads a commented file so doctor can report on it', () => {
    const p = file('settings.json');
    writeFileSync(p, '{\n  // servers\n  "context_servers": { "veto": { "command": "npx" } },\n}\n');
    const read = readJsonConfig(p);
    expect(read).toMatchObject({ state: 'ok', hasComments: true });
    expect(vetoEntry(read, 'context_servers')).toEqual({ command: 'npx' });
  });

  it('leaves comment-like text and commas inside strings alone', () => {
    const { json, hadComments } = stripJsonComments('{"url": "https://x.dev/a,]", "b": "/* not */"}');
    expect(hadComments).toBe(false);
    expect(JSON.parse(json)).toEqual({ url: 'https://x.dev/a,]', b: '/* not */' });
  });
});
