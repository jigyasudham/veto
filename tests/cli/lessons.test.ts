import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLessonsCommand, type ConsentIo } from '../../src/cli/lessons.js';
import { detectAiSession } from '../../src/lessons/consent.js';
import { enableLessonsSharing, getConfig, isLessonsSharingEnabled } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';
import type { LessonRow } from '../../src/lessons/store.js';

const FIXTURES = join(__dirname, '..', 'lessons', 'fixtures', 'claude');
const roots: string[] = [];
const root = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-lessons-cli-'))); roots.push(dir); return dir; };

let home: string;
let projectA: string;

function run(...args: string[]): { code: number; text: string } {
  const lines: string[] = [];
  const code = runLessonsCommand(args, { out: (line = '') => lines.push(line), color: false, home, cwd: projectA }) as number;
  return { code, text: lines.join('\n') };
}

/** `veto lessons on` as a person (or an AI) would run it; `asked` records every question put. */
async function on(io: Partial<ConsentIo> & { answer?: string } = {}): Promise<{ code: number; text: string; asked: string[] }> {
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await runLessonsCommand(['on'], {
    out: (line = '') => lines.push(line), color: false, home, cwd: projectA,
    io: {
      env: io.env ?? {},
      interactive: io.interactive ?? true,
      ask: io.ask ?? (async question => { asked.push(question); return io.answer ?? ''; }),
    },
  });
  return { code, text: lines.join('\n'), asked };
}

const rows = () => getDb().prepare('SELECT * FROM lessons').all() as LessonRow[];
const byFile = (name: string) => rows().find(row => row.source_path.endsWith(name))!;

/** Every file under a folder with its content hash, to prove nothing was written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

let ceiling: string | undefined;
beforeEach(() => {
  resetDb();
  ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
  home = root();
  process.env.VETO_CONFIG_PATH = join(home, 'config.json');
  projectA = join(home, 'code', 'alpha');
  mkdirSync(projectA, { recursive: true });
  const memory = join(home, '.claude', 'projects', claudeProjectSlug(projectA), 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, '..', 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: projectA })}\n`);
  for (const name of ['feedback_quoting_rule.md', 'feedback_server_config.md', 'project_release_gotchas.md']) copyFileSync(join(FIXTURES, name), join(memory, name));
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('veto lessons without consent', () => {
  it('reads nothing and says so', () => {
    const status = run();
    expect(status.code).toBe(0);
    expect(status.text).toContain("Sharing:      off: Veto has not read any AI's memory");
    expect(run('list').text).toContain('(none)');
    expect(rows()).toEqual([]);
  });
});

describe('veto lessons on (consent v2)', () => {
  it('shows a disclosure that names both flows, the trial, and the controls', async () => {
    const { text } = await on();
    expect(text).toContain('ACROSS YOUR PROJECTS');
    expect(text).toContain('BETWEEN AIs');
    expect(text).toContain("goes to that AI's company as part of your");
    expect(text).toContain('gives none of them to any AI yet');
    expect(text).toContain('Before it starts\n  giving notes to your AIs, Veto will ask you again.');
    for (const command of ['veto lessons list', 'veto lessons forget <id>', 'veto lessons exclude', 'veto lessons off']) expect(text).toContain(command);
  });

  it('refuses when an AI runs it, without asking anything or reading any memory', async () => {
    const r = await on({ env: { CLAUDECODE: '1' }, answer: 'yes' });
    expect(r.code).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.text).toContain('An AI is running this command (CLAUDECODE is set), so it cannot accept for you. Nothing changed.');
    expect(isLessonsSharingEnabled()).toBe(false);
    expect(rows()).toEqual([]);
  });

  it('refuses without a terminal a person can type in', async () => {
    const r = await on({ interactive: false, answer: 'yes' });
    expect(r).toMatchObject({ code: 1, asked: [] });
    expect(r.text).toContain('Accepting needs you to type yes in a terminal window. Nothing changed.');
    expect(isLessonsSharingEnabled()).toBe(false);
  });

  it.each(['no', '', 'y', 'yes please'])('changes nothing unless the answer is yes (%j)', async (answer) => {
    const r = await on({ answer });
    expect(r).toMatchObject({ code: 0, asked: ['  Type yes to turn sharing on: '] });
    expect(r.text).toContain('Nothing changed. Sharing is still off.');
    expect(isLessonsSharingEnabled()).toBe(false);
    expect(getConfig().lessons.consent_at).toBeNull();
    expect(rows()).toEqual([]);
  });

  it('treats a closed or failing prompt as no', async () => {
    const r = await on({ ask: async () => { throw new Error('stdin closed'); } });
    expect(r.code).toBe(0);
    expect(isLessonsSharingEnabled()).toBe(false);
  });

  it('on yes: records consent v2, reads every AI\'s memory once, and summarises it in plain words', async () => {
    const r = await on({ answer: ' YES ' });
    expect(r.code).toBe(0);
    expect(getConfig().lessons).toMatchObject({ enabled: true, consent_version: 2, cross_project: true, cross_vendor: true });
    expect(r.text).toContain('✓ Sharing is on.');
    expect(r.text).toContain('Veto read 3 memory files and found 7 notes (Claude 7 · Codex 0 · Gemini 0) across 1 project.');
    expect(r.text).toContain('   2  may be shared into any project');
    expect(r.text).toContain('   5  stay in their own project');
    expect(r.text).toContain('nothing has been given to any AI');
    expect(rows()).toHaveLength(7);
  });

  it('says so when sharing is already on, and asks nothing', async () => {
    enableLessonsSharing();
    const r = await on({ answer: 'yes' });
    expect(r).toMatchObject({ code: 0, asked: [] });
    expect(r.text).toMatch(/Sharing is already on \(accepted \d{4}-\d{2}-\d{2}\)/);
  });

  it('no upgrade turns sharing on: an older config stays off, and an older consent asks again', async () => {
    writeFileSync(process.env.VETO_CONFIG_PATH!, JSON.stringify({ transcripts: { enabled: true } }));
    expect(isLessonsSharingEnabled()).toBe(false);
    expect(run('status').text).toContain('Turn it on, in a terminal of your own: veto lessons on');

    writeFileSync(process.env.VETO_CONFIG_PATH!, JSON.stringify({ lessons: { enabled: true, consent_version: 1, cross_project: true, cross_vendor: true } }));
    expect(isLessonsSharingEnabled()).toBe(false);
    expect(run('status').text).toContain('paused: what sharing does has changed since you accepted it → veto lessons on');
    expect(rows()).toEqual([]);
    expect((await on({ answer: 'yes' })).asked).toHaveLength(1);
    expect(isLessonsSharingEnabled()).toBe(true);
  });

  it('recognises the marks AI CLIs leave on the commands they run', () => {
    expect(detectAiSession({})).toBeNull();
    expect(detectAiSession({ CLAUDECODE: '' })).toBeNull();
    for (const marker of ['CLAUDECODE', 'AI_AGENT', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM']) {
      expect(detectAiSession({ PATH: '/bin', [marker]: '1' })).toBe(marker);
    }
  });
});

describe('veto lessons with consent', () => {
  beforeEach(() => { enableLessonsSharing(); });

  it('lists notes by project with a short ID, where each may go, and its title', () => {
    const { code, text } = run('list');
    expect(code).toBe(0);
    expect(text).toContain('Notes Veto has read from your AIs\' memory: 7');
    expect(text).toContain('  alpha');
    const quoting = byFile('feedback_quoting_rule.md');
    expect(text).toMatch(new RegExp(`${quoting.id.slice(0, 8)}  Claude  \\d{4}-\\d{2}-\\d{2}  any project +Inline interpreter scripts`));
    expect(text).toMatch(new RegExp(`${byFile('feedback_server_config.md').id.slice(0, 8)}  .*held: command`));
    expect(run('list', '--shared').text).toContain('Notes Veto has read from your AIs\' memory: 2');
    expect(run('list', '--scope', 'machine').text).toContain('Console encoding (cp1252)');
  });

  it('rejects an unknown filter value', () => {
    expect(run('list', '--scope=everything').code).toBe(1);
    expect(run('list', '--source=cursor').code).toBe(1);
  });

  it('why shows the note, where it came from, why it is held, and where it may go', () => {
    run('list');
    const { code, text } = run('why', byFile('feedback_server_config.md').id.slice(0, 8));
    expect(code).toBe(0);
    expect(text).toMatch(/from Claude memory · alpha · \d{4}-\d{2}-\d{2}/);
    expect(text).toContain('Scope      user: Claude saved it as feedback on how to work (type: feedback)');
    expect(text).toContain('Held       kept in its own project: it contains a shell or network command');
    expect(text).toContain('May reach  alpha only, in Codex and Gemini');
    expect(text).toContain('│ On Windows the MCP server entry has to call the shim form');
    expect(text).toContain('Delivered  never yet');
  });

  it('why and forget explain a bad ID instead of guessing', () => {
    run('list');
    expect(run('why').code).toBe(1);
    expect(run('why', 'ab')).toMatchObject({ code: 1, text: expect.stringContaining('at least the first 4 characters') });
    expect(run('forget', 'ffffffff')).toMatchObject({ code: 1, text: expect.stringContaining('No note ffffffff') });
  });

  it('forget removes a note from every later listing', () => {
    run('list');
    const id = byFile('feedback_quoting_rule.md').id.slice(0, 8);
    expect(run('forget', id)).toMatchObject({ code: 0, text: expect.stringContaining(`Forgot ${id}`) });
    expect(run('list').text).not.toContain(id);
    expect(run('status').text).toContain('Forgotten:    1 (permanent)');
  });

  it('flows shows each source and where its notes may go', () => {
    const { code, text } = run('flows');
    expect(code).toBe(0);
    expect(text).toContain('Claude memory · alpha  7 notes');
    expect(text).toContain('   2  → any project, in Codex, Gemini, and Claude in other folders');
    expect(text).toContain('   5  → alpha only, in Codex, Gemini, and Claude in other folders');
    expect(text).toContain('held in their project instead of shared: 1 command');
  });

  it('off deletes everything harvested and proves it', () => {
    run('list');
    const { code, text } = run('off');
    expect(code).toBe(0);
    expect(text).toContain('Sharing is off.');
    expect(text).toContain('Deleted 7 harvested notes and 0 shadow-log records.');
    expect(text).toContain("Checked: nothing harvested is left in Veto's database.");
    expect(rows()).toEqual([]);
    expect(run('list').text).toContain('(none)');
  });

  it('exclude keeps the current project out, and include lets it back in', () => {
    run('list');
    expect(run('exclude').text).toContain('alpha is kept out of sharing.');
    expect(run('status').text).toContain('Kept out:     alpha');
    expect(run('list').text).toContain('(none)');
    expect(run('include').text).toContain('alpha takes part in sharing again.');
    expect(run('list').text).toContain('Notes Veto has read from your AIs\' memory: 7');
  });

  it('alias lists memory with no project, and needs a target to link one', () => {
    const offline = join(home, 'unplugged', 'alpha');
    const memory = join(home, '.claude', 'projects', claudeProjectSlug(offline), 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'project_offline.md'), '---\nname: o\ndescription: Deploy days\ntype: project\n---\nDeploys run on Fridays only.\n');

    expect(run('status').text).toContain('Unlinked:     1 memory folder with no project Veto can find');
    expect(run('alias').text).toContain('Memory with no project folder');
    expect(run('alias', offline).code).toBe(1);
    expect(run('alias', offline, '--to', projectA)).toMatchObject({ code: 0, text: expect.stringContaining(`Notes from ${offline} now count as alpha's.`) });
    expect(run('status').text).not.toContain('Unlinked');
    expect(run('alias').text).not.toContain('Memory with no project folder');
  });

  it('recheck needs a known AI', () => {
    expect(run('recheck').code).toBe(1);
    expect(run('recheck', 'gemini')).toMatchObject({ code: 0, text: expect.stringContaining('Gemini is back on (it was not off).') });
  });

  it('never writes to any AI\'s memory, whatever it runs', () => {
    const before = snapshot(join(home, '.claude'));
    run('list');
    const id = byFile('feedback_quoting_rule.md').id.slice(0, 8);
    for (const args of [['status'], ['list'], ['why', id], ['flows'], ['forget', id], ['exclude'], ['include'], ['alias'], ['recheck', 'claude'], ['off']]) run(...args);
    expect(snapshot(join(home, '.claude'))).toEqual(before);
  });
});

it('an unknown subcommand prints usage and fails', () => {
  const { code, text } = run('share');
  expect(code).toBe(1);
  expect(text).toContain('Unknown lessons subcommand: share');
  expect(text).toContain('veto lessons why <id>');
});
