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
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getDbPath, getDb, normalizeProjectDir } from '../memory/local.js';

// node:sqlite is a Node 22.5+ built-in — use createRequire so bundlers skip it.
// Required lazily inside openReadOnly so importing this module (server.ts pulls in
// statuslineSetupInstruction at startup) never dies on runtimes without node:sqlite.
const _require = createRequire(import.meta.url);

// ─── Data ────────────────────────────────────────────────────────────────────

export interface StatuslineData {
  verdict: 'GREEN' | 'YELLOW' | 'RED' | null; // latest council verdict (Veto DB)
  routerPct: number | null;                   // top learned-pattern confidence, 0..100 (Veto DB)
  contextPct: number | null;                  // LIVE context-window % used — from Claude Code stdin, NOT the DB
  rate5hPct: number | null;                   // LIVE 5-hour rate-limit % used — from Claude Code stdin
  rate7dPct: number | null;                   // LIVE 7-day (weekly) rate-limit % used — from Claude Code stdin
  memCount: number | null;                    // knowledge_base entries (Veto DB)
}

const EMPTY: StatuslineData = {
  verdict: null, routerPct: null, contextPct: null, rate5hPct: null, rate7dPct: null, memCount: null,
};

// Open the veto DB read-only. Returns null if it can't (missing/locked/corrupt).
function openReadOnly(path: string): DatabaseSync | null {
  try {
    const DbSync = (_require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
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
// `projectDir` (when known, e.g. from the Claude Code payload's workspace dir) scopes
// the council verdict to the current workspace instead of the global newest.
export function readStatuslineData(projectDir?: string): StatuslineData {
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
    return queryStatusline(db, projectDir);
  } catch {
    return EMPTY;
  } finally {
    if (closeAfter && db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

function queryStatusline(db: DatabaseSync, projectDir?: string): StatuslineData {
  const data: StatuslineData = { ...EMPTY };

  // Each block is independently guarded: a missing/older table degrades that one
  // segment to null rather than blanking the whole line.
  try {
    // Scope the verdict to the current workspace when we know it — otherwise the line
    // shows the globally-newest debate, which may belong to a different project. When
    // projectDir is provided we do NOT fall back to another project's verdict; the
    // segment simply drops if this project has no council row yet.
    // debated_at is an ISO string with millisecond resolution and `id` is a random
    // UUID, so two debates recorded in the same millisecond have no ordering at all
    // and SQLite is free to return either. Tie-break on rowid, which increments per
    // insert, so "newest" always means the row written last.
    const scoped = projectDir ? normalizeProjectDir(projectDir) : undefined;
    const row = (scoped
      ? db.prepare('SELECT verdict FROM council_outcomes WHERE project_dir = ? ORDER BY debated_at DESC, rowid DESC LIMIT 1').get(scoped)
      : db.prepare('SELECT verdict FROM council_outcomes ORDER BY debated_at DESC, rowid DESC LIMIT 1').get()
    ) as { verdict?: string } | undefined;
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

  // NOTE: live context-window usage (data.contextPct) is intentionally NOT read
  // here — it comes from the JSON Claude Code pipes to `statusline print` on stdin,
  // not from the DB. The old "platform N%" segment read rate_usage.token_count,
  // which only Veto's own tools increment, so it sat frozen during normal use. That
  // segment was removed; printStatusline() overlays the real per-render number.

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

  // Live "headroom" gauges from Claude Code's stdin payload. All three warn as they
  // fill up — yellow ≥70, red ≥90 — since each is a budget you're consuming.
  const gauge = (prefix: string, pct: number) => {
    const label = `${prefix} ${pct}%`;
    const code = pct >= 90 ? ANSI.red : pct >= 70 ? ANSI.yellow : '';
    return code ? paint(label, code) : label;
  };
  if (data.contextPct !== null) segments.push(gauge('ctx', data.contextPct)); // context-window used
  if (data.rate5hPct !== null) segments.push(gauge('5h', data.rate5hPct));     // 5-hour rate limit used
  if (data.rate7dPct !== null) segments.push(gauge('7d', data.rate7dPct));     // weekly rate limit used

  if (data.memCount !== null) {
    segments.push(`mem ${data.memCount}`);
  }

  if (segments.length === 0) return head; // neutral fallback
  return `${head} ${segments.join(' · ')}`;
}

// ─── Live session input (Claude Code stdin) ───────────────────────────────────

// Claude Code pipes a JSON payload to the `statusLine` command on every render.
// We read the pre-computed context-window usage plus the live rate-limit gauges;
// everything else is ignored. See https://code.claude.com/docs/en/statusline.
export interface ClaudeStatusInput {
  context_window?: { used_percentage?: number | null } | null;
  rate_limits?: {
    five_hour?: { used_percentage?: number | null } | null;
    seven_day?: { used_percentage?: number | null } | null;
  } | null;
  // Claude Code sends the active workspace; used to scope the council verdict segment.
  workspace?: { current_dir?: string | null; project_dir?: string | null } | null;
  cwd?: string | null;
}

export interface ClaudeLiveData {
  contextPct: number | null;
  rate5hPct: number | null;
  rate7dPct: number | null;
}

// Coerce a payload percentage to a clean 0..100 integer, or null for anything
// unexpected (missing, null early in the session / right after /compact, NaN).
function pctOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

// Parse all live gauges from the stdin payload in one pass. Never throws — bad/empty
// JSON yields all-null so every segment simply drops rather than showing a wrong value.
export function parseClaudeInput(raw: string): ClaudeLiveData {
  try {
    const j = JSON.parse(raw) as ClaudeStatusInput;
    return {
      contextPct: pctOrNull(j?.context_window?.used_percentage),
      rate5hPct: pctOrNull(j?.rate_limits?.five_hour?.used_percentage),
      rate7dPct: pctOrNull(j?.rate_limits?.seven_day?.used_percentage),
    };
  } catch {
    return { contextPct: null, rate5hPct: null, rate7dPct: null };
  }
}

// Focused helper kept for callers that only need context usage.
export function parseClaudeContextPct(raw: string): number | null {
  return parseClaudeInput(raw).contextPct;
}

// Extract the active workspace directory from the stdin payload so the council verdict
// can be scoped to it. Prefers workspace.current_dir, then workspace.project_dir, then
// top-level cwd. Returns null (→ global verdict) for bad/empty JSON or a missing field.
export function parseClaudeCwd(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as ClaudeStatusInput;
    const dir = j?.workspace?.current_dir ?? j?.workspace?.project_dir ?? j?.cwd;
    return typeof dir === 'string' && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

// Read the stdin payload Claude Code sends. Crash-proof and never blocks the prompt:
// returns null immediately when run from a TTY (manual invocation) and bails after a
// short timeout if no data arrives. Claude Code closes stdin after writing, so the
// 'end' path is the normal case.
function readStdinPayload(timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) { resolve(null); return; }
    let data = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    try {
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => { clearTimeout(timer); done(data || null); });
      stdin.on('error', () => { clearTimeout(timer); done(null); });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

// The hot path: read DB + live stdin, render, print. Never throws, always exits 0.
// `capturePath` (the `--capture <file>` flag) is a verification aid: it appends the
// raw payload Claude Code sent and the line we rendered, so you can diff the ACTUAL
// context_window.used_percentage against the displayed `ctx N%`. Never on by default.
export async function printStatusline(opts: ComposeOptions = {}, capturePath?: string): Promise<void> {
  // Read the live payload first so we know the active workspace before the DB read —
  // that lets us scope the council verdict to the current project rather than showing
  // the globally-newest debate (which may belong to another folder).
  let raw: string | null = null;
  try { raw = await readStdinPayload(); } catch { /* no live data */ }
  const projectDir = raw ? parseClaudeCwd(raw) : null;

  let data: StatuslineData;
  try { data = readStatuslineData(projectDir ?? undefined); } catch { data = { ...EMPTY }; }

  try {
    if (raw) data = { ...data, ...parseClaudeInput(raw) };
  } catch { /* live segments stay null */ }

  let line: string;
  try { line = composeStatusline(data, opts); } catch { line = composeStatusline(EMPTY, opts); }

  if (capturePath) {
    // Best-effort, never blocks or crashes the render.
    try {
      const actual = raw ? (() => { try { return JSON.parse(raw).context_window?.used_percentage ?? null; } catch { return null; } })() : null;
      appendFileSync(
        capturePath,
        `${new Date().toISOString()}\tactual_used_percentage=${actual}\trendered=${JSON.stringify(line)}\tpayload=${raw ?? '<none>'}\n`,
        'utf8',
      );
    } catch { /* capture is diagnostic only */ }
  }

  // Flush before returning so the caller can exit immediately without truncating
  // output. A statusLine command runs on every prompt render; the process must not
  // linger holding an open stdin handle if the parent keeps the pipe open (the line
  // still prints on time regardless — see the 200ms timeout in readStdinPayload).
  await new Promise<void>((resolve) => {
    try { process.stdout.write(line + '\n', () => resolve()); }
    catch { resolve(); }
  });
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

// The statusLine command invokes bare `veto` — a hot path that can't afford npx,
// so it needs the global install's PATH shim. Best-effort check; never throws.
function bareVetoOnPath(): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where veto' : 'command -v veto';
    execSync(probe, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

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

  const pathWarning = bareVetoOnPath()
    ? ''
    : `\n  ⚠ bare \`veto\` is not on PATH — the statusline will render nothing until you run: npm i -g @jigyasudham/veto`;

  return {
    ok: true,
    changed: true,
    backupPath,
    message: `Installed Veto statusline for ${target.name}.\n  ${settingsPath}\n  backup: ${backupPath}`
      + (current !== undefined ? `\n  (replaced your previous statusLine — restored on uninstall)` : ``)
      + pathWarning,
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

// Cheap, DB-free "is our statusLine wired into settings.json?" check. Safe to call
// at server startup — never throws, never opens the DB.
export function isStatuslineInstalled(client = 'claude'): boolean {
  const target = resolveClient(client);
  if (!target || !existsSync(target.settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(target.settingsPath, 'utf8')) as Record<string, unknown>;
    return isOurStatusLine(settings.statusLine);
  } catch {
    return false;
  }
}

export function statuslineStatusInfo(client = 'claude'): { installed: boolean; settingsPath: string | null; sample: string } {
  const target = resolveClient(client);
  const sample = composeStatusline(readStatuslineData());
  if (!target) return { installed: false, settingsPath: null, sample };
  return { installed: isStatuslineInstalled(client), settingsPath: target.settingsPath, sample };
}

// First-run setup nudge surfaced to the agent through the MCP server `instructions`
// field. An MCP server speaks JSON-RPC over stdio — it can't print a `[y/N]` prompt
// or read a keystroke — so the protocol-correct way to "ask on first connect" is to
// hand the offer to the agent, which asks the user and runs the install on consent.
// Returns undefined once the statusline is installed, so the nudge self-resolves and
// stops appearing. We never edit settings.json without the user agreeing.
export function statuslineSetupInstruction(client = 'claude'): string | undefined {
  if (isStatuslineInstalled(client)) return undefined;
  return [
    'SETUP TIP — Veto status line (mention once per session; drop it if the user declines).',
    'Veto ships an always-on status line for Claude Code that renders beneath the prompt',
    '(latest council verdict · top router-pattern confidence · daily token-budget % · memory',
    'entry count). It is NOT yet enabled in this install. If the user would like it, offer to',
    'run `veto statusline install` for them — it backs up settings.json and is reversible with',
    '`veto statusline uninstall`, and the line appears after the next CLI restart. Do not',
    'install it unless the user agrees.',
  ].join(' ');
}
