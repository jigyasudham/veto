// Evidence that a host really started Veto.
//
// `veto doctor` used to check that a config file named Veto. That says nothing
// about whether the host reads that file (Antigravity stopped reading it), which
// Node it launches Veto with (a GUI app may not see your shell's nvm Node), or
// whether node:sqlite worked in THAT runtime. Only the server knows those, and
// only at the moment a host starts it.
//
// So on every MCP handshake the server records one line per client: who started
// it, when, with which Veto and Node, and whether SQLite loaded. It is a plain
// JSON file on purpose — the case most worth recording is the one where SQLite
// does not work, and a DB row could not be written then.
//
// Mechanical tier: no LLM, no network, bounded size, never throws.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type HostStart = {
  client: string;
  client_version: string | null;
  platform: string | null;
  veto_version: string;
  node_version: string;
  sqlite_ok: boolean;
  exec_path: string;
  first_seen: string;
  last_seen: string;
  starts: number;
};

type Ledger = { version: 1; clients: Record<string, HostStart> };

const MAX_CLIENTS = 32;

/** The client name `veto doctor` uses when it probes a server. */
export const PROBE_CLIENT = 'veto-doctor';

export function hostStartsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.VETO_HOST_STARTS_PATH) return env.VETO_HOST_STARTS_PATH;
  // Tests run on an in-memory DB; never let them write the owner's real ledger.
  if (env.VETO_TEST_DB) return null;
  return join(homedir(), '.veto', 'host-starts.json');
}

export function readHostStarts(path: string | null = hostStartsPath()): HostStart[] {
  if (!path) return [];
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
    if (!ledger || typeof ledger !== 'object' || !ledger.clients || typeof ledger.clients !== 'object') return [];
    return Object.values(ledger.clients).filter(s => s && typeof s.client === 'string');
  } catch {
    return [];
  }
}

export function recordHostStart(
  input: { client: string; client_version?: string | null; platform?: string | null; veto_version: string; sqlite_ok: boolean },
  options: { path?: string | null; now?: Date } = {},
): void {
  try {
    const path = options.path === undefined ? hostStartsPath() : options.path;
    // `veto doctor`'s own probe is not a host; recording it would be self-evidence.
    if (!path || !input.client || input.client === PROBE_CLIENT) return;
    const now = (options.now ?? new Date()).toISOString();
    let ledger: Ledger = { version: 1, clients: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
      if (parsed && typeof parsed.clients === 'object' && parsed.clients) ledger = { version: 1, clients: parsed.clients };
    } catch { /* first write, or a damaged file: start over */ }

    const key = input.client.slice(0, 120);
    const prev = ledger.clients[key];
    ledger.clients[key] = {
      client: key,
      client_version: input.client_version ?? null,
      platform: input.platform ?? null,
      veto_version: input.veto_version,
      node_version: process.version,
      sqlite_ok: input.sqlite_ok,
      exec_path: process.execPath,
      first_seen: prev?.first_seen ?? now,
      last_seen: now,
      starts: (prev?.starts ?? 0) + 1,
    };
    // Bounded: keep the most recently seen clients.
    const entries = Object.values(ledger.clients).sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, MAX_CLIENTS);
    ledger.clients = Object.fromEntries(entries.map(e => [e.client, e]));

    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch { /* evidence is best-effort; it must never affect a handshake */ }
}

/**
 * Which recorded client is this host? Hosts name themselves in the MCP
 * handshake, and the names belong to other projects, so matching is by marker.
 */
export function startsForHost(hostId: string, starts: HostStart[]): HostStart[] {
  const markers: Record<string, RegExp> = {
    claude: /claude/i,
    codex: /codex/i,
    antigravity: /antigravity|jetski|cascade|\bagy\b/i,
    gemini: /gemini/i,
    cursor: /cursor/i,
    windsurf: /windsurf|codeium/i,
    zed: /\bzed\b/i,
  };
  const re = markers[hostId];
  if (!re) return [];
  // Antigravity is Gemini-powered; a client that names Antigravity is not Gemini CLI.
  return starts.filter(s => re.test(s.client) && !(hostId === 'gemini' && markers.antigravity.test(s.client)));
}
