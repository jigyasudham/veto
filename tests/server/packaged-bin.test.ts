import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression cover for issue #39. `veto-server` shipped for ten releases as a bin
// that never started under npm or npx on macOS and Linux: npm installs a bin as a
// SYMLINK there, the module compared its own (symlink-resolved) path against
// process.argv[1] (the link path), the two never matched, and the process exited 0
// without answering MCP initialize. Windows was immune because npm writes .cmd
// shims that invoke the real path — which is exactly why no local run ever caught
// it, and why this file launches the bin the way a package manager would rather
// than the way a developer does.
//
// The suite has no other test that executes the built artifact, so this also
// stands as the first check that `dist/` is launchable at all.

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'dist', 'bin', 'veto-server.js');

const INIT_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'packaged-bin-test', version: '1.0.0' },
  },
}) + '\n';

/** Launch a path with node, feed it one initialize request, return what it wrote. */
function initializeVia(entry: string, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const done = (code: number | null) => resolve({ stdout, stderr, code });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      // The response is one JSON line; stop as soon as it lands so a healthy
      // server (which stays open on stdio) does not hold the test for the timeout.
      if (stdout.includes('"result"')) { child.kill(); done(0); }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', done);
    child.on('error', () => done(null));

    child.stdin.write(INIT_REQUEST);
    setTimeout(() => { child.kill(); done(null); }, timeoutMs).unref?.();
  });
}

function expectServedInitialize(r: { stdout: string; stderr: string }) {
  expect(r.stdout, `server wrote nothing to stdout. stderr: ${r.stderr}`).toContain('"result"');
  const line = r.stdout.split('\n').find((l) => l.includes('"result"'))!;
  const parsed = JSON.parse(line);
  expect(parsed.result.serverInfo.name).toBe('veto');
  expect(parsed.result.protocolVersion).toBeTruthy();
}

describe('packaged bin (issue #39)', () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      throw new Error(`dist/bin/veto-server.js is missing — run \`npm run build\` before the suite. Looked in ${BIN}`);
    }
  });

  it('serves MCP initialize when launched directly', async () => {
    expectServedInitialize(await initializeVia(BIN));
  });

  // The actual #39 reproduction. Skipped only where the OS refuses to make a
  // symlink (unprivileged Windows without Developer Mode); it runs for real on the
  // Linux and macOS CI legs, which is where the bug lived.
  it('serves MCP initialize when launched through an npm-style .bin symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veto-bin-'));
    const binDir = join(dir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, 'veto-server');

    try {
      symlinkSync(BIN, link, 'file');
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`skipping symlink leg — this OS will not create one here: ${msg}`);
      return;
    }

    try {
      expectServedInitialize(await initializeVia(link));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Windows-runnable form of the same defect: a directory junction needs no
  // privileges, and realpath resolves it, so argv[1] and the module's real path
  // differ exactly as they do through a POSIX .bin symlink.
  it.runIf(process.platform === 'win32')('serves MCP initialize when launched through a directory junction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veto-junction-'));
    const linkedDir = join(dir, 'linked');

    try {
      symlinkSync(join(REPO, 'dist', 'bin'), linkedDir, 'junction');
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`skipping junction leg — could not create one: ${msg}`);
      return;
    }

    try {
      expectServedInitialize(await initializeVia(join(linkedDir, 'veto-server.js')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
