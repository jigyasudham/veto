// Session discovery for CLIs without a statusline mapping (v3.2; Claude added
// as a fallback in 3.3.x, for installs that never enabled the Veto statusline;
// Antigravity CLI added in 3.8.0).
//
// Claude Code renders a statusline on every turn and hands Veto both its session
// id and transcript path, so `mapping.ts` just UPSERTs what it is given. Codex,
// Gemini and Antigravity expose no such hook — Veto only runs inside them as an
// MCP server, which never sees the host's own transcript path. So for those the mapping
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
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { recordSessionMapping } from './mapping.js';
import { claudeProjectsDir, claudeProjectSlug, sameClaudeSlug } from './claude-paths.js';
import { projectKey } from './project-key.js';
import type { TranscriptSource } from './adapters/index.js';

// Newest-first cap on how many session files one discovery pass will inspect.
const MAX_CANDIDATES = 40;
// Enough to cover a Codex session_meta line (which embeds the base instructions)
// or a Gemini header line, without reading a multi-MB transcript.
const HEAD_BYTES = 256 * 1024;

export type DiscoveredSession = {
  source: TranscriptSource;
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

/** Antigravity CLI's data folder. It lives inside Gemini's, so GEMINI_DIR moves it too. */
export function antigravityDir(): string {
  return join(process.env.GEMINI_DIR ?? join(homedir(), '.gemini'), 'antigravity-cli');
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
 * A workspace URI as Antigravity records it — file:///D:/Veto,
 * file:///d%3A/Job%20automation — as a folder path. Written out rather than
 * fileURLToPath so a Windows path decodes the same on every OS (tests run on Linux).
 */
export function workspaceUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  let p: string;
  try { p = decodeURIComponent(uri.slice('file://'.length)); } catch { return null; }
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return p || null;
}

type AntigravityConversation = { id: string; projectDir: string | null };

const _require = createRequire(import.meta.url);

/**
 * Antigravity's own index of its conversations, from conversation_summaries.db:
 * the id, the workspace, and whether another conversation started it. Opened
 * read-only; null when it cannot be read, so the caller falls back.
 */
function antigravityIndex(root: string): AntigravityConversation[] | null {
  const path = join(root, 'conversation_summaries.db');
  if (!existsSync(path)) return null;
  let db: import('node:sqlite').DatabaseSync | null = null;
  try {
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('SELECT * FROM conversation_summaries').all() as Array<Record<string, unknown>>;
    const out: AntigravityConversation[] = [];
    for (const r of rows) {
      const id = typeof r.conversation_id === 'string' ? r.conversation_id : null;
      if (!id || !UUID_RE.test(id)) continue;
      // The same table lists the Antigravity IDE's conversations, whose folders
      // live elsewhere; a nested conversation belongs to the one that started it.
      if (typeof r.app_data_dir === 'string' && r.app_data_dir && r.app_data_dir !== 'antigravity-cli') continue;
      if (typeof r.parent_conversation_id === 'string' && r.parent_conversation_id) continue;
      let projectDir: string | null = null;
      try {
        const uris = typeof r.workspace_uris === 'string' && r.workspace_uris ? JSON.parse(r.workspace_uris) as unknown : [];
        if (Array.isArray(uris) && typeof uris[0] === 'string') projectDir = workspaceUriToPath(uris[0]);
      } catch { projectDir = null; }
      out.push({ id, projectDir });
    }
    return out;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * The fallback when the index cannot be read: the conversation folders, with the
 * workspace from history.jsonl — which names it for conversations typed at the
 * prompt but not for `agy -p` runs (those stay unmapped rather than guessed).
 */
function antigravityFolders(root: string): AntigravityConversation[] {
  const workspace = new Map<string, string>();
  try {
    for (const line of readFileSync(join(root, 'history.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (typeof o.conversationId === 'string' && typeof o.workspace === 'string' && o.workspace) workspace.set(o.conversationId, o.workspace);
      } catch { /* one bad line */ }
    }
  } catch { /* no history */ }
  let names: string[];
  try { names = readdirSync(join(root, 'brain')); } catch { return []; }
  return names.filter(n => UUID_RE.test(n)).map(id => ({ id, projectDir: workspace.get(id) ?? null }));
}

/**
 * Antigravity CLI: ~/.gemini/antigravity-cli/brain/<conversation-id>/
 * .system_generated/logs/transcript_full.jsonl. The conversation id is the folder
 * name and the workspace comes from Antigravity's own index (see above). An
 * empty transcript — older conversations kept only a binary log — has nothing
 * to recall and is skipped.
 */
export function discoverAntigravitySessions(limit = MAX_CANDIDATES): DiscoveredSession[] {
  const root = antigravityDir();
  if (!existsSync(root)) return [];
  const conversations = antigravityIndex(root) ?? antigravityFolders(root);
  const byPath = new Map<string, AntigravityConversation>();
  for (const c of conversations) {
    const logs = join(root, 'brain', c.id, '.system_generated', 'logs');
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const path = join(logs, name);
      try { if (statSync(path).size > 0) { byPath.set(path, c); break; } } catch { /* not written */ }
    }
  }
  return newestFirst([...byPath.keys()], limit).map(({ path, mtimeMs }) => {
    const c = byPath.get(path)!;
    return { source: 'antigravity' as const, sourceSessionId: c.id, transcriptPath: path, projectDir: c.projectDir, mtimeMs };
  });
}

const CLAUDE_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Claude Code: ~/.claude/projects/<slug>/<session-uuid>.jsonl. The statusline
 * maps the live session exactly, but only where it is installed; without it
 * nothing mapped Claude sessions at all and capture archived nothing, silently.
 * This finds the project's own folder(s) by slug (D--Veto and d--Veto are one
 * folder on Windows) and lists their top-level session files, newest first.
 * Subagent side chains live in nested folders and are not sessions.
 */
export function discoverClaudeSessions(projectDir: string, limit = MAX_CANDIDATES): DiscoveredSession[] {
  const root = claudeProjectsDir();
  const slug = claudeProjectSlug(projectDir);
  let folders;
  try { folders = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || !sameClaudeSlug(folder.name, slug)) continue;
    let names;
    try { names = readdirSync(join(root, folder.name)); } catch { continue; }
    for (const name of names) if (CLAUDE_SESSION_FILE_RE.test(name)) files.push(join(root, folder.name, name));
  }
  return newestFirst(files, limit).map(({ path, mtimeMs }) => ({
    source: 'claude' as const,
    sourceSessionId: basename(path, '.jsonl'),
    transcriptPath: path,
    projectDir,
    mtimeMs,
  }));
}

/**
 * Discover and record mappings for one source. Best-effort: never throws.
 * Claude's discovery is per project, so it needs the project's folder.
 *
 * When two files claim the same session id — Gemini's Antigravity stub sessions
 * all report the literal id "a2a-server" — the newest file wins, so the mapping
 * is deterministic instead of depending on directory order.
 */
export function discoverSessions(source: TranscriptSource, limit = MAX_CANDIDATES, projectDir?: string | null): DiscoverResult {
  let sessions: DiscoveredSession[] = [];
  try {
    if (source === 'claude') sessions = projectDir ? discoverClaudeSessions(projectDir, limit) : [];
    else if (source === 'codex') sessions = discoverCodexSessions(limit);
    else if (source === 'gemini') sessions = discoverGeminiSessions(limit);
    else sessions = discoverAntigravitySessions(limit);
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
  const want = projectKey(projectDir);
  return sessions.some(s => s.projectDir && projectKey(s.projectDir) === want);
}
