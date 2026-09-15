import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableLessonsSharing, enableLessonsSharing } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { discoverNativeMemorySources } from '../../src/lessons/discover.js';
import { syncLessonSources } from '../../src/lessons/harvest.js';
import { addProjectAlias, resolveProjectIdentity } from '../../src/lessons/identity.js';
import { logShadowSelection, selectLessonsForShadow } from '../../src/lessons/select.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';
import { disableLessonSource, type LessonRow } from '../../src/lessons/store.js';

const FIXTURES = join(__dirname, 'fixtures');
const roots: string[] = [];
const root = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-shadow-'))); roots.push(dir); return dir; };

let home: string;
let projectA: string;
let projectB: string;

/** A Claude project folder as Claude Code lays it out, with a transcript naming its cwd. */
function claudeFolder(projectDir: string, files: Record<string, string>): string {
  const memory = join(home, '.claude', 'projects', claudeProjectSlug(projectDir), 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, '..', 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: projectDir })}\n`);
  for (const [name, from] of Object.entries(files)) copyFileSync(from, join(memory, name));
  return memory;
}

const fixture = (name: string) => join(FIXTURES, 'claude', name);
const texts = (ids: string[]) => ids.map(id => (getDb().prepare('SELECT text_masked FROM lessons WHERE id = ?').get(id) as Pick<LessonRow, 'text_masked'>).text_masked);
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

describe('discovery', () => {
  it('finds only known native-memory paths and marks host-wide files', () => {
    mkdirSync(join(home, '.gemini'));
    copyFileSync(join(FIXTURES, 'gemini', 'GEMINI.md'), join(home, '.gemini', 'GEMINI.md'));
    const found = discoverNativeMemorySources(home);
    expect(found.filter(s => s.source === 'claude')).toHaveLength(3);
    expect(found.every(s => s.source === 'claude' ? !s.global && s.claudeSlug === claudeProjectSlug(projectA) : s.global)).toBe(true);
  });
});

describe('shadow selection', () => {
  it('selects nothing without consent v2', () => {
    disableLessonsSharing();
    expect(select('backslashes script file', projectB)).toMatchObject({ reason: 'consent_off', lessonIds: [] });
  });

  it("shares one Claude project's feedback with another Claude project", () => {
    const selection = select('inline script backslashes', projectB);
    expect(selection.reason).toBe('selected');
    expect(texts(selection.lessonIds)).toEqual([expect.stringContaining('lose every backslash')]);
  });

  it('shares machine lessons across projects', () => {
    expect(texts(select('console encoding mojibake cp1252', projectB).lessonIds)).toEqual(expect.arrayContaining([expect.stringContaining('mojibake')]));
  });

  it('never lets project-scope or quarantined notes leave their project', () => {
    expect(select('staging database reset Sunday', projectB).reason).toBe('no_match');
    expect(select('release version patch push tags', projectB).reason).toBe('no_match');
    // The same notes do reach their own project through another host.
    expect(texts(select('release version patch push tags', projectA, 'gemini').lessonIds)).toEqual(expect.arrayContaining([expect.stringContaining('npm version patch')]));
  });

  it('keeps a quarantined note home even when its scope would let it travel', () => {
    const row = getDb().prepare("SELECT scope, quarantine_reason FROM lessons WHERE source_path LIKE '%feedback_server_config.md'").get();
    expect(row).toEqual({ scope: 'user', quarantine_reason: 'command' });
    expect(select('windows server entry shim', projectB).reason).toBe('no_match');
    expect(texts(select('windows server entry shim', projectA, 'gemini').lessonIds)).toEqual([expect.stringContaining('npx.cmd')]);
  });

  it('does not re-inject what the host already loads natively', () => {
    expect(select('inline script backslashes', projectA, 'claude').reason).toBe('no_match');
    expect(select('inline script backslashes', projectA, 'gemini').reason).toBe('selected');
  });

  it('selects nothing that shares no term with the query', () => {
    expect(select('kubernetes ingress certificate', projectB)).toMatchObject({ reason: 'no_match', lessonIds: [] });
  });

  it('treats one shared word as coincidence, not relevance', () => {
    expect(select('weather script forecast', projectB).reason).toBe('no_match');
    expect(select('the and of script', projectB).reason).toBe('selected');
  });

  it("keeps feedback that names its own project out of other projects", () => {
    const memory = join(home, '.claude', 'projects', claudeProjectSlug(projectA), 'memory');
    writeFileSync(join(memory, 'feedback_alpha_releases.md'), '---\nname: r\ndescription: Alpha releases\ntype: feedback\n---\nAlpha patch releases are worded as bug fixes in the changelog.\n');
    syncLessonSources(home);
    expect(select('patch releases worded changelog', projectB).reason).toBe('no_match');
    expect(select('patch releases worded changelog', projectA, 'gemini').reason).toBe('selected');
  });

  it('never counts function words as shared terms', () => {
    expect(select('the and of weather', projectB).reason).toBe('no_match');
  });

  it('counts a compound word once, however many search terms it expands to', () => {
    // "cp1252-console" is one word (sub-tokens cp1252, console): with "weather"
    // it shares one word with the machine note, not two.
    expect(select('cp1252-console weather', projectB).reason).toBe('no_match');
  });

  it('stops serving a host once its format-drift canary has tripped', () => {
    disableLessonSource('claude', 'x.md: JSON document where Markdown was expected');
    expect(select('inline script backslashes', projectB).reason).toBe('no_match');
  });

  it('serves only the newest copy of an entry held in two checkouts', () => {
    const copy = join(home, 'backup', 'alpha');
    mkdirSync(copy, { recursive: true });
    addProjectAlias(copy, resolveProjectIdentity(projectA));
    const memory = claudeFolder(copy, {});
    const stale = join(memory, 'feedback_quoting_rule.md');
    writeFileSync(stale, '---\nname: quoting-rule\ndescription: old copy\ntype: feedback\n---\nOLD COPY inline script backslashes\n');
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(stale, past, past);
    syncLessonSources(home);

    // The old copy mentions the query terms more often, yet the newer one wins.
    expect(texts(select('inline script backslashes', projectB).lessonIds)).toEqual([expect.stringContaining('lose every backslash')]);
  });

  it('logs shadow evidence as IDs, without delivering anything', () => {
    const selection = select('inline script backslashes', projectB);
    logShadowSelection({ query: 'inline script backslashes', targetHost: 'claude', selection });
    const log = getDb().prepare('SELECT target_project_identity, lesson_ids, reason FROM lesson_shadow_log').all() as Array<{ target_project_identity: string; lesson_ids: string; reason: string }>;
    expect(log).toEqual([{ target_project_identity: resolveProjectIdentity(projectB), lesson_ids: JSON.stringify(selection.lessonIds), reason: 'selected' }]);
  });
});
