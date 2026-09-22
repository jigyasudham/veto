import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, getConfig } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { syncLessonSources } from '../../src/lessons/harvest.js';
import { harvestOnSave } from '../../src/lessons/on-save.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';
import { disableLessonSource } from '../../src/lessons/store.js';
import { runLessonsCommand } from '../../src/cli/lessons.js';
import {
  TRIAL_DAYS, TRIAL_QUALIFYING_SESSIONS, archiveTrialSessions, readRolloutHead, runLessonsTrial, trialStatus,
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
  trialStart = Date.parse(getConfig().lessons.consent_at!);
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

  it(`stops at ${TRIAL_QUALIFYING_SESSIONS} counted sessions`, () => {
    for (let i = 0; i <= TRIAL_QUALIFYING_SESSIONS; i++) rollout({ start: trialStart + (i + 1) * 60_000, messages: ['inline script backslashes'] });
    runLessonsTrial();
    expect(rows()).toHaveLength(TRIAL_QUALIFYING_SESSIONS);
    expect(trialStatus()).toMatchObject({ qualifying: TRIAL_QUALIFYING_SESSIONS, complete: true });
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
    expect(text).toContain(`Trial:        day 1 of ${TRIAL_DAYS} · 2 of ${TRIAL_QUALIFYING_SESSIONS} Codex sessions counted`);
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
