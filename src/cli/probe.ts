// Start a configured Veto server exactly as a host would, and see if it answers.
//
// A config entry is a claim; this is the test of it. It runs the same command
// and arguments the host was given, completes the MCP handshake, lists the
// tools, and reports how long that took. It catches what "the key exists" never
// could: npx unable to reach the registry (offline, proxy, outage), a corrupt
// npx cache, a server that exits before answering (issue #39 was exactly this),
// or a start so slow a host gives up on it.
//
// What it cannot see is the host's own environment — a GUI app may launch Veto
// with a different PATH and Node than this terminal has. host-starts.ts covers
// that from the server's side.

import { spawn } from 'node:child_process';
import { PROBE_CLIENT } from '../host-starts.js';

export type ProbeResult = {
  ok: boolean;
  ms: number;
  serverVersion: string | null;
  tools: number;
  error: string | null;
  /** A short diagnosis when the failure has a recognisable cause. */
  hint: string | null;
};

const NETWORK_RE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network|getaddrinfo|proxy|E404|ERR_SOCKET/i;

/** Quote one argument for cmd.exe; only needed because .cmd shims require a shell. */
function winQuote(a: string): string {
  return /^[\w@./:=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

export function probeServer(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let serverVersion: string | null = null;

    // Windows cannot spawn a .cmd shim without a shell (Node refuses since the
    // 2024 batch-file fix), so build one quoted command line there.
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn([command, ...args].map(winQuote).join(' '), { shell: true, windowsHide: true, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { windowsHide: true, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (r: Omit<ProbeResult, 'ms' | 'hint'> & { hint?: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      // On Windows the child is cmd.exe; killing it alone would orphan the
      // npx and node processes beneath it, so take the whole tree down.
      if (isWin && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* best effort */ }
      } else {
        try { child.kill(); } catch { /* already gone */ }
      }
      const ms = Date.now() - started;
      let hint = r.hint ?? null;
      if (!r.ok && !hint && NETWORK_RE.test(stderr)) hint = 'npx could not reach the npm registry — a host starting Veto now (offline, behind a proxy, or during an npm outage) would fail the same way';
      if (r.ok && ms > 20_000) hint = `started, but took ${Math.round(ms / 1000)} s — some hosts stop waiting for an MCP server sooner than that`;
      resolve({ ...r, ms, hint });
    };

    const timer = setTimeout(() => finish({
      ok: false, serverVersion, tools: 0,
      error: `no answer within ${Math.round(timeoutMs / 1000)} s`,
      hint: NETWORK_RE.test(stderr) ? 'npx could not reach the npm registry' : 'the server did not complete the MCP handshake in time',
    }), timeoutMs);

    const send = (msg: unknown): void => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* closed */ } };

    child.on('error', (err) => finish({ ok: false, serverVersion, tools: 0, error: `could not start: ${err.message}` }));
    child.on('exit', (code) => {
      if (settled) return;
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      finish({ ok: false, serverVersion, tools: 0, error: `exited with code ${code} before answering${tail ? ` — ${tail}` : ''}` });
    });
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8_000); });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { serverInfo?: { version?: string }; tools?: unknown[] }; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch {
          finish({ ok: false, serverVersion, tools: 0, error: `wrote non-protocol output to stdout: ${line.slice(0, 120)}`, hint: 'anything a server prints to stdout corrupts the MCP channel' });
          return;
        }
        if (msg.id === 1) {
          if (msg.error) { finish({ ok: false, serverVersion, tools: 0, error: `initialize failed: ${msg.error.message ?? 'unknown'}` }); return; }
          serverVersion = msg.result?.serverInfo?.version ?? null;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result!.tools!.length : 0;
          finish(tools > 0
            ? { ok: true, serverVersion, tools, error: null }
            : { ok: false, serverVersion, tools: 0, error: msg.error?.message ? `tools/list failed: ${msg.error.message}` : 'answered, but listed no tools' });
        }
      }
    });

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: PROBE_CLIENT, version: '1' } },
    });
  });
}
