import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Working out which project a Claude memory folder belongs to runs git (about
// 65 ms a folder on Windows) and can walk a drive. That the answer is reused is
// invisible in what gets stored, since the answer is the same, so these tests
// count the work itself.
const calls = vi.hoisted(() => ({ names: 0, folders: 0 }));
vi.mock('../../src/lessons/identity.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lessons/identity.js')>();
  return { ...actual, projectNames: (dir: string) => { calls.names++; return actual.projectNames(dir); } };
});
vi.mock('../../src/lessons/source-project.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lessons/source-project.js')>();
  return {
    ...actual,
    resolveClaudeProjectFolder: (folder: string, slug: string) => { calls.folders++; return actual.resolveClaudeProjectFolder(folder, slug); },
  };
});

import { enableLessonsSharing } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { syncLessonSources } from '../../src/lessons/harvest.js';
import { setProjectAlias, turnLessonsOff } from '../../src/lessons/manage.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';

const FIXTURES = join(__dirname, 'fixtures');
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'veto-folders-')); roots.push(dir); return dir; };

/** A budget large enough never to cut the pass short: it only marks the pass as a save's. */
const save = (home: string) => syncLessonSources({ home, budgetMs: 60_000 });
const command = (home: string) => syncLessonSources({ home });

const folderRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM lesson_folder_state').get() as { n: number }).n;
const identities = () => (getDb().prepare('SELECT DISTINCT project_identity AS p FROM lessons ORDER BY p').all() as Array<{ p: string }>).map(r => r.p);

/** A Claude memory folder for `project`, traced by a transcript unless `traceable` is false. */
function memoryFolder(home: string, project: string, traceable = true): { folder: string; notes: string[] } {
  const folder = join(home, '.claude', 'projects', claudeProjectSlug(project));
  mkdirSync(join(folder, 'memory'), { recursive: true });
  if (traceable) writeFileSync(join(folder, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
  const notes = ['feedback_quoting_rule.md', 'project_release_gotchas.md'].map(name => {
    const path = join(folder, 'memory', name);
    copyFileSync(join(FIXTURES, 'claude', name), path);
    return path;
  });
  return { folder, notes };
}

const edit = (paths: string[]) => { for (const path of paths) appendFileSync(path, '\nOne more line.\n'); };

beforeEach(() => {
  resetDb();
  calls.names = 0;
  calls.folders = 0;
});
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('working out which project a memory folder belongs to', () => {
  it('is done once, then reused by every save', () => {
    const home = root();
    const { notes } = memoryFolder(home, join(home, 'work', 'demo'));
    enableLessonsSharing();

    expect(save(home)).toMatchObject({ harvested: 2 });
    expect(calls).toEqual({ names: 1, folders: 1 });

    edit(notes);
    expect(save(home)).toMatchObject({ harvested: 2 });
    expect(calls).toEqual({ names: 1, folders: 1 });
  });

  it('is reused after a harvester upgrade, when a save has the most to catch up on', () => {
    const home = root();
    memoryFolder(home, join(home, 'work', 'demo'));
    enableLessonsSharing();
    save(home);

    // What a HARVESTER_VERSION bump leaves behind: every file is stale at once.
    getDb().prepare('UPDATE lesson_file_state SET harvester_version = 0').run();
    expect(save(home)).toMatchObject({ harvested: 2, notReached: 0 });
    expect(calls).toEqual({ names: 1, folders: 1 });
  });

  it('is done again by a command, and by a save once the rules for it change', () => {
    const home = root();
    const { notes } = memoryFolder(home, join(home, 'work', 'demo'));
    enableLessonsSharing();
    save(home);

    edit(notes);
    command(home);
    expect(calls).toEqual({ names: 2, folders: 2 });

    getDb().prepare('UPDATE lesson_folder_state SET resolver_version = 0').run();
    edit(notes);
    save(home);
    expect(calls).toEqual({ names: 3, folders: 3 });
  });

  it('is never repeated by a save for a folder it could not trace', () => {
    const home = root();
    // A drive that is not plugged in: no transcript, and no such directory.
    const { notes } = memoryFolder(home, join(home, 'offline', 'beta'), false);
    enableLessonsSharing();

    save(home);
    expect(calls.folders).toBe(1);
    expect(identities()).toEqual([`claude-slug:${claudeProjectSlug(join(home, 'offline', 'beta'))}`]);

    edit(notes);
    save(home);
    expect(calls.folders).toBe(1);
  });

  it('is forgotten when an alias links the folder, so the next save files its notes there', () => {
    const home = root();
    const offline = join(home, 'offline', 'beta');
    memoryFolder(home, offline, false);
    const target = join(home, 'work', 'beta');
    mkdirSync(target, { recursive: true });
    enableLessonsSharing();
    save(home);
    expect(identities()[0]).toMatch(/^claude-slug:/);

    const linked = setProjectAlias(offline, target);
    expect(linked).toMatchObject({ ok: true });

    save(home);
    expect(identities()).toEqual([(linked as { identity: string }).identity]);
  });

  it('is forgotten when sharing is turned off, and when its folder goes away', () => {
    const home = root();
    const { folder } = memoryFolder(home, join(home, 'work', 'demo'));
    memoryFolder(home, join(home, 'work', 'other'));
    enableLessonsSharing();
    save(home);
    expect(folderRows()).toBe(2);

    rmSync(folder, { recursive: true, force: true });
    command(home);
    expect(folderRows()).toBe(1);

    turnLessonsOff();
    expect(folderRows()).toBe(0);
  });
});
