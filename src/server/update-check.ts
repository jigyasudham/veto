// Non-blocking "a newer Veto is available" nudge, surfaced to the agent through the
// MCP server `instructions` field (the same channel as the statusline setup tip).
//
// Server startup must stay instant and offline-safe, so we NEVER hit the network
// synchronously. Instead we read a locally cached "latest known version" and, at most
// once every 24h after success (hourly after failure), fire an asynchronous `npm view` to refresh that cache for the
// NEXT launch. The cache lives under ~/.veto so it survives npx's ephemeral installs.
//
// This directly targets the "npx silently runs a stale version" trap: once a newer
// version ships, the running server tells the agent to restart the client (the pinned
// `@latest` config then fetches it) and how to repair a config that predates the pin.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { VERSION } from './runtime.js';

const VETO_DIR = join(homedir(), '.veto');
const CACHE_PATH = join(VETO_DIR, '.update-check.json');
const LOCK_PATH = join(VETO_DIR, '.update-check.lock');
const REFRESH_MS = 24 * 60 * 60 * 1000; // check the registry at most once per day
const RETRY_MS = 60 * 60 * 1000; // failures must not retry on every server start

interface UpdateCache {
  latest?: string;
  checkedAt?: number;
  attemptedAt?: number;
}

function readCache(): UpdateCache | undefined {
  try {
    const value = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    return {
      latest: typeof value.latest === 'string' && /^\d+\.\d+\.\d+$/.test(value.latest) ? value.latest : undefined,
      checkedAt: typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) ? value.checkedAt : undefined,
      attemptedAt: typeof value.attemptedAt === 'number' && Number.isFinite(value.attemptedAt) ? value.attemptedAt : undefined,
    };
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

function refreshDue(cache: UpdateCache | undefined): boolean {
  const now = Date.now();
  return !(cache?.latest && cache.checkedAt !== undefined && now - cache.checkedAt < REFRESH_MS)
    && !(cache?.attemptedAt !== undefined && now - cache.attemptedAt < RETRY_MS);
}

// Exclusive file creation coordinates independent MCP processes. Only reclaim a
// dead owner's lock; a live but slow npm process must keep its ownership.
function acquireLock(): string | undefined {
  const token = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try {
    mkdirSync(VETO_DIR, { recursive: true });
    try {
      writeFileSync(LOCK_PATH, token, { flag: 'wx' });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    // Also give a creator time to finish writing its PID.
    if (Date.now() - statSync(LOCK_PATH).mtimeMs < 60_000) return undefined;
    const previous = readFileSync(LOCK_PATH, 'utf8');
    let pid: unknown;
    try { pid = JSON.parse(previous).pid; } catch { /* interrupted creation */ }
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return undefined; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return undefined;
      }
    }
    if (readFileSync(LOCK_PATH, 'utf8') !== previous) return undefined;
    unlinkSync(LOCK_PATH);
    writeFileSync(LOCK_PATH, token, { flag: 'wx' });
    return token;
  } catch { return undefined; }
}

function releaseLock(token: string): void {
  try {
    if (readFileSync(LOCK_PATH, 'utf8') === token) unlinkSync(LOCK_PATH);
  } catch { /* best-effort */ }
}

// Writes the cache for a future startup. exec pipes the child's streams so it
// cannot corrupt MCP stdout; every failure is best-effort and keeps the old version.
function refreshInBackground(): void {
  const token = acquireLock();
  if (!token) return;
  try {
    // Re-read under the lock: another server may have just finished refreshing.
    const cache = readCache();
    if (!refreshDue(cache)) { releaseLock(token); return; }
    const attemptedAt = Date.now();
    writeFileSync(CACHE_PATH, JSON.stringify({ ...cache, attemptedAt }), 'utf8');
    exec('npm view @jigyasudham/veto version', { timeout: 8000, windowsHide: true }, (err, stdout) => {
      try {
        if (err) return;
        const latest = stdout.trim();
        if (!/^\d+\.\d+\.\d+$/.test(latest)) return;
        writeFileSync(CACHE_PATH, JSON.stringify({ latest, checkedAt: Date.now(), attemptedAt }), 'utf8');
      } catch {
        /* best-effort cache write */
      } finally {
        releaseLock(token);
      }
    });
  } catch {
    releaseLock(token);
    /* exec unavailable — ignore */
  }
}

// Read synchronously from cache (instant, offline-safe) and, if the cache is stale,
// kick off a non-blocking refresh for next time. Returns the nudge string only when a
// strictly newer version is already known — never on the very first install.
export function versionUpdateInstruction(): string | undefined {
  const cache = readCache();

  if (refreshDue(cache)) {
    refreshInBackground();
  }

  if (cache?.latest && isNewer(cache.latest, VERSION)) {
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
