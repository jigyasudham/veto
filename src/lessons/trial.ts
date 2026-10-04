// The shadow trial (councils 2ef0124f and 187593c4).
//
// Before Veto gives any AI a note, it has to show that the notes it would give
// are real and useful. So for a while it records, for every Codex session in
// the user's projects, which notes it WOULD have given that session, and gives
// none. An independent judge later scores those records against what each
// session went on to do.
//
// A session is found from Codex's own rollout file, not from Veto's MCP
// handshake: the Codex VS Code extension hosts many conversations in one
// long-lived process, so a handshake marks only the first of them. The choice is
// made against the session's first real request (the prompt, not the context
// Codex injects around it) and against the notes Veto held when the session
// began. The request is read to choose and is never stored.
//
// Nothing here delivers anything, and nothing here may fail a save.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getConfig, isLessonsSharingEnabled, type LessonsConfig, type TrialConfig } from '../memory/config.js';
import { getDb } from '../memory/local.js';
import { isCaptureEnabled } from '../transcripts/config.js';
import { codexSessionsDir } from '../transcripts/discover.js';
import { resolvesOutsideRoot } from './harvest.js';
import { resolveProjectIdentity } from './identity.js';
import { selectLessonsForShadow } from './select.js';

/**
 * The trial these rules belong to. A new id means new rules in this file AND a
 * new sealed pre-registration (council a085b10e); it is never a re-run.
 */
export const TRIAL_ID = 2;
/** The trial disclosure (consent.ts trialDisclosure). Adding to what it promises means bumping this. */
export const TRIAL_CONSENT_VERSION = 1;
/** Trial 2 stops after this many days or this many chosen notes, whichever comes first (owner, 2026-10-04). */
export const TRIAL_DAYS = 70;
export const TRIAL_NOTE_TARGET = 12;

/** The first real request was found within 73 KB in every real rollout measured; this is a hard read limit. */
const HEAD_BYTES = 256 * 1024;
/** A session with no request after this long is recorded as having none, rather than waited on forever. */
const NO_REQUEST_AFTER_MS = 6 * 60 * 60 * 1000;
/** A rollout untouched this long is treated as a finished session and archived whole. */
const ARCHIVE_AFTER_IDLE_MS = 60 * 60 * 1000;
/** This many sessions in a row without a request looks like Codex changed its format, not like chance. */
const DRIFT_RUN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialOutcome =
  | 'selected' | 'no_match' | 'no_request' | 'no_notes' | 'no_project' | 'project_excluded'
  | 'subagent' | 'before_trial' | 'trial_skipped';

/** Sessions that counted: a request was found, in a project with notes to choose from. The denominator for yield. */
const QUALIFYING: TrialOutcome[] = ['selected', 'no_match'];

// Codex writes the context it injects as role=user messages. Measured on 13
// real rollouts: <environment_context>, the AGENTS.md block, <turn_aborted> and
// <subagent_notification>. None of them is anything the user asked.
const INJECTED_RE = /^\s*(?:<(?:environment_context|user_instructions|turn_aborted|subagent_notification)\b|# AGENTS\.md instructions)/;
// The VS Code extension wraps the user's request in a context block; the request
// follows this heading (34 of 34 such messages measured).
const IDE_RE = /^# Context from my IDE setup/;
const IDE_REQUEST_RE = /^## My request for Codex:?[ \t]*$/m;

export type RolloutHead = {
  sessionId: string;
  cwd: string | null;
  startedAt: number;
  /** A subagent's rollout replays its parent's session; counting it would count one session twice. */
  forked: boolean;
  request: string | null;
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (isObj(part) && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/**
 * The session a rollout records and its first real request, read from the
 * rollout's opening bytes. Null when there is no session_meta to go on. A line
 * cut short by the read limit is simply not parsed.
 */
export function readRolloutHead(text: string): RolloutHead | null {
  let meta: Omit<RolloutHead, 'request'> | null = null;
  let request: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    if (entry.type === 'session_meta' && !meta) {
      const started = Date.parse(String(payload.timestamp ?? entry.timestamp ?? ''));
      if (typeof payload.id !== 'string' || !Number.isFinite(started)) return null;
      meta = {
        sessionId: payload.id,
        cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null,
        startedAt: started,
        forked: typeof payload.forked_from_id === 'string',
      };
      continue;
    }
    if (entry.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
    const said = messageText(payload.content);
    if (INJECTED_RE.test(said)) continue;
    const asked = (IDE_RE.test(said) ? said.split(IDE_REQUEST_RE)[1] ?? '' : said).trim();
    if (asked) { request = asked; break; }
  }
  return meta ? { ...meta, request } : null;
}

function readHead(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

export type TrialWindow = { startedAt: number; endsAt: number };

/** The trial runs from when the user started it (`veto lessons trial`), for TRIAL_DAYS. Sharing consent alone never opens it. */
export function trialWindow(config: LessonsConfig = getConfig().lessons): TrialWindow | null {
  const trial = config.trial;
  if (!isLessonsSharingEnabled(config) || !trial || trial.id !== TRIAL_ID || trial.consent_version !== TRIAL_CONSENT_VERSION || !trial.started_at) return null;
  const startedAt = Date.parse(trial.started_at);
  if (!Number.isFinite(startedAt)) return null;
  return { startedAt, endsAt: startedAt + TRIAL_DAYS * DAY_MS };
}

/**
 * Rollouts in the dated folders the window can touch, oldest first. Codex names
 * its folders by local date, so a day either side is included; the session's
 * own start time decides whether it is in the trial.
 */
function rolloutFiles(root: string, from: number, to: number): string[] {
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let day = Math.floor(from / DAY_MS) * DAY_MS - DAY_MS; day <= to + DAY_MS; day += DAY_MS) {
    const d = new Date(day);
    const dir = join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(join(dir, name));
  }
  return out;
}

// `veto api snapshot` reads a database without migrating it, so a 3.8.0 table
// may have no trial_id yet; every row in it is trial 1.
function hasTrialId(): boolean {
  return (getDb().prepare('PRAGMA table_info(lesson_trial_sessions)').all() as Array<{ name: string }>).some(c => c.name === 'trial_id');
}
const thisTrial = (): string => (hasTrialId() ? `trial_id = ${TRIAL_ID}` : '0');

/** Chosen notes so far: each note in each selected session, counted when the session was recorded. */
export function chosenNoteCount(): number {
  return (getDb().prepare(`SELECT lesson_ids FROM lesson_trial_sessions WHERE ${thisTrial()} AND outcome = 'selected'`).all() as Array<{ lesson_ids: string }>)
    .reduce((sum, row) => sum + (JSON.parse(row.lesson_ids) as string[]).length, 0);
}

/** The notes the judge scores: the first TRIAL_NOTE_TARGET, by session start, then session id, then rank (pre-registration §2). */
export function scoredTrialNotes(): Array<{ sessionId: string; lessonId: string; rank: number }> {
  const sessions = getDb().prepare(`SELECT source_session_id, lesson_ids FROM lesson_trial_sessions WHERE ${thisTrial()} AND outcome = 'selected'
    ORDER BY started_at, source_session_id`).all() as Array<{ source_session_id: string; lesson_ids: string }>;
  return sessions
    .flatMap(s => (JSON.parse(s.lesson_ids) as string[]).map((lessonId, rank) => ({ sessionId: s.source_session_id, lessonId, rank })))
    .slice(0, TRIAL_NOTE_TARGET);
}

/** Sessions recorded by trial 1, the automatic trial of 3.6.0–3.8.0. */
export function trialOneSessions(): number {
  const where = hasTrialId() ? 'trial_id = 1' : '1';
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM lesson_trial_sessions WHERE ${where} AND outcome NOT IN ('subagent', 'before_trial')`).get() as { n: number }).n;
}

/** Trial-2 records exist but no trial is running: the config was damaged or edited (council a085b10e, K8). */
export function trialStalled(): boolean {
  if (trialWindow()) return false;
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM lesson_trial_sessions WHERE ${thisTrial()}`).get() as { n: number }).n > 0;
}

function skippedBy(trial: TrialConfig | null, identity: string): boolean {
  if (!trial) return false;
  if (trial.ignore.some(p => p.identity === identity)) return true;
  return trial.use.length > 0 && !trial.use.some(p => p.identity === identity);
}

type Recorded = {
  head: RolloutHead; path: string; outcome: TrialOutcome; identity?: string | null; lessonIds?: string[];
  tokens?: number; pool?: number; changed?: number; captureOn: boolean;
};

function record(r: Recorded): void {
  getDb().prepare(`INSERT OR IGNORE INTO lesson_trial_sessions
      (source_session_id, source_cli, rollout_path, project_identity, project_label, started_at, outcome, lesson_ids,
       estimated_tokens, pool_size, changed_since_start, archive_state, logged_at, trial_id)
    VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.head.sessionId, r.path, r.identity ?? null, r.head.cwd ? basename(r.head.cwd.replace(/[\\/]+$/, '')) || r.head.cwd : null,
      new Date(r.head.startedAt).toISOString(), r.outcome, JSON.stringify(r.lessonIds ?? []), r.tokens ?? 0, r.pool ?? 0, r.changed ?? 0,
      r.captureOn ? 'pending' : 'capture_off', new Date().toISOString(), TRIAL_ID);
}

export type TrialPassReport = { logged: number; waiting: number; notReached: number };

/**
 * Record every Codex session the trial has not seen yet. A budget, when given,
 * is checked before each rollout, and whatever is not reached waits for the
 * next pass. A session whose request has not been written yet is left alone
 * until it has one, or until it is old enough to say it never will.
 */
export function runLessonsTrial(options: { budgetMs?: number; now?: number; captureOn?: boolean } = {}): TrialPassReport {
  const report: TrialPassReport = { logged: 0, waiting: 0, notReached: 0 };
  const window = trialWindow();
  if (!window) return report;
  const began = Date.now();
  const now = options.now ?? Date.now();
  const captureOn = options.captureOn ?? isCaptureEnabled();
  const root = codexSessionsDir();
  const db = getDb();
  const seen = new Set((db.prepare('SELECT rollout_path FROM lesson_trial_sessions').all() as Array<{ rollout_path: string }>).map(r => r.rollout_path));
  const files = rolloutFiles(root, window.startedAt, Math.min(now, window.endsAt)).filter(path => !seen.has(path));
  const trial = getConfig().lessons.trial;
  let chosen = chosenNoteCount();

  for (let i = 0; i < files.length; i++) {
    if (options.budgetMs !== undefined && Date.now() - began >= options.budgetMs) { report.notReached = files.length - i; break; }
    // Checked before every session, so one pass stops at the session that reached the target (council a085b10e, K2).
    if (chosen >= TRIAL_NOTE_TARGET) break;
    const path = files[i];
    if (resolvesOutsideRoot(path, root)) continue;
    const head = readRolloutHead(readHead(path));
    if (!head || head.startedAt > window.endsAt) continue;
    if (db.prepare('SELECT 1 FROM lesson_trial_sessions WHERE source_session_id = ?').get(head.sessionId)) continue;

    const base = { head, path, captureOn };
    if (head.forked) { record({ ...base, outcome: 'subagent' }); report.logged++; continue; }
    if (head.startedAt < window.startedAt) { record({ ...base, outcome: 'before_trial' }); report.logged++; continue; }
    if (!head.cwd) { record({ ...base, outcome: 'no_project' }); report.logged++; continue; }
    const identity = resolveProjectIdentity(head.cwd);
    // An ignored project is recorded and never chosen for; its request is not used (pre-registration §2).
    if (skippedBy(trial, identity)) { record({ ...base, outcome: 'trial_skipped', identity }); report.logged++; continue; }
    if (!head.request) {
      if (now - head.startedAt < NO_REQUEST_AFTER_MS) { report.waiting++; continue; }
      record({ ...base, outcome: 'no_request', identity });
      report.logged++;
      continue;
    }

    const choice = selectLessonsForShadow({ query: head.request, targetProjectDir: head.cwd, targetHost: 'codex', asOf: head.startedAt });
    if (choice.reason === 'consent_off') break;
    const outcome: TrialOutcome = choice.reason === 'project_excluded' ? 'project_excluded'
      : choice.poolSize === 0 ? 'no_notes'
      : choice.reason;
    record({
      ...base, outcome, identity: choice.targetProjectIdentity, lessonIds: choice.lessonIds,
      tokens: choice.estimatedTokens, pool: choice.poolSize, changed: choice.changedSinceStart,
    });
    report.logged++;
    if (outcome === 'selected') chosen += choice.lessonIds.length;
  }
  return report;
}

/**
 * Keep the judge's evidence: archive each finished trial session through
 * transcript capture, which has its own consent. With capture off a row says
 * so, and is archived later if capture is turned on. Never throws.
 */
export async function archiveTrialSessions(options: { now?: number } = {}): Promise<number> {
  let archived = 0;
  try {
    if (!trialWindow()) return 0;
    const db = getDb();
    const rows = db.prepare(`SELECT source_session_id, rollout_path, archive_state FROM lesson_trial_sessions
      WHERE ${thisTrial()} AND archive_state IN ('pending', 'capture_off') AND outcome NOT IN ('subagent', 'before_trial', 'trial_skipped')`).all() as Array<{ source_session_id: string; rollout_path: string; archive_state: string }>;
    if (!rows.length) return 0;
    const set = db.prepare('UPDATE lesson_trial_sessions SET archive_state = ? WHERE source_session_id = ?');
    const captureOn = isCaptureEnabled();
    const now = options.now ?? Date.now();
    for (const row of rows) {
      if (!captureOn) { if (row.archive_state !== 'capture_off') set.run('capture_off', row.source_session_id); continue; }
      let mtime: number;
      try { mtime = statSync(row.rollout_path).mtimeMs; } catch { set.run('failed', row.source_session_id); continue; }
      if (now - mtime < ARCHIVE_AFTER_IDLE_MS) continue;
      try {
        const { recordSessionMapping } = await import('../transcripts/mapping.js');
        const { captureSession } = await import('../transcripts/archive.js');
        recordSessionMapping({ source: 'codex', sourceSessionId: row.source_session_id, transcriptPath: row.rollout_path, lastSeenAt: new Date(mtime).toISOString() });
        const result = await captureSession({ source: 'codex', sourceSessionId: row.source_session_id });
        const ok = result.status === 'archived' || result.status === 'unchanged';
        set.run(ok ? 'archived' : 'failed', row.source_session_id);
        if (ok) archived++;
      } catch { set.run('failed', row.source_session_id); }
    }
  } catch { /* evidence-keeping is best-effort; it must never surface in a save */ }
  return archived;
}

export type TrialStatus = {
  trialId: number;
  startedAt: string;
  endsAt: string;
  complete: boolean;
  /** Sessions that counted (selected or no_match): the denominator for yield. */
  qualifying: number;
  /** Where the trial stops, in the unit stopOn names. */
  target: number;
  stopOn: 'notes';
  notesChosen: number;
  skipped: number;
  byOutcome: Partial<Record<TrialOutcome, number>>;
  archived: number;
  /** Several sessions in a row with no request found: probably a Codex format change, not chance. */
  drift: boolean;
};

export function trialStatus(now = Date.now()): TrialStatus | null {
  const window = trialWindow();
  if (!window) return null;
  const db = getDb();
  const byOutcome: Partial<Record<TrialOutcome, number>> = {};
  const scope = thisTrial();
  for (const row of db.prepare(`SELECT outcome, COUNT(*) AS n FROM lesson_trial_sessions WHERE ${scope} GROUP BY outcome`).all() as Array<{ outcome: TrialOutcome; n: number }>) {
    byOutcome[row.outcome] = row.n;
  }
  const qualifying = QUALIFYING.reduce((sum, outcome) => sum + (byOutcome[outcome] ?? 0), 0);
  const recent = (db.prepare(`SELECT outcome FROM lesson_trial_sessions WHERE ${scope} AND outcome NOT IN ('subagent', 'before_trial', 'trial_skipped')
    ORDER BY started_at DESC LIMIT ?`).all(DRIFT_RUN) as Array<{ outcome: TrialOutcome }>).map(r => r.outcome);
  const notesChosen = chosenNoteCount();
  return {
    trialId: TRIAL_ID,
    startedAt: new Date(window.startedAt).toISOString(),
    endsAt: new Date(window.endsAt).toISOString(),
    complete: notesChosen >= TRIAL_NOTE_TARGET || now > window.endsAt,
    qualifying,
    target: TRIAL_NOTE_TARGET,
    stopOn: 'notes',
    notesChosen,
    skipped: byOutcome.trial_skipped ?? 0,
    byOutcome,
    archived: (db.prepare(`SELECT COUNT(*) AS n FROM lesson_trial_sessions WHERE ${scope} AND archive_state = 'archived'`).get() as { n: number }).n,
    drift: recent.length === DRIFT_RUN && recent.every(outcome => outcome === 'no_request'),
  };
}

export type TrialBacklog = {
  /** Codex rollouts in the dated folders the window touches. */
  rollouts: number;
  /** Of those, how many the trial has not examined yet. */
  unexamined: number;
  /** Oldest unexamined rollout's mtime (ISO), when there is one. */
  oldestUnexamined: string | null;
  /** When the trial last recorded anything (ISO), when it has. */
  lastLogged: string | null;
};

/**
 * Read-only view of what the trial has not looked at yet, for `veto doctor`.
 * The trial only advances inside veto_session_save, so sessions pile up here
 * between saves; that is expected, and they are examined on the next save. What
 * this makes visible is a trial that has stopped advancing altogether.
 */
export function trialBacklog(now = Date.now()): TrialBacklog | null {
  const window = trialWindow();
  if (!window) return null;
  const db = getDb();
  const seen = new Set((db.prepare('SELECT rollout_path FROM lesson_trial_sessions').all() as Array<{ rollout_path: string }>).map(r => r.rollout_path));
  const files = rolloutFiles(codexSessionsDir(), window.startedAt, Math.min(now, window.endsAt));
  let oldest: number | null = null;
  let unexamined = 0;
  for (const path of files) {
    if (seen.has(path)) continue;
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (mtime < window.startedAt) continue;
    unexamined++;
    if (oldest === null || mtime < oldest) oldest = mtime;
  }
  const last = db.prepare('SELECT MAX(logged_at) AS t FROM lesson_trial_sessions').get() as { t: string | null };
  return { rollouts: files.length, unexamined, oldestUnexamined: oldest === null ? null : new Date(oldest).toISOString(), lastLogged: last.t };
}

/** `veto lessons off` deletes the whole record. */
export function clearTrialSessions(): number {
  return Number(getDb().prepare('DELETE FROM lesson_trial_sessions').run().changes);
}
