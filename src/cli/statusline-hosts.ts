// A Veto status line for AI CLIs that cannot run one (Codex, Gemini).
//
// Claude Code runs a statusLine command on every render and pipes it live data.
// Codex (0.154) and Gemini only offer built-in status/footer items; neither can
// run a command or show custom text (openai/codex#20244 asks for it). So Veto
// reads the host's own session files instead, read-only, and `veto statusline
// watch` redraws the line in a small split pane beside the AI.
//
// What each host's files give:
//   • Codex: the newest rollout's last `token_count` event carries the context
//     used against the model's window and the live rate-limit percentages.
//   • Gemini: which session is live; its chat log carries no usage figures, so
//     no gauges are shown rather than guessed.
//   • Claude Code: which session is live (its own status line has the gauges).

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { discoverClaudeSessions, discoverCodexSessions, discoverGeminiSessions, type DiscoveredSession } from '../transcripts/discover.js';
import { projectKey, projectKeySql } from '../transcripts/project-key.js';
import { transcriptsDbPath } from '../transcripts/store.js';
import { composeStatusline, readStatuslineData, type ComposeOptions, type StatuslineData } from './statusline.js';

const _require = createRequire(import.meta.url);

export type WatchHost = 'claude' | 'codex' | 'gemini';

export type HostLive = {
  host: WatchHost;
  session: string | null;
  lastActiveMs: number | null;
  contextPct: number | null;
  rate5hPct: number | null;
  rate7dPct: number | null;
};

const TAIL_BYTES = 256 * 1024;
const CANDIDATES = 40;

function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const pct = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;

type CodexRateWindow = { used_percent?: unknown; window_minutes?: unknown } | null | undefined;
type CodexTokenCount = {
  info?: { last_token_usage?: { total_tokens?: unknown } | null; model_context_window?: unknown } | null;
  rate_limits?: { primary?: CodexRateWindow; secondary?: CodexRateWindow } | null;
};

/** Gauges from the last `token_count` event in a Codex rollout's tail. */
export function codexGauges(tail: string): Pick<HostLive, 'contextPct' | 'rate5hPct' | 'rate7dPct'> {
  const out = { contextPct: null as number | null, rate5hPct: null as number | null, rate7dPct: null as number | null };
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    let payload: CodexTokenCount;
    try {
      const o = JSON.parse(line) as { type?: string; payload?: CodexTokenCount & { type?: string } };
      if (o.type !== 'event_msg' || o.payload?.type !== 'token_count') continue;
      payload = o.payload;
    } catch { continue; } // the tail's first line is usually cut mid-record
    const used = payload.info?.last_token_usage?.total_tokens;
    const windowSize = payload.info?.model_context_window;
    if (typeof used === 'number' && typeof windowSize === 'number' && windowSize > 0) out.contextPct = pct((used / windowSize) * 100);
    for (const w of [payload.rate_limits?.primary, payload.rate_limits?.secondary]) {
      const minutes = typeof w?.window_minutes === 'number' ? w.window_minutes : null;
      if (minutes === null) continue;
      if (minutes <= 6 * 60) out.rate5hPct = pct(w?.used_percent);
      else if (minutes >= 6 * 24 * 60) out.rate7dPct = pct(w?.used_percent);
    }
    return out;
  }
  return out;
}

function sessionsFor(host: WatchHost, projectDir: string): DiscoveredSession[] {
  try {
    if (host === 'claude') return discoverClaudeSessions(projectDir, CANDIDATES);
    const want = projectKey(projectDir);
    const all = host === 'codex' ? discoverCodexSessions(CANDIDATES) : discoverGeminiSessions(CANDIDATES);
    return all.filter(s => s.projectDir && projectKey(s.projectDir) === want);
  } catch {
    return [];
  }
}

/** The host's most recently active session in this folder, and its gauges where the host writes them. */
export function readHostLive(host: WatchHost, projectDir: string): HostLive {
  const newest = sessionsFor(host, projectDir).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const live: HostLive = { host, session: newest?.sourceSessionId ?? null, lastActiveMs: newest?.mtimeMs ?? null, contextPct: null, rate5hPct: null, rate7dPct: null };
  if (newest && host === 'codex') Object.assign(live, codexGauges(readTail(newest.transcriptPath)));
  return live;
}

/** Which AI is working in this folder right now: the one whose session file changed last. */
export function detectWatchHost(projectDir: string): WatchHost {
  let best: { host: WatchHost; mtime: number } = { host: 'codex', mtime: -1 };
  for (const host of ['codex', 'gemini', 'claude'] as const) {
    const newest = sessionsFor(host, projectDir).reduce((m, s) => Math.max(m, s.mtimeMs), -1);
    if (newest > best.mtime) best = { host, mtime: newest };
  }
  return best.host;
}

export function formatAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** This folder's archived chats, read-only, so a watcher never contends with capture. */
export function countProjectChats(projectDir: string): number | null {
  try {
    const path = transcriptsDbPath();
    if (!existsSync(path)) return null;
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 50');
      const row = db.prepare(`SELECT COUNT(*) AS n FROM archives WHERE ${projectKeySql('project_dir')} = ?`).get(projectKey(projectDir)) as { n?: number } | undefined;
      return typeof row?.n === 'number' ? row.n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function hostStatuslineData(host: WatchHost, projectDir: string, now = Date.now()): StatuslineData {
  const live = readHostLive(host, projectDir);
  return {
    ...readStatuslineData(projectDir),
    contextPct: live.contextPct,
    rate5hPct: live.rate5hPct,
    rate7dPct: live.rate7dPct,
    host: { name: host, session: live.session, age: live.lastActiveMs !== null ? formatAge(live.lastActiveMs, now) : 'no session yet' },
    chats: countProjectChats(projectDir),
  };
}

/** One Veto line for a host that cannot render it itself. */
export function renderHostStatusline(host: WatchHost, projectDir: string, opts: ComposeOptions = {}, now = Date.now()): string {
  return composeStatusline(hostStatuslineData(host, projectDir, now), opts);
}

/** The line, cut to one terminal row when needed (colours are dropped when it is cut). */
function fit(data: StatuslineData, opts: ComposeOptions, columns: number | undefined): string {
  const line = composeStatusline(data, opts);
  if (!columns) return line;
  const plain = composeStatusline(data, { ...opts, color: false });
  return plain.length < columns ? line : `${plain.slice(0, Math.max(0, columns - 2))}…`;
}

/**
 * Redraw the line every `intervalMs` until interrupted. Without an explicit host
 * it follows whichever AI's session in this folder changed last, so one pane
 * serves a user who switches between Codex and Gemini.
 */
export async function watchStatusline(opts: { host?: WatchHost; projectDir: string; intervalMs?: number; compose?: ComposeOptions }): Promise<void> {
  const interval = Math.max(1000, opts.intervalMs ?? 5000);
  const tty = Boolean(process.stdout.isTTY);
  const draw = () => {
    const host = opts.host ?? detectWatchHost(opts.projectDir);
    let line: string;
    try { line = fit(hostStatuslineData(host, opts.projectDir), opts.compose ?? {}, tty ? process.stdout.columns : undefined); }
    catch { line = composeStatusline({ verdict: null, routerPct: null, contextPct: null, rate5hPct: null, rate7dPct: null, memCount: null, noteCount: null }); }
    process.stdout.write(tty ? `\r\x1b[2K${line}` : `${line}\n`);
  };
  draw();
  const timer = setInterval(draw, interval);
  await new Promise<void>((resolve) => {
    const stop = () => { clearInterval(timer); if (tty) process.stdout.write('\n'); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** How to put the line beside a host that cannot show it. Nothing is changed on disk. */
export function watchSetupGuide(host: 'codex' | 'gemini', projectDir: string): string {
  const name = host === 'codex' ? 'Codex' : 'Gemini';
  const cmd = `veto statusline watch --client=${host}`;
  return [
    `${name} cannot run a custom status line (it only shows its own built-in items),`,
    'so the Veto line runs in a small pane beside it and follows its session in this folder.',
    '',
    `  Windows Terminal:  wt -w 0 split-pane -H --size 0.12 -d "${projectDir}" ${cmd}`,
    `  tmux:              tmux split-window -v -l 2 "${cmd}"`,
    `  VS Code:           split the terminal, then run  ${cmd}`,
    '',
    `Without a global install: npx -y --package @jigyasudham/veto@latest ${cmd}`,
    host === 'codex'
      ? 'Shows context and rate-limit use from Codex\'s own session file, the council verdict, memory and archived chats.'
      : 'Shows the live Gemini session, the council verdict, memory and archived chats (Gemini records no usage figures to show).',
  ].join('\n');
}
