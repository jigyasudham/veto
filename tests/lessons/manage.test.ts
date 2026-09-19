import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, isLessonsSharingEnabled } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { syncLessonSources } from '../../src/lessons/harvest.js';
import { addProjectAlias, resolveProjectIdentity } from '../../src/lessons/identity.js';
import {
  excludeProjectDir, explainLesson, findLesson, forgetLesson, includeProjectDir, lessonFlows, lessonReach, recheckSource,
  setProjectAlias, suggestAlias, turnLessonsOff, unresolvedFolders,
} from '../../src/lessons/manage.js';
import { logShadowSelection, selectLessonsForShadow } from '../../src/lessons/select.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';
import type { LessonRow } from '../../src/lessons/store.js';

const FIXTURES = join(__dirname, 'fixtures');
const roots: string[] = [];
const root = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-manage-'))); roots.push(dir); return dir; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', `root of ${dir}`);
  return dir;
}

let home: string;
let projectA: string;
let projectB: string;

function claudeFolder(projectDir: string, files: Record<string, string>, transcript = true): string {
  const memory = join(home, '.claude', 'projects', claudeProjectSlug(projectDir), 'memory');
  mkdirSync(memory, { recursive: true });
  if (transcript) writeFileSync(join(memory, '..', 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: projectDir })}\n`);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(memory, name), content);
  return memory;
}

const fixture = (name: string) => readFileSync(join(FIXTURES, 'claude', name), 'utf8');
const all = () => getDb().prepare('SELECT * FROM lessons ORDER BY source_path, section_anchor').all() as LessonRow[];
const inFile = (name: string) => all().filter(row => row.source_path.endsWith(name));
const one = (name: string, anchor = 'body') => {
  const row = inFile(name).find(r => r.section_anchor === anchor);
  if (!row) throw new Error(`no row for ${name}#${anchor}`);
  return row;
};
const select = (query: string, targetProjectDir: string, targetHost: 'claude' | 'codex' | 'gemini' = 'claude') =>
  selectLessonsForShadow({ query, targetProjectDir, targetHost });

let ceiling: string | undefined;
beforeEach(() => {
  resetDb();
  ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
  home = root();
  process.env.VETO_CONFIG_PATH = join(home, 'config.json');
  projectA = join(home, 'code', 'alpha');
  projectB = join(home, 'code', 'beta');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  claudeFolder(projectA, {
    'feedback_quoting_rule.md': fixture('feedback_quoting_rule.md'),
    'feedback_server_config.md': fixture('feedback_server_config.md'),
    'project_release_gotchas.md': fixture('project_release_gotchas.md'),
  });
  enableLessonsSharing();
  syncLessonSources(home);
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('why a note is where it is', () => {
  it('records the rule that set each scope', () => {
    expect(one('feedback_quoting_rule.md').scope_reason).toBe('feedback-entry');
    expect(one('project_release_gotchas.md', 'console-encoding-cp1252').scope_reason).toBe('environment-heading');
    expect(one('project_release_gotchas.md', 'notes').scope_reason).toBe('project-default');
  });

  it('explains provenance, scope, hold and reach in words', () => {
    const held = explainLesson(one('feedback_server_config.md'));
    expect(held.provenance).toMatch(/^from Claude memory · alpha · \d{4}-\d{2}-\d{2}$/);
    expect(held.scope).toBe('user: Claude saved it as feedback on how to work (type: feedback)');
    expect(held.held).toBe('kept in its own project: it contains a shell or network command');
    expect(held.reach).toBe('alpha only, in Codex and Gemini, and Claude working in another folder');

    const shared = explainLesson(one('feedback_quoting_rule.md'));
    expect(shared.held).toBeNull();
    expect(shared.reach).toMatch(/^any project, in /);
  });

  it('describes reach exactly as selection applies it', () => {
    for (const row of all()) {
      const reachesOtherProjects = select(row.text_masked, projectB, 'gemini').lessonIds.includes(row.id);
      expect([row.section_anchor, reachesOtherProjects]).toEqual([row.section_anchor, lessonReach(row) === 'any-project']);
    }
  });
});

describe('finding a note by ID', () => {
  it('takes any unique prefix of four or more characters, in any case', () => {
    const row = one('feedback_quoting_rule.md');
    expect(findLesson(row.id.slice(0, 8))).toEqual({ row });
    expect(findLesson(row.id.toUpperCase())).toEqual({ row });
    expect(findLesson('abc')).toEqual({ error: 'too-short' });
    expect(findLesson('ffffffff-no-such-note')).toEqual({ error: 'not-found' });
  });

  it('refuses a prefix that matches more than one note', () => {
    const [a, b] = all();
    getDb().prepare('UPDATE lessons SET id = ? WHERE id = ?').run('abcd0000-0000-4000-8000-000000000001', a.id);
    getDb().prepare('UPDATE lessons SET id = ? WHERE id = ?').run('abcd0000-0000-4000-8000-000000000002', b.id);
    expect(findLesson('abcd0000')).toMatchObject({ error: 'ambiguous', matches: [expect.anything(), expect.anything()] });
  });
});

describe('forget', () => {
  it('is permanent: the note stays gone after a re-read and after its source is edited, and the file is untouched', () => {
    const row = one('feedback_quoting_rule.md');
    const before = readFileSync(row.source_path, 'utf8');
    const others = all().length - 1;

    expect(forgetLesson(row)).toEqual({ removed: 1 });
    expect(readFileSync(row.source_path, 'utf8')).toBe(before);
    syncLessonSources(home);
    expect(inFile('feedback_quoting_rule.md')).toEqual([]);

    writeFileSync(row.source_path, before.replace('lose every backslash', 'drop every single backslash'));
    syncLessonSources(home);
    expect(inFile('feedback_quoting_rule.md')).toEqual([]);
    expect(all()).toHaveLength(others);
    expect(select('inline script backslashes', projectB).reason).toBe('no_match');
  });

  // Picking the copy is the harder case: the other project's note is identical
  // to the ORIGINAL, not to the copy, so only a forget that follows every copy
  // it removes can reach it.
  it.each(['the original', 'its copy'])("forgetting %s forgets the entry's other checkout and the same text anywhere else", (picked) => {
    const copy = join(home, 'backup', 'alpha');
    mkdirSync(copy, { recursive: true });
    addProjectAlias(copy, resolveProjectIdentity(projectA));
    claudeFolder(copy, { 'feedback_quoting_rule.md': fixture('feedback_quoting_rule.md').replace('lose every backslash', 'lost backslashes') });
    claudeFolder(projectB, { 'feedback_same_rule.md': fixture('feedback_quoting_rule.md') });
    syncLessonSources(home);
    expect(all().filter(row => row.source_path.includes('quoting_rule') || row.source_path.includes('same_rule'))).toHaveLength(3);

    const target = inFile('feedback_quoting_rule.md').find(row => row.source_path.includes('backup') === (picked === 'its copy'));
    expect(forgetLesson(target!).removed).toBe(3);
    syncLessonSources(home);
    expect(all().filter(row => row.source_path.includes('quoting_rule') || row.source_path.includes('same_rule'))).toEqual([]);
  });
});

describe('off', () => {
  it('turns sharing off and deletes everything harvested, with proof, but keeps the user\'s own decisions', () => {
    const notes = all().length;
    logShadowSelection({ query: 'inline script backslashes', targetHost: 'claude', selection: select('inline script backslashes', projectB) });
    forgetLesson(one('feedback_server_config.md'));
    excludeProjectDir(projectB);

    expect(turnLessonsOff()).toEqual({ wasOn: true, notes: notes - 1, shadowLog: 1, remaining: 0 });
    expect(isLessonsSharingEnabled()).toBe(false);
    expect(syncLessonSources(home)).toMatchObject({ consent: false, sources: 0 });
    expect(all()).toEqual([]);
    const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count('lesson_tombstones'), count('lesson_project_exclusions')]).toEqual([1, 1]);
    expect(turnLessonsOff()).toEqual({ wasOn: false, notes: 0, shadowLog: 0, remaining: 0 });
  });
});

describe('keeping a project out', () => {
  it('stops its notes leaving and other notes arriving, and include lets it back in', () => {
    const notes = all().length;
    expect(excludeProjectDir(projectA)).toEqual({ label: 'alpha', added: true, removed: notes });
    expect(syncLessonSources(home)).toMatchObject({ excluded: 3, harvested: 0 });
    expect(all()).toEqual([]);

    claudeFolder(projectB, { 'feedback_quoting_rule.md': fixture('feedback_quoting_rule.md').replace('lose every backslash', 'lose backslashes too') });
    syncLessonSources(home);
    expect(select('inline script backslashes', projectA, 'gemini')).toMatchObject({ reason: 'project_excluded', lessonIds: [] });

    expect(includeProjectDir(projectA)).toEqual({ label: 'alpha', removed: true });
    syncLessonSources(home);
    expect(all()).toHaveLength(notes + 1);
    expect(select('inline script backslashes', projectA, 'gemini').reason).toBe('selected');
  });
});

describe('aliases', () => {
  it('links memory whose folder is not on this machine to the project it belongs to', () => {
    const offline = join(home, 'unplugged', 'alpha');
    claudeFolder(offline, { 'project_offline.md': '---\nname: o\ndescription: Deploy days\ntype: project\n---\nThe deploy for this service runs on Fridays only.\n' }, false);
    syncLessonSources(home);
    expect(unresolvedFolders()).toEqual([expect.objectContaining({ notes: 1 })]);
    expect(lessonReach(one('project_offline.md'))).toBe('nowhere');
    expect(select('deploy runs fridays', projectA, 'gemini').reason).toBe('no_match');

    expect(setProjectAlias(offline, projectA)).toMatchObject({ ok: true, label: 'alpha', memoryFolders: 1 });
    syncLessonSources(home);
    expect(unresolvedFolders()).toEqual([]);
    expect(select('deploy runs fridays', projectA, 'gemini').reason).toBe('selected');
  });

  it('says when a linked path names no memory Veto has read', () => {
    expect(setProjectAlias(join(home, 'typo', 'alpha'), projectA)).toMatchObject({ ok: true, memoryFolders: 0 });
  });

  it('suggests the link for a copy on another drive, folder path included', () => {
    const onD = String.raw`D:\Code\Complete automation`;
    expect(suggestAlias('claude-slug:F--Code-Complete-automation', [onD, String.raw`D:\Code\Other`]))
      .toEqual({ aliasPath: String.raw`F:\Code\Complete automation`, targetDir: onD });
    // A backup nested deeper: the project is clear, its own folder path is not.
    expect(suggestAlias('claude-slug:G--Backups-Drive-Code-Complete-automation', [onD])).toEqual({ aliasPath: null, targetDir: onD });
    // Two candidates, or none: no guess.
    expect(suggestAlias('claude-slug:F--Code-app', [String.raw`D:\Code\app`, String.raw`E:\Code\app`])).toBeNull();
    expect(suggestAlias('claude-slug:F--Code-app', [String.raw`D:\Code\web`])).toBeNull();
  });

  it('suggests the link for memory whose recorded folder is gone, using that folder', () => {
    // A transcript names the folder, but it is not on this machine: nested
    // under "bk" so its slug ends with project alpha's.
    const gone = join(home, 'bk', projectA.replace(/^([A-Za-z]:)?[\\/]+/, ''));
    claudeFolder(gone, { 'project_backup.md': '---\nname: b\ndescription: Backup note\ntype: project\n---\nKept on the backup drive.\n' });
    syncLessonSources(home);
    expect(unresolvedFolders()).toEqual([expect.objectContaining({
      notes: 1,
      suggestion: { aliasPath: expect.stringMatching(/bk/), targetDir: realpathSync.native(projectA) },
    })]);
  });

  it('refuses to link a different repository, the same folder, or a folder that is not there', () => {
    const x = repo(join(home, 'repos', 'x'));
    const y = repo(join(home, 'repos', 'y'));
    expect(setProjectAlias(y, x)).toEqual({ ok: false, error: 'different-repository' });
    expect(setProjectAlias(x, x)).toEqual({ ok: false, error: 'same-folder' });
    expect(setProjectAlias(x, join(home, 'nowhere'))).toEqual({ ok: false, error: 'target-missing' });
  });
});

describe('flows', () => {
  it('counts where one project\'s notes may go', () => {
    expect(lessonFlows()).toEqual([expect.objectContaining({
      source: 'claude', projectLabel: 'alpha', notes: 7, anyProject: 2, ownProject: 5, nowhere: 0, heldBack: { command: 1 }, unresolved: false,
    })]);
  });
});

describe('recheck', () => {
  it('switches a host back on, and leaves it off while its format is still unknown', () => {
    mkdirSync(join(home, '.gemini'));
    const gemini = join(home, '.gemini', 'GEMINI.md');
    writeFileSync(gemini, '{"memories": ["not markdown"]}');
    syncLessonSources(home);
    expect(recheckSource('gemini', home)).toMatchObject({ wasDisabled: true, stillDisabled: expect.stringContaining('JSON') });

    copyFileSync(join(FIXTURES, 'gemini', 'GEMINI.md'), gemini);
    expect(recheckSource('gemini', home)).toMatchObject({ wasDisabled: true, stillDisabled: null });
    expect(all().some(row => row.source_cli === 'gemini')).toBe(true);
  });
});
