import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableLessonsSharing, enableLessonsSharing, getConfig, setConfig } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { harvestNativeMemory, syncLessonSources } from '../../src/lessons/harvest.js';
import { clearLessonFileState, recordLessonFileUnavailable } from '../../src/lessons/store.js';
import { harvestOnSave } from '../../src/lessons/on-save.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';

const FIXTURES = join(__dirname, 'fixtures');
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'veto-onsave-')); roots.push(dir); return dir; };

const noteCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM lessons').get() as { n: number }).n;
const texts = () => (getDb().prepare('SELECT text_masked FROM lessons ORDER BY section_anchor').all() as Array<{ text_masked: string }>).map(r => r.text_masked);
const fileStates = () => (getDb().prepare('SELECT COUNT(*) AS n FROM lesson_file_state').get() as { n: number }).n;

/** Rewrite a file's bytes while leaving its mtime and size exactly as they were. */
function rewriteInvisibly(path: string, next: string): void {
  const before = statSync(path);
  // Padded by BYTES, not characters: these fixtures have CRLF line endings.
  let buffer = Buffer.from(next, 'utf8');
  buffer = buffer.length >= before.size
    ? buffer.subarray(0, before.size)
    : Buffer.concat([buffer, Buffer.alloc(before.size - buffer.length, 0x20)]);
  writeFileSync(path, buffer);
  utimesSync(path, before.atime, before.mtime);
  const after = statSync(path);
  expect([after.size, after.mtime.toISOString()]).toEqual([before.size, before.mtime.toISOString()]);
}

function home(): { home: string; memory: string; project: string } {
  const h = root();
  const project = join(h, 'work', 'demo');
  const folder = join(h, '.claude', 'projects', claudeProjectSlug(project));
  mkdirSync(join(folder, 'memory'), { recursive: true });
  writeFileSync(join(folder, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
  for (const name of ['feedback_quoting_rule.md', 'project_release_gotchas.md']) {
    copyFileSync(join(FIXTURES, 'claude', name), join(folder, 'memory', name));
  }
  return { home: h, memory: join(folder, 'memory'), project };
}

beforeEach(() => {
  resetDb();
  process.env.VETO_CONFIG_PATH = join(root(), 'config.json');
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('passing over a file that has not changed', () => {
  it('does not read it again, and a forced pass does', () => {
    const { home: h, memory } = home();
    enableLessonsSharing();
    expect(syncLessonSources(h)).toMatchObject({ harvested: 2, unchanged: 0 });
    const original = texts();

    // Same length, same mtime, different words: only a pass that actually
    // opens the file can see this.
    rewriteInvisibly(join(memory, 'feedback_quoting_rule.md'), readFileSync(join(memory, 'feedback_quoting_rule.md'), 'utf8').replace('backslash', 'backslosh'));

    expect(syncLessonSources(h)).toMatchObject({ harvested: 0, unchanged: 2, inserted: 0, updated: 0 });
    expect(texts()).toEqual(original);

    const forced = syncLessonSources({ home: h, forced: true });
    expect(forced.updated).toBeGreaterThan(0);
    expect(texts()).not.toEqual(original);
  });

  it('accepts a new timestamp on identical content without parsing it again', () => {
    const { home: h, memory } = home();
    enableLessonsSharing();
    syncLessonSources(h);
    const before = texts();

    const path = join(memory, 'project_release_gotchas.md');
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);

    expect(syncLessonSources(h)).toMatchObject({ harvested: 0, unchanged: 2, updated: 0 });
    expect(texts()).toEqual(before);
    // The new timestamp is remembered, so the next pass is cheap again.
    expect(syncLessonSources(h)).toMatchObject({ unchanged: 2 });
  });

  it('re-reads a file whose project identity changed even though its bytes did not', () => {
    const { memory } = home();
    enableLessonsSharing();
    const path = join(memory, 'feedback_quoting_rule.md');

    expect(harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:alpha' })).toMatchObject({ status: 'harvested' });
    expect(harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:alpha' })).toEqual({ status: 'unchanged' });

    // An alias moves a file to another project without touching it. Skipping
    // on content alone would silently ignore that.
    const moved = harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:beta' });
    expect(moved).toMatchObject({ status: 'harvested' });
    expect((getDb().prepare('SELECT DISTINCT project_identity AS p FROM lessons').all() as Array<{ p: string }>).map(r => r.p)).toEqual(['git:beta']);
  });
});

describe('the time budget', () => {
  it('stops cleanly, reports what it did not reach, and keeps the next pass correct', () => {
    const { home: h } = home();
    enableLessonsSharing();

    const stopped = syncLessonSources({ home: h, budgetMs: 0 });
    expect(stopped).toMatchObject({ harvested: 0, notReached: stopped.sources });
    expect(noteCount()).toBe(0);

    expect(syncLessonSources(h)).toMatchObject({ harvested: 2, notReached: 0 });
    expect(noteCount()).toBeGreaterThan(0);
  });

  it('does not delete rows for sources it never looked at', () => {
    const { home: h } = home();
    enableLessonsSharing();
    syncLessonSources(h);
    const before = noteCount();

    // A pass cut short has not seen every source, so it must not conclude that
    // an unseen one is gone.
    expect(syncLessonSources({ home: h, budgetMs: 0 })).toMatchObject({ removed: 0 });
    expect(noteCount()).toBe(before);
  });
});

describe('files it declines to read', () => {
  it('leaves existing rows alone when a file grows past the cap', () => {
    const { memory } = home();
    enableLessonsSharing();
    const path = join(memory, 'project_release_gotchas.md');
    expect(harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' })).toMatchObject({ status: 'harvested' });
    const before = noteCount();

    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${'x'.repeat(3 * 1024 * 1024)}`);

    const outcome = harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('larger than'));
    expect(noteCount()).toBe(before);
  });

  it("refuses a memory file that links outside its host's folder", () => {
    const { memory } = home();
    enableLessonsSharing();
    const outside = join(root(), 'elsewhere.md');
    writeFileSync(outside, '---\nname: x\ndescription: d\ntype: feedback\n---\nA secret kept outside home.');
    const link = join(memory, 'linked.md');
    try {
      symlinkSync(outside, link);
    } catch {
      return; // Creating symlinks needs a privilege this machine may not grant.
    }

    const outcome = harvestNativeMemory({ source: 'claude', sourcePath: link, projectIdentity: 'git:demo', root: memory });
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('outside its host'));
    expect(noteCount()).toBe(0);

    // A file that really is inside the host's folder is read as normal, even
    // when that folder is nowhere near the user's home directory.
    expect(harvestNativeMemory({ source: 'claude', sourcePath: join(memory, 'feedback_quoting_rule.md'), projectIdentity: 'git:demo', root: memory }))
      .toMatchObject({ status: 'harvested' });
  });
});

describe('a file that keeps failing to be read', () => {
  it('is left alone by a save, but still tried by a command', () => {
    const { home: h, memory } = home();
    enableLessonsSharing();
    syncLessonSources(h);

    const path = join(memory, 'feedback_quoting_rule.md');
    for (let i = 0; i < 3; i++) recordLessonFileUnavailable('claude', path);

    // A save does not even stat it: reading it is the part that hangs.
    expect(syncLessonSources({ home: h, budgetMs: 5_000 })).toMatchObject({ unavailable: 1, unchanged: 1 });

    // A command has time to find out whether it is really gone. It is not, so
    // it is looked at like any other file.
    expect(syncLessonSources(h)).toMatchObject({ unavailable: 0, unchanged: 2 });
  });
});

describe('harvesting when a session is saved', () => {
  it('says nothing at all until sharing is on', () => {
    home();
    disableLessonsSharing();
    expect(harvestOnSave()).toBeNull();
  });

  it('reports what changed the first time, then stays quiet', () => {
    const { home: h, memory } = home();
    enableLessonsSharing();

    const first = harvestOnSave({ home: h });
    expect(first).toMatchObject({ added: expect.any(Number), pending: 0 });
    expect(first!.added).toBeGreaterThan(0);
    expect(first!.note).toContain('veto lessons');

    // Nothing moved, so a save has nothing to say about notes.
    expect(harvestOnSave({ home: h })).toBeNull();

    // Nor after re-reading everything from scratch, when the notes turn out to
    // be the ones already kept: a re-read is our bookkeeping, not news.
    clearLessonFileState();
    expect(harvestOnSave({ home: h })).toBeNull();

    writeFileSync(join(memory, 'feedback_quoting_rule.md'), '---\nname: q\ndescription: Quoting\ntype: feedback\n---\nA brand new rule was learned today.\n');
    const second = harvestOnSave({ home: h });
    expect(second!.note).toBeUndefined();
    expect((second!.added + second!.updated + second!.removed)).toBeGreaterThan(0);
  });

  it('can be switched off without touching consent or the notes already kept', () => {
    const { home: h } = home();
    enableLessonsSharing();
    harvestOnSave({ home: h });
    const kept = noteCount();
    expect(kept).toBeGreaterThan(0);

    setConfig({ lessons: { ...getConfig().lessons, harvest_on_save: false } });

    expect(harvestOnSave({ home: h })).toBeNull();
    expect(noteCount()).toBe(kept);
    // Consent is untouched, so the commands still work.
    expect(syncLessonSources(h).consent).toBe(true);
  });

  it('forgets what each file looked like when sharing is turned off', async () => {
    const { home: h } = home();
    enableLessonsSharing();
    syncLessonSources(h);
    expect(fileStates()).toBeGreaterThan(0);

    const { turnLessonsOff } = await import('../../src/lessons/manage.js');
    turnLessonsOff();

    expect(fileStates()).toBe(0);
  });
});
