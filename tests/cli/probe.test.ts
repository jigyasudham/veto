import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { probeServer } from '../../src/cli/probe.js';

const roots: string[] = [];
function script(body: string): string {
  const r = mkdtempSync(join(tmpdir(), 'veto-probe-'));
  roots.push(r);
  const p = join(r, 'server.mjs');
  writeFileSync(p, body);
  return p;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const HEALTHY = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'veto', version: '9.9.9' } } }) + '\\n');
  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

describe('probeServer — launch the configured command and see if it answers', () => {
  it('reports version and tool count from a server that answers', async () => {
    const r = await probeServer(process.execPath, [script(HEALTHY)], { timeoutMs: 20_000 });
    expect(r).toMatchObject({ ok: true, serverVersion: '9.9.9', tools: 2, error: null });
  }, 30_000);

  it('reports a server that exits before answering (issue #39 looked exactly like this)', async () => {
    const r = await probeServer(process.execPath, [script('process.stderr.write("boom\\n"); process.exit(3);')], { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited with code 3 before answering — boom/);
  }, 30_000);

  it('recognises a registry failure in npx output', async () => {
    const r = await probeServer(process.execPath, [script('process.stderr.write("npm error code ENOTFOUND registry.npmjs.org\\n"); process.exit(1);')], { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/could not reach the npm registry/);
  }, 30_000);

  it('catches a server that prints to stdout (it corrupts the MCP channel)', async () => {
    const r = await probeServer(process.execPath, [script('console.log("hello"); setTimeout(() => {}, 5000);')], { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-protocol output/);
  }, 30_000);

  it('gives up on a server that never answers', async () => {
    const r = await probeServer(process.execPath, [script('setTimeout(() => {}, 60000);')], { timeoutMs: 1_500 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no answer within 2 s|no answer within 1 s/);
  }, 30_000);
});
