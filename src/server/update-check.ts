// Non-blocking "a newer Veto is available" nudge, surfaced to the agent through the
// MCP server `instructions` field (the same channel as the statusline setup tip).
//
// Server startup must stay instant and offline-safe, so we NEVER hit the network
// synchronously. Instead we read a locally cached "latest known version" and, at most
// once every 24h, fire a detached background `npm view` to refresh that cache for the
// NEXT launch. The cache lives under ~/.veto so it survives npx's ephemeral installs.
//
// This directly targets the "npx silently runs a stale version" trap: once a newer
// version ships, the running server tells the agent to restart the client (the pinned
// `@latest` config then fetches it) and how to repair a config that predates the pin.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { VERSION } from './runtime.js';

const VETO_DIR = join(homedir(), '.veto');
const CACHE_PATH = join(VETO_DIR, '.update-check.json');
const REFRESH_MS = 24 * 60 * 60 * 1000; // check the registry at most once per day

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

function readCache(): UpdateCache | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as UpdateCache;
  } catch {
    return undefined; // missing / unreadable — treated as "never checked"
  }
}

// True when `candidate` is a strictly newer major.minor.patch than `current`.
// Pre-release suffixes (e.g. -beta.1) are ignored — we only nudge on stable bumps.
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => parseInt(n, 10));
  const b = current.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

// Fire-and-forget registry lookup. Writes the cache for a FUTURE startup to read; it
// never touches stdout/stderr of the parent (exec pipes the child's streams), so it
// can't corrupt the MCP stdio protocol. Any failure is swallowed — this is best-effort.
function refreshInBackground(): void {
  try {
    exec('npm view @jigyasudham/veto version', { timeout: 8000 }, (err, stdout) => {
      if (err) return;
      const latest = stdout.trim();
      if (!/^\d+\.\d+\.\d+/.test(latest)) return;
      try {
        mkdirSync(VETO_DIR, { recursive: true });
        writeFileSync(CACHE_PATH, JSON.stringify({ latest, checkedAt: Date.now() }), 'utf8');
      } catch {
        /* best-effort cache write */
      }
    });
  } catch {
    /* exec unavailable — ignore */
  }
}

// Read synchronously from cache (instant, offline-safe) and, if the cache is stale,
// kick off a non-blocking refresh for next time. Returns the nudge string only when a
// strictly newer version is already known — never on the very first install.
export function versionUpdateInstruction(): string | undefined {
  const cache = readCache();

  if (!cache || Date.now() - cache.checkedAt > REFRESH_MS) {
    refreshInBackground();
  }

  if (cache && isNewer(cache.latest, VERSION)) {
    return [
      `UPDATE AVAILABLE — Veto v${cache.latest} is out (this server is running v${VERSION}).`,
      'Mention this once per session, then drop it if the user is not interested.',
      'Veto is launched via npx, so the fix is simply to fully restart the AI client',
      '(quit and reopen) — the pinned `@latest` config fetches the new version on the next',
      'start. If it stays on the old version, the config likely predates the `@latest` pin:',
      'run `veto init` to rewrite it. A global CLI install updates separately via',
      '`npm i -g @jigyasudham/veto@latest`. Run `veto doctor` to confirm.',
    ].join(' ');
  }

  return undefined;
}
