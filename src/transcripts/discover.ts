// Session discovery for the CLIs that have no statusline hook (v3.2).
//
// Claude Code renders a statusline on every turn and hands Veto both its session
// id and transcript path, so `mapping.ts` just UPSERTs what it is given. Codex
// and Gemini expose no such hook — Veto only runs inside them as an MCP server,
// which never sees the host's own transcript path. So for those two the mapping
// has to be DISCOVERED from disk instead: find the session files, read which
// project each belongs to, and record the same session_map rows the statusline
// would have written. Everything downstream (archive → ingest → recall) is then
// identical across all three sources.
//
// Cost control — this runs on the save path, so it must stay cheap and bounded:
//   • candidates are sorted by mtime and capped (MAX_CANDIDATES) — a machine with
//     thousands of old sessions still does a fixed amount of work;
//   • only a bounded HEAD of each file is read, never the whole transcript;
//   • it is best-effort and never throws, exactly like capture itself.

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordSessionMapping } from './mapping.js';
import { normalizeProjectDir } from '../memory/local.js';

// Newest-first cap on how many session files one discovery pass will inspect.
const MAX_CANDIDATES = 40;
// Enough to cover a Codex session_meta line (which embeds the base instructions)
// or a Gemini header line, without reading a multi-MB transcript.
const HEAD_BYTES = 256 * 1024;

export type DiscoveredSession = {
  source: 'codex' | 'gemini';
  sourceSessionId: string;
  transcriptPath: string;
  projectDir: string | null;
  mtimeMs: number;
};

export type DiscoverResult = { scanned: number; recorded: number; sessions: DiscoveredSession[] };

/** Read at most `HEAD_BYTES` from the front of a file (transcripts can be huge). */
function readHead(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** First complete JSON line of a file, or null if the head holds none. */
function firstJsonLine(path: string): Record<string, unknown> | null {
  const head = readHead(path);
  const nl = head.indexOf('\n');
  const line = nl === -1 ? head : head.slice(0, nl);
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' ? o as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function listFiles(dir: string, match: (name: string) => boolean, out: string[], depth = 0): void {
  if (depth > 5 || !existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, match, out, depth + 1);
    else if (match(e.name)) out.push(p);
  }
}

/** Newest-first, capped: the bound that keeps discovery off the critical path. */
function newestFirst(paths: string[], limit = MAX_CANDIDATES): { path: string; mtimeMs: number }[] {
  const withTime: { path: string; mtimeMs: number }[] = [];
  for (const p of paths) {
    try { withTime.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* vanished */ }
  }
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withTime.slice(0, limit);
}

export function codexSessionsDir(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions');
}

export function geminiTmpDir(): string {
  return process.env.GEMINI_DIR ? join(process.env.GEMINI_DIR, 'tmp') : join(homedir(), '.gemini', 'tmp');
}

/**
 * Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 * The session id and the project (`cwd`) both live in the leading session_meta
 * line, so one bounded head-read per file answers both.
 */
export function discoverCodexSessions(limit = MAX_CANDIDATES): DiscoveredSession[] {
  const files: string[] = [];
  listFiles(codexSessionsDir(), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), files);
  const out: DiscoveredSession[] = [];
  for (const { path, mtimeMs } of newestFirst(files, limit)) {
    const first = firstJsonLine(path);
    const payload = first && typeof first.payload === 'object' ? first.payload as Record<string, unknown> : null;
    if (!payload || first?.type !== 'session_meta') continue;
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) continue;
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    out.push({ source: 'codex', sourceSessionId: id, transcriptPath: path, projectDir: cwd, mtimeMs });
  }
  return out;
}

// A real Gemini CLI session names its file after its session UUID
// (session-<ts>-<8 hex>.jsonl) and reports that UUID in the header.
const GEMINI_REAL_FILE_RE = /-[0-9a-f]{8}\.jsonl$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gemini: ~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl, with the real
 * project path in the sibling `<project>/.project_root` file (the directory name
 * itself is a slug or a hash, so it cannot be mapped back on its own).
 *
 * MOST OF THESE FILES ARE NOT SESSIONS. Antigravity's agent-to-agent server
 * drops a header-only stub per project/run, all of them reporting the SAME
 * literal session id, "a2a-server". On this developer's machine that is 2,347 of
 * 2,367 files, and not one contains a single conversation record. They are
 * skipped for two independent reasons: they carry nothing to recall, and one id
 * shared across many projects would otherwise collide in `archives`
 * (UNIQUE(source, source_session_id)) and let one project's mapping overwrite
 * another's. Because the stubs are also the NEWEST files, filtering has to
 * happen before the newest-first cap or the real sessions never survive it.
 */
export function discoverGeminiSessions(limit = MAX_CANDIDATES): DiscoveredSession[] {
  const root = geminiTmpDir();
  if (!existsSync(root)) return [];
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const all: { path: string; projectDir: string | null }[] = [];
  const named: { path: string; projectDir: string | null }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const chats = join(root, d.name, 'chats');
    if (!existsSync(chats)) continue;
    let projectDir: string | null = null;
    const rootFile = join(root, d.name, '.project_root');
    if (existsSync(rootFile)) {
      try { projectDir = readFileSync(rootFile, 'utf8').trim() || null; } catch { projectDir = null; }
    }
    let names;
    try { names = readdirSync(chats); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const entry = { path: join(chats, n), projectDir };
      all.push(entry);
      if (GEMINI_REAL_FILE_RE.test(n)) named.push(entry);
    }
  }

  // The filename filter is a free prefilter, but the header check below is the
  // authority — so if a future rename makes the pattern match nothing, fall back
  // to inspecting everything rather than silently discovering no sessions.
  const files = named.length > 0 ? named : all;
  const byPath = new Map(files.map(f => [f.path, f.projectDir]));
  const out: DiscoveredSession[] = [];
  for (const { path, mtimeMs } of newestFirst(files.map(f => f.path), limit)) {
    const header = firstJsonLine(path);
    const id = header && typeof header.sessionId === 'string' ? header.sessionId : null;
    if (!id || !UUID_RE.test(id)) continue;
    out.push({ source: 'gemini', sourceSessionId: id, transcriptPath: path, projectDir: byPath.get(path) ?? null, mtimeMs });
  }
  return out;
}

/**
 * Discover and record mappings for one source. Best-effort: never throws.
 *
 * When two files claim the same session id — Gemini's Antigravity stub sessions
 * all report the literal id "a2a-server" — the newest file wins, so the mapping
 * is deterministic instead of depending on directory order.
 */
export function discoverSessions(source: 'codex' | 'gemini', limit = MAX_CANDIDATES): DiscoverResult {
  let sessions: DiscoveredSession[] = [];
  try {
    sessions = source === 'codex' ? discoverCodexSessions(limit) : discoverGeminiSessions(limit);
  } catch {
    return { scanned: 0, recorded: 0, sessions: [] };
  }

  const newestById = new Map<string, DiscoveredSession>();
  for (const s of sessions) {
    const prev = newestById.get(s.sourceSessionId);
    if (!prev || s.mtimeMs > prev.mtimeMs) newestById.set(s.sourceSessionId, s);
  }

  let recorded = 0;
  for (const s of newestById.values()) {
    try {
      recordSessionMapping({
        source: s.source,
        sourceSessionId: s.sourceSessionId,
        transcriptPath: s.transcriptPath,
        projectDir: s.projectDir,
        // The transcript's mtime, not now — several sessions are recorded in one
        // pass and capture picks the most recent one for the project.
        lastSeenAt: new Date(s.mtimeMs).toISOString(),
      });
      recorded++;
    } catch { /* mapping is best-effort */ }
  }
  return { scanned: sessions.length, recorded, sessions: [...newestById.values()] };
}

/**
 * Whether any discovered session belongs to `projectDir` — lets the save path
 * skip a capture attempt that could only bind the wrong project's session.
 */
export function hasSessionForProject(sessions: DiscoveredSession[], projectDir: string): boolean {
  const want = normalizeProjectDir(projectDir);
  return sessions.some(s => s.projectDir && normalizeProjectDir(s.projectDir) === want);
}
