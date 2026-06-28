// veto statusline — a compact, always-on Veto line beneath the AI CLI prompt.
//
// Lives in the CLI (not the VS Code extension) so EVERY Veto user gets it in any
// terminal. Claude Code natively supports a custom `statusLine` command in
// settings.json; `veto statusline install` wires this command in.
//
// The `print` subcommand is a HOT PATH: it runs on every prompt render, so it
// must be read-only, fast (<50ms), and crash-proof. It opens a dedicated
// read-only DB connection (no migrations, no table creation, no writes) and on
// ANY problem — missing DB, locked DB (WAL / SQLITE_BUSY), bad row — it prints a
// neutral `⬡ veto` and exits 0. It never throws and never blocks the prompt.

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getDbPath, getDb } from '../memory/local.js';
import { getConfig } from '../memory/config.js';

// node:sqlite is a Node 22.5+ built-in — use createRequire so bundlers skip it.
const _require = createRequire(import.meta.url);
const DbSync = (_require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;

// ─── Data ────────────────────────────────────────────────────────────────────

export interface StatuslineData {
  verdict: 'GREEN' | 'YELLOW' | 'RED' | null; // latest council verdict
  routerPct: number | null;                   // top learned-pattern confidence, 0..100
  platform: string | null;                    // active session platform
  ratePct: number | null;                     // that platform's token usage today, 0..100
  memCount: number | null;                    // knowledge_base entries
}

const EMPTY: StatuslineData = {
  verdict: null, routerPct: null, platform: null, ratePct: null, memCount: null,
};

// Open the veto DB read-only. Returns null if it can't (missing/locked/corrupt).
function openReadOnly(path: string): DatabaseSync | null {
  try {
    const db = new DbSync(path, { readOnly: true });
    // query_only is belt-and-suspenders; busy_timeout keeps us from blocking the
    // prompt if a writer holds the WAL lock — fail fast to the neutral fallback.
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 50');
    return db;
  } catch {
    return null;
  }
}

// Crash-proof read of everything the statusline shows. Never throws.
export function readStatuslineData(): StatuslineData {
  let db: DatabaseSync | null = null;
  let closeAfter = false;
  try {
    const path = getDbPath();
    if (path === ':memory:') {
      // In-memory (tests / special cases): a fresh read-only handle would be a
      // different empty DB, so reuse the shared reader.
      db = getDb();
    } else {
      if (!existsSync(path)) return EMPTY;
      db = openReadOnly(path);
      closeAfter = true;
      if (!db) return EMPTY;
    }
    return queryStatusline(db);
  } catch {
    return EMPTY;
  } finally {
    if (closeAfter && db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

function queryStatusline(db: DatabaseSync): StatuslineData {
  const data: StatuslineData = { ...EMPTY };

  // Each block is independently guarded: a missing/older table degrades that one
  // segment to null rather than blanking the whole line.
  try {
    const row = db.prepare(
      'SELECT verdict FROM council_outcomes ORDER BY debated_at DESC LIMIT 1'
    ).get() as { verdict?: string } | undefined;
    const v = (row?.verdict ?? '').toUpperCase();
    if (v === 'GREEN' || v === 'YELLOW' || v === 'RED') data.verdict = v;
  } catch { /* segment off */ }

  try {
    // Top confidence among learned patterns. Exclude router.* threshold rows and
    // composed_agent:* definitions — those carry config/JSON, not a learning score.
    const row = db.prepare(
      `SELECT confidence FROM patterns
       WHERE pattern_key NOT LIKE 'router.%' AND pattern_key NOT LIKE 'composed_agent:%'
       ORDER BY confidence DESC, seen_count DESC LIMIT 1`
    ).get() as { confidence?: number } | undefined;
    if (typeof row?.confidence === 'number') {
      data.routerPct = Math.max(0, Math.min(100, Math.round(row.confidence * 100)));
    }
  } catch { /* segment off */ }

  try {
    const row = db.prepare(
      'SELECT platform FROM sessions ORDER BY created_at DESC LIMIT 1'
    ).get() as { platform?: string } | undefined;
    if (row?.platform) data.platform = row.platform;
  } catch { /* segment off */ }

  // Rate % for the active platform today — mirrors router/rate-monitor semantics
  // (min(100, round(tokens / dailyBudget * 100))).
  if (data.platform) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const row = db.prepare(
        'SELECT token_count FROM rate_usage WHERE platform = ? AND date_key = ?'
      ).get(data.platform, today) as { token_count?: number } | undefined;
      const tokens = row?.token_count ?? 0;
      const budgets = getConfig().dailyTokenBudget as Record<string, number>;
      const budget = budgets[data.platform];
      if (budget && budget > 0) {
        data.ratePct = Math.min(100, Math.round((tokens / budget) * 100));
      }
    } catch { /* segment off */ }
  }

  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM knowledge_base').get() as { n?: number } | undefined;
    if (typeof row?.n === 'number') data.memCount = row.n;
  } catch { /* segment off */ }

  return data;
}

// ─── Render (pure — no DB, fully testable) ─────────────────────────────────────

export interface ComposeOptions {
  color?: boolean; // ANSI colors (default: !NO_COLOR)
  ascii?: boolean; // ASCII glyph fallback (default: VETO_STATUSLINE_ASCII)
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export function composeStatusline(data: StatuslineData, opts: ComposeOptions = {}): string {
  const color = opts.color ?? !process.env.NO_COLOR;
  const ascii = opts.ascii ?? Boolean(process.env.VETO_STATUSLINE_ASCII);
  const paint = (s: string, code: string) => (color ? `${code}${s}${ANSI.reset}` : s);

  const head = `${ascii ? '#' : '⬡'} veto`;
  const segments: string[] = [];

  if (data.verdict) {
    const code = data.verdict === 'GREEN' ? ANSI.green
      : data.verdict === 'YELLOW' ? ANSI.yellow
      : ANSI.red;
    segments.push(paint(data.verdict, code));
  }

  if (data.routerPct !== null) {
    segments.push(`router ${data.routerPct}%`);
  }

  if (data.platform && data.ratePct !== null) {
    // Color the rate % using the same thresholds as rate-monitor (warn ≥70, crit ≥90).
    const label = `${data.platform} ${data.ratePct}%`;
    const code = data.ratePct >= 90 ? ANSI.red : data.ratePct >= 70 ? ANSI.yellow : '';
    segments.push(code ? paint(label, code) : label);
  }

  if (data.memCount !== null) {
    segments.push(`mem ${data.memCount}`);
  }

  if (segments.length === 0) return head; // neutral fallback
  return `${head} ${segments.join(' · ')}`;
}

// The hot path: read + render + print. Never throws, always exits 0.
export function printStatusline(opts: ComposeOptions = {}): void {
  let line: string;
  try {
    line = composeStatusline(readStatuslineData(), opts);
  } catch {
    line = composeStatusline(EMPTY, opts);
  }
  process.stdout.write(line + '\n');
}

// ─── settings.json install / uninstall ─────────────────────────────────────────

interface ClientTarget {
  name: string;
  settingsPath: string;
}

// Resolve the settings.json for a client. Only Claude Code exposes a documented
// `statusLine` command hook today; others are gated behind --client as a stretch.
function resolveClient(client: string): ClientTarget | null {
  const HOME = homedir();
  switch (client) {
    case 'claude':
      // VETO_STATUSLINE_SETTINGS overrides the path (used by tests).
      return {
        name: 'Claude Code',
        settingsPath: process.env.VETO_STATUSLINE_SETTINGS ?? join(HOME, '.claude', 'settings.json'),
      };
    default:
      return null;
  }
}

const STATUSLINE_VALUE = { type: 'command', command: 'veto statusline print' } as const;
const BACKUP_SUFFIX = '.veto-statusline-backup';
const NO_ORIGINAL = '__VETO_NO_ORIGINAL_FILE__';

function isOurStatusLine(v: unknown): boolean {
  return Boolean(v) && typeof v === 'object'
    && (v as { command?: string }).command === STATUSLINE_VALUE.command;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  changed?: boolean;
  backupPath?: string;
}

export function installStatusline(client = 'claude', opts: { force?: boolean; dryRun?: boolean } = {}): InstallResult {
  const target = resolveClient(client);
  if (!target) {
    return { ok: false, message: `Unknown client "${client}". Supported: claude.` };
  }
  const { settingsPath } = target;
  const existed = existsSync(settingsPath);

  let settings: Record<string, unknown> = {};
  let rawOriginal = '';
  if (existed) {
    try {
      rawOriginal = readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(rawOriginal) as Record<string, unknown>;
    } catch {
      return { ok: false, message: `Refusing to touch ${settingsPath}: it is not valid JSON.` };
    }
  }

  const current = settings.statusLine;
  if (isOurStatusLine(current)) {
    return { ok: true, changed: false, message: `Already installed for ${target.name} (${settingsPath}).` };
  }
  if (current !== undefined && !opts.force) {
    return {
      ok: false,
      message: `${target.name} already has a custom statusLine. Re-run with --force to replace it `
        + `(your original is backed up and restored on uninstall).`,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      changed: false,
      message: `[dry-run] Would set statusLine → ${JSON.stringify(STATUSLINE_VALUE)} in ${settingsPath}`
        + (current !== undefined ? ` (replacing existing statusLine).` : `.`),
    };
  }

  // Back up byte-for-byte so uninstall can restore exactly. Only create the
  // backup once (a re-install must not overwrite the true original).
  const backupPath = settingsPath + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, existed ? rawOriginal : NO_ORIGINAL, 'utf8');
  }

  settings.statusLine = { ...STATUSLINE_VALUE };
  if (!existed) mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    changed: true,
    backupPath,
    message: `Installed Veto statusline for ${target.name}.\n  ${settingsPath}\n  backup: ${backupPath}`
      + (current !== undefined ? `\n  (replaced your previous statusLine — restored on uninstall)` : ``),
  };
}

export function uninstallStatusline(client = 'claude'): InstallResult {
  const target = resolveClient(client);
  if (!target) {
    return { ok: false, message: `Unknown client "${client}". Supported: claude.` };
  }
  const { settingsPath } = target;
  const backupPath = settingsPath + BACKUP_SUFFIX;

  if (existsSync(backupPath)) {
    const backup = readFileSync(backupPath, 'utf8');
    if (backup === NO_ORIGINAL) {
      // There was no settings file before us — remove our key; delete the file if
      // it now holds nothing else.
      if (existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
          delete settings.statusLine;
          if (Object.keys(settings).length === 0) {
            unlinkSync(settingsPath);
          } else {
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
          }
        } catch { /* leave as-is if unreadable */ }
      }
    } else {
      // Restore the original file byte-for-byte.
      writeFileSync(settingsPath, backup, 'utf8');
    }
    unlinkSync(backupPath);
    return { ok: true, changed: true, message: `Uninstalled Veto statusline for ${target.name} (restored ${settingsPath}).` };
  }

  // No backup — best-effort removal of our key only.
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      if (isOurStatusLine(settings.statusLine)) {
        delete settings.statusLine;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        return { ok: true, changed: true, message: `Removed Veto statusline from ${settingsPath}.` };
      }
    } catch { /* fall through */ }
  }
  return { ok: true, changed: false, message: `Veto statusline was not installed for ${target.name}.` };
}

export function statuslineStatusInfo(client = 'claude'): { installed: boolean; settingsPath: string | null; sample: string } {
  const target = resolveClient(client);
  const sample = composeStatusline(readStatuslineData());
  if (!target) return { installed: false, settingsPath: null, sample };
  let installed = false;
  if (existsSync(target.settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(target.settingsPath, 'utf8')) as Record<string, unknown>;
      installed = isOurStatusLine(settings.statusLine);
    } catch { /* installed stays false */ }
  }
  return { installed, settingsPath: target.settingsPath, sample };
}
