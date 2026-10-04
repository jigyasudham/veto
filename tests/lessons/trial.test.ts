import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, getConfig, setConfig } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { syncLessonSources } from '../../src/lessons/harvest.js';
import { harvestOnSave } from '../../src/lessons/on-save.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';
import { disableLessonSource } from '../../src/lessons/store.js';
import { runLessonsCommand } from '../../src/cli/lessons.js';
import {
  TRIAL_CONSENT_VERSION, TRIAL_DAYS, TRIAL_ID, TRIAL_NOTE_TARGET, archiveTrialSessions, chosenNoteCount, readRolloutHead,
  runLessonsTrial, scoredTrialNotes, trialOneSessions, trialStalled, trialStatus,
} from '../../src/lessons/trial.js';

const FIXTURES = join(__dirname, 'fixtures', 'claude');
const HOUR = 60 * 60 * 1000;
const roots: string[] = [];
const root = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-trial-'))); roots.push(dir); return dir; };

let home: string;
let codexHome: string;
let projectA: string;
let trialStart: number;

type Row = {
  source_session_id: string; outcome: string; lesson_ids: string; pool_size: number; changed_since_start: number;
  project_label: string | null; archive_state: string;
};
const rows = () => getDb().prepare('SELECT * FROM lesson_trial_sessions ORDER BY started_at').all() as Row[];
const outcomes = () => rows().map(r => r.outcome);

// Shaped like real Codex rollouts: session_meta first, then the context Codex
// injects as role=user messages, then whatever the user asked.
const ENVIRONMENT = '<environment_context>\n  <cwd>somewhere</cwd>\n  <shell>powershell</shell>\n</environment_context>';
const AGENTS = '# AGENTS.md instructions for somewhere\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>';
const ide = (request: string) => `# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## Open tabs:\n- app.ts: src/app.ts\n\n## My request for Codex:\n${request}\n`;

let serial = 0;
function rollout(opts: { start: number; cwd?: string | null; messages?: string[]; forked?: boolean; id?: string }): { id: string; path: string } {
  const id = opts.id ?? `019e0000-0000-7000-8000-${String(++serial).padStart(12, '0')}`;
  const at = new Date(opts.start);
  const iso = at.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = join(codexHome, 'sessions', String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate()));
  mkdirSync(dir, { recursive: true });
  const user = (text: string) => ({ timestamp: iso, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const lines = [
    { timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd: opts.cwd === undefined ? projectA : opts.cwd, ...(opts.forked ? { forked_from_id: 'parent' } : {}) } },
    user(ENVIRONMENT),
    ...(opts.messages ?? []).map(user),
  ];
  const path = join(dir, `rollout-${iso.replace(/[:.]/g, '-')}-${id}.jsonl`);
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return { id, path };
}

function startTrial(lists: { use?: Array<{ identity: string; label: string }>; ignore?: Array<{ identity: string; label: string }> } = {}): number {
  const startedAt = new Date().toISOString();
  setConfig({ lessons: { ...getConfig().lessons, trial: { id: TRIAL_ID, consent_version: TRIAL_CONSENT_VERSION, started_at: startedAt, use: lists.use ?? [], ignore: lists.ignore ?? [] } } });
  return Date.parse(startedAt);
}

beforeEach(() => {
  resetDb();
  home = root();
  codexHome = join(home, 'codex');
  process.env.CODEX_HOME = codexHome;
  process.env.VETO_CONFIG_PATH = join(home, 'config.json');
  projectA = join(home, 'code', 'alpha');
  mkdirSync(projectA, { recursive: true });
  const memory = join(home, '.claude', 'projects', claudeProjectSlug(projectA), 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, '..', 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: projectA })}\n`);
  for (const name of ['feedback_quoting_rule.md', 'feedback_server_config.md', 'project_release_gotchas.md']) copyFileSync(join(FIXTURES, name), join(memory, name));
  enableLessonsSharing();
  syncLessonSources(home);
  trialStart = startTrial();
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  delete process.env.CODEX_HOME;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reading a Codex session's first request", () => {
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 's', timestamp: '2026-09-22T10:00:00.000Z', cwd: 'D:\\p' } });
  const user = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

  it('passes over everything Codex injects', () => {
    const head = readRolloutHead([meta, user(ENVIRONMENT), user(AGENTS), user('<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
      user('<subagent_notification>done</subagent_notification>'), user('fix the flaky upload test')].join('\n'));
    expect(head).toMatchObject({ sessionId: 's', cwd: 'D:\\p', forked: false, request: 'fix the flaky upload test' });
    expect(head!.startedAt).toBe(Date.parse('2026-09-22T10:00:00.000Z'));
  });

  it('finds the request inside the IDE context block, and nothing else from it', () => {
    expect(readRolloutHead([meta, user(ENVIRONMENT), user(ide('fix the flaky upload test'))].join('\n'))!.request).toBe('fix the flaky upload test');
  });

  it('says so when there is no request yet, or no session at all', () => {
    expect(readRolloutHead([meta, user(ENVIRONMENT), user(ide('   '))].join('\n'))!.request).toBeNull();
    expect(readRolloutHead(user('fix it'))).toBeNull();
    // A line cut short by the read limit is not an error.
    expect(readRolloutHead(`${meta}\n${user('fix it').slice(0, 40)}`)!.request).toBeNull();
  });
});

describe('the shadow trial', () => {
  it('records which notes a Codex session would have been given, and never what was asked', () => {
    rollout({ start: trialStart + 60_000, messages: [ide('inline script backslashes keep vanishing')] });
    expect(runLessonsTrial()).toMatchObject({ logged: 1 });

    const [row] = rows();
    expect(row).toMatchObject({ outcome: 'selected', project_label: 'alpha', archive_state: 'capture_off' });
    expect(JSON.parse(row.lesson_ids)).toHaveLength(1);
    expect(row.pool_size).toBeGreaterThan(1);
    expect(JSON.stringify(row)).not.toMatch(/vanishing|backslashes/);
  });

  it('tells a request no note fitted apart from a session with no request, and from a project with nothing to give', () => {
    rollout({ start: trialStart + 60_000, messages: ['kubernetes ingress certificate rotation'] });
    rollout({ start: trialStart + 120_000, messages: [AGENTS] });
    rollout({ start: trialStart + 180_000, cwd: null, messages: ['inline script backslashes'] });
    runLessonsTrial({ now: trialStart + 7 * HOUR });
    expect(outcomes()).toEqual(['no_match', 'no_request', 'no_project']);

    disableLessonSource('claude', 'x.md: JSON document where Markdown was expected');
    rollout({ start: trialStart + 240_000, messages: ['inline script backslashes'] });
    runLessonsTrial({ now: trialStart + 7 * HOUR });
    expect(outcomes().at(-1)).toBe('no_notes');
    expect(trialStatus()!.qualifying).toBe(1);
  });

  it('waits for a request that has not been written yet, then gives up on it', () => {
    rollout({ start: trialStart + 60_000 });
    expect(runLessonsTrial({ now: trialStart + HOUR })).toEqual({ logged: 0, waiting: 1, notReached: 0 });
    expect(rows()).toEqual([]);
    expect(runLessonsTrial({ now: trialStart + 7 * HOUR })).toMatchObject({ logged: 1 });
    expect(outcomes()).toEqual(['no_request']);
  });

  it('only counts notes as they were when the session began', () => {
    const start = trialStart + 60_000;
    // The note that would be chosen changed after the session started.
    getDb().prepare("UPDATE lessons SET updated_at = ? WHERE source_path LIKE '%feedback_quoting_rule.md'").run(new Date(start + 1000).toISOString());
    rollout({ start, messages: ['inline script backslashes'] });
    runLessonsTrial();

    const [row] = rows();
    expect(row.outcome).toBe('no_match');
    expect(row.changed_since_start).toBe(1);
  });

  it('relies on updated_at moving only when a note actually changes', () => {
    const sentinel = '2000-01-01T00:00:00.000Z';
    getDb().prepare('UPDATE lessons SET updated_at = ?').run(sentinel);
    syncLessonSources({ home, forced: true });
    expect(new Set((getDb().prepare('SELECT updated_at FROM lessons').all() as Array<{ updated_at: string }>).map(r => r.updated_at))).toEqual(new Set([sentinel]));

    const file = join(home, '.claude', 'projects', claudeProjectSlug(projectA), 'memory', 'feedback_quoting_rule.md');
    writeFileSync(file, '---\nname: q\ndescription: d\ntype: feedback\n---\nA different lesson about quoting entirely.\n');
    syncLessonSources(home);
    const changed = getDb().prepare("SELECT updated_at FROM lessons WHERE source_path LIKE '%feedback_quoting_rule.md'").get() as { updated_at: string };
    expect(changed.updated_at).not.toBe(sentinel);
  });

  it('counts a subagent once, as its parent, and sessions from before the trial not at all', () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    rollout({ start: trialStart + 90_000, forked: true, messages: ['inline script backslashes'] });
    rollout({ start: trialStart - HOUR, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(outcomes().sort()).toEqual(['before_trial', 'selected', 'subagent']);
    expect(trialStatus()!.qualifying).toBe(1);
  });

  it('records each session once, and a budget spent leaves the rest for the next pass', () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    rollout({ start: trialStart + 120_000, messages: ['kubernetes ingress certificate'] });
    expect(runLessonsTrial({ budgetMs: 0 })).toEqual({ logged: 0, waiting: 0, notReached: 2 });
    expect(runLessonsTrial()).toMatchObject({ logged: 2 });
    expect(runLessonsTrial()).toMatchObject({ logged: 0 });
    expect(rows()).toHaveLength(2);
  });

  it('does not start because sharing was accepted', () => {
    setConfig({ lessons: { ...getConfig().lessons, trial: null } });
    rollout({ start: Date.now() + 60_000, messages: ['inline script backslashes'] });
    expect(runLessonsTrial({ now: Date.now() + 2 * 60_000 })).toEqual({ logged: 0, waiting: 0, notReached: 0 });
    expect(trialStatus()).toBeNull();
  });

  it('records a session in an ignored project as skipped, without choosing notes for it', async () => {
    const { resolveProjectIdentity } = await import('../../src/lessons/identity.js');
    trialStart = startTrial({ ignore: [{ identity: resolveProjectIdentity(projectA), label: 'alpha' }] });
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    rollout({ start: trialStart + 120_000 }); // no request yet: still skipped at once, never waited on
    runLessonsTrial({ now: trialStart + 3 * 60_000 });
    expect(outcomes()).toEqual(['trial_skipped', 'trial_skipped']);
    expect(rows().every(r => r.lesson_ids === '[]' && r.pool_size === 0)).toBe(true);
    expect(trialStatus()).toMatchObject({ qualifying: 0, notesChosen: 0, skipped: 2 });
  });

  it('with a use list, skips sessions in any other project', () => {
    trialStart = startTrial({ use: [{ identity: 'git:0000000000000000', label: 'other' }] });
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(outcomes()).toEqual(['trial_skipped']);
  });

  it('skips a session started in a subfolder of an ignored git repository', async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', ['-C', projectA, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
    const { resolveProjectIdentity } = await import('../../src/lessons/identity.js');
    const ignored = resolveProjectIdentity(projectA);
    expect(ignored).toMatch(/^git:/);
    const sub = join(projectA, 'src');
    mkdirSync(sub, { recursive: true });
    trialStart = startTrial({ ignore: [{ identity: ignored, label: 'alpha' }] });
    rollout({ start: trialStart + 60_000, cwd: sub, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(outcomes()).toEqual(['trial_skipped']);
  });

  it(`stops after the session that brings the chosen notes to ${TRIAL_NOTE_TARGET}`, () => {
    for (let i = 0; i < TRIAL_NOTE_TARGET + 3; i++) rollout({ start: trialStart + (i + 1) * 60_000, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(chosenNoteCount()).toBe(TRIAL_NOTE_TARGET);
    expect(rows()).toHaveLength(TRIAL_NOTE_TARGET);
    expect(trialStatus()).toMatchObject({ notesChosen: TRIAL_NOTE_TARGET, target: TRIAL_NOTE_TARGET, stopOn: 'notes', complete: true });
    expect(runLessonsTrial()).toMatchObject({ logged: 0 });
  });

  it('scores only the first 12 notes: by session start, then session id, then rank', () => {
    const db = getDb();
    const insert = db.prepare(`INSERT INTO lesson_trial_sessions (source_session_id, source_cli, rollout_path, started_at, outcome, lesson_ids,
      estimated_tokens, pool_size, changed_since_start, archive_state, logged_at, trial_id) VALUES (?, 'codex', ?, ?, ?, ?, 0, 9, 0, 'pending', ?, ?)`);
    const at = (m: number) => new Date(trialStart + m * 60_000).toISOString();
    insert.run('b', 'pb', at(1), 'selected', JSON.stringify(['b1', 'b2', 'b3', 'b4', 'b5']), at(1), TRIAL_ID);
    insert.run('a', 'pa', at(1), 'selected', JSON.stringify(['a1', 'a2', 'a3', 'a4', 'a5']), at(1), TRIAL_ID);
    insert.run('c', 'pc', at(2), 'selected', JSON.stringify(['c1', 'c2', 'c3']), at(2), TRIAL_ID);
    insert.run('old', 'po', at(0), 'selected', JSON.stringify(['o1']), at(0), 1);
    expect(scoredTrialNotes().map(n => n.lessonId)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5', 'c1', 'c2']);
    expect(scoredTrialNotes()[11]).toEqual({ sessionId: 'c', lessonId: 'c2', rank: 1 });
  });

  it("never counts trial 1's rows, and reports them apart", () => {
    const long = new Date(trialStart - 9e8).toISOString();
    getDb().prepare(`INSERT INTO lesson_trial_sessions (source_session_id, source_cli, rollout_path, started_at, outcome, lesson_ids,
      estimated_tokens, pool_size, changed_since_start, archive_state, logged_at, trial_id) VALUES ('t1', 'codex', 'p1', ?, 'selected', '["x"]', 0, 3, 0, 'pending', ?, 1)`)
      .run(long, long);
    expect(trialStatus()).toMatchObject({ qualifying: 0, notesChosen: 0 });
    expect(trialOneSessions()).toBe(1);
  });

  it('notices trial-2 records with no trial running (a damaged config)', () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(trialStalled()).toBe(false);
    writeFileSync(process.env.VETO_CONFIG_PATH!, '{ not json');
    expect(trialStalled()).toBe(true);
    expect(() => runLessonsTrial()).not.toThrow();
  });

  it(`stops at ${TRIAL_DAYS} days, even for a session in a folder it still reads`, () => {
    const last = trialStart + TRIAL_DAYS * 24 * HOUR - HOUR;
    const late = trialStart + (TRIAL_DAYS * 24 + 12) * HOUR;
    rollout({ start: last, messages: ['inline script backslashes'] });
    rollout({ start: late, messages: ['inline script backslashes'] });
    runLessonsTrial({ now: late + HOUR });
    expect(rows().map(r => Date.parse((r as unknown as { started_at: string }).started_at))).toEqual([last]);
    expect(trialStatus(late + HOUR)!.complete).toBe(true);
  });

  it('records nothing while sharing is off', async () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    const { turnLessonsOff } = await import('../../src/lessons/manage.js');
    turnLessonsOff();
    expect(runLessonsTrial()).toEqual({ logged: 0, waiting: 0, notReached: 0 });
    expect(rows()).toEqual([]);
  });

  it("will not follow a link out of Codex's sessions folder", () => {
    const outside = root();
    const at = new Date(trialStart + 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const month = join(codexHome, 'sessions', String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1));
    mkdirSync(month, { recursive: true });
    const saved = codexHome;
    codexHome = outside;
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    codexHome = saved;
    try {
      symlinkSync(join(outside, 'sessions', String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate())), join(month, pad(at.getUTCDate())), 'junction');
    } catch {
      return; // This machine will not create the link; nothing to test.
    }
    runLessonsTrial();
    expect(rows()).toEqual([]);
  });
});

describe('what the trial shows', () => {
  it('warns when sessions stop yielding a request, which looks like a Codex format change', () => {
    for (let i = 1; i <= 3; i++) rollout({ start: trialStart + i * 60_000, messages: [AGENTS] });
    runLessonsTrial({ now: trialStart + 7 * HOUR });
    expect(trialStatus()!.drift).toBe(true);
  });

  it('appears in veto lessons status', () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    rollout({ start: trialStart + 120_000, messages: ['kubernetes ingress certificate'] });
    const lines: string[] = [];
    runLessonsCommand(['status'], { out: (line = '') => lines.push(line), color: false, home, cwd: projectA });
    const text = lines.join('\n');
    expect(text).toContain(`Trial:        day 1 of ${TRIAL_DAYS} · 1 of ${TRIAL_NOTE_TARGET} notes chosen`);
    expect(text).toContain('1 with notes chosen · 1 with none that fitted');
  });

  it('is brought up to date by a session save, inside the save budget', () => {
    rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
    harvestOnSave({ home });
    expect(outcomes()).toEqual(['selected']);
  });
});

describe("keeping the judge's evidence", () => {
  it('archives a finished session through transcript capture when capture is on, and says so when it is off', async () => {
    process.env.VETO_TRANSCRIPTS_DIR = join(home, 'transcripts');
    const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');
    const { enableCapture } = await import('../../src/transcripts/config.js');
    const { getArchive } = await import('../../src/transcripts/archive.js');
    resetTranscriptsDb();
    try {
      const off = rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
      runLessonsTrial();
      expect(rows()[0].archive_state).toBe('capture_off');

      enableCapture();
      const finished = rollout({ start: trialStart + 120_000, messages: ['kubernetes ingress certificate'] });
      const idle = new Date(Date.now() - 2 * HOUR);
      for (const { path } of [off, finished]) utimesSync(path, idle, idle);
      runLessonsTrial();
      expect(rows()[1].archive_state).toBe('pending');

      expect(await archiveTrialSessions()).toBe(2);
      expect(rows().map(r => r.archive_state)).toEqual(['archived', 'archived']);
      expect(getArchive(finished.id, 'codex')).not.toBeNull();
    } finally {
      resetTranscriptsDb();
      delete process.env.VETO_TRANSCRIPTS_DIR;
    }
  });

  it('leaves a session that is still going until it has stopped changing', async () => {
    process.env.VETO_TRANSCRIPTS_DIR = join(home, 'transcripts');
    const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');
    const { enableCapture } = await import('../../src/transcripts/config.js');
    resetTranscriptsDb();
    try {
      enableCapture();
      rollout({ start: trialStart + 60_000, messages: ['inline script backslashes'] });
      runLessonsTrial();
      expect(await archiveTrialSessions()).toBe(0);
      expect(rows()[0].archive_state).toBe('pending');
    } finally {
      resetTranscriptsDb();
      delete process.env.VETO_TRANSCRIPTS_DIR;
    }
  });
});

describe('a database from before trial 2', () => {
  const recreateOldTable = () => {
    const db = getDb();
    db.exec('DROP TABLE lesson_trial_sessions');
    db.exec(`CREATE TABLE lesson_trial_sessions (source_session_id TEXT PRIMARY KEY, source_cli TEXT NOT NULL, rollout_path TEXT NOT NULL,
      project_identity TEXT, project_label TEXT, started_at TEXT NOT NULL, outcome TEXT NOT NULL, lesson_ids TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL, pool_size INTEGER NOT NULL, changed_since_start INTEGER NOT NULL, archive_state TEXT NOT NULL, logged_at TEXT NOT NULL)`);
    db.exec(`INSERT INTO lesson_trial_sessions VALUES ('s', 'codex', 'p', NULL, NULL, '2026-09-25T00:00:00.000Z', 'selected', '["n"]', 0, 1, 0, 'archived', '2026-09-25T00:00:00.000Z')`);
    return db;
  };

  it('reads an un-migrated table as all trial 1, without throwing', () => {
    recreateOldTable();
    expect(trialStatus()).toMatchObject({ notesChosen: 0, qualifying: 0 });
    expect(trialOneSessions()).toBe(1);
  });

  it('the migration marks existing rows as trial 1 and can run twice', async () => {
    const { migrateLessonTrialId } = await import('../../src/memory/local.js');
    const db = recreateOldTable();
    migrateLessonTrialId(db);
    migrateLessonTrialId(db);
    expect({ ...(db.prepare('SELECT trial_id FROM lesson_trial_sessions').get() as object) }).toEqual({ trial_id: 1 });
  });
});
