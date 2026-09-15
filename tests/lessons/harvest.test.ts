import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableLessonsSharing, enableLessonsSharing } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { harvestNativeMemory, syncLessonSources } from '../../src/lessons/harvest.js';
import { claudeProjectSlug } from '../../src/lessons/source-project.js';

const FIXTURES = join(__dirname, 'fixtures');
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'veto-lessons-')); roots.push(dir); return dir; };

function fixtureCopy(host: string, name: string): string {
  const path = join(root(), name);
  copyFileSync(join(FIXTURES, host, name), path);
  return path;
}

type Row = { section_anchor: string; scope: string; kind: string; text_masked: string; quarantined: number; quarantine_reason: string | null };
const rows = (source: string) => getDb().prepare('SELECT section_anchor, scope, kind, text_masked, quarantined, quarantine_reason FROM lessons WHERE source_cli = ? ORDER BY section_anchor').all(source) as Row[];

beforeEach(() => {
  resetDb();
  process.env.VETO_CONFIG_PATH = join(root(), 'config.json');
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('harvesting one native-memory file', () => {
  it('stores classified, masked sections and never modifies the source', () => {
    const path = fixtureCopy('claude', 'project_release_gotchas.md');
    const before = readFileSync(path, 'utf8');

    const result = harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });

    expect(result).toMatchObject({ status: 'harvested', inserted: 5 });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(rows('claude').map(r => [r.section_anchor, r.scope, r.quarantine_reason])).toEqual([
      ['body', 'project', null],
      ['console-encoding-cp1252', 'machine', null],
      ['notes', 'project', null],
      ['notes-2', 'project', null],
      ['release-steps', 'project', 'command'],
    ]);
  });

  it('scrubs private data before storing anything', () => {
    const path = join(root(), 'feedback_note.md');
    writeFileSync(path, '---\nname: n\ndescription: Contact rule\ntype: feedback\n---\nEmail dev@example.com; logs are in C:\\Users\\alex\\logs and C:/Users/alex/tmp.');

    harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });

    const [row] = rows('claude');
    expect(row.text_masked).not.toMatch(/dev@example\.com|alex/);
    expect(row).toMatchObject({ scope: 'user', kind: 'feedback' });
  });

  it('fails closed for an unrecognized format, and keeps the host off', () => {
    const path = join(root(), 'future.md');
    writeFileSync(path, '{"memories":[{"text":"a"}]}');

    const first = harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });
    const second = harvestNativeMemory({ source: 'claude', sourcePath: fixtureCopy('claude', 'user_profile.md'), projectIdentity: 'git:demo' });

    expect(first).toMatchObject({ status: 'disabled', reason: 'JSON document where Markdown was expected' });
    expect(second).toEqual({ status: 'disabled', reason: 'source disabled after format drift' });
  });

  it('does not treat headingless entries, empty files or indexes as drift', () => {
    const outcomes = [
      harvestNativeMemory({ source: 'claude', sourcePath: fixtureCopy('claude', 'feedback_quoting_rule.md'), projectIdentity: 'git:demo' }),
      harvestNativeMemory({ source: 'claude', sourcePath: fixtureCopy('claude', 'MEMORY.md'), projectIdentity: 'git:demo' }),
      (() => { const p = join(root(), 'empty.md'); writeFileSync(p, ''); return harvestNativeMemory({ source: 'claude', sourcePath: p, projectIdentity: 'git:demo' }); })(),
    ];
    expect(outcomes.map(o => o.status)).toEqual(['harvested', 'skipped', 'skipped']);
    expect(rows('claude')).toHaveLength(1);
  });

  it("skips Veto's own guide in a host file", () => {
    const path = join(root(), 'AGENTS.override.md');
    writeFileSync(path, '# Veto MCP Server\n\nVeto is active. 93 tools across 6 categories:\n');
    expect(harvestNativeMemory({ source: 'codex', sourcePath: path, projectIdentity: 'global:codex', global: true }))
      .toMatchObject({ status: 'skipped', reason: 'veto-authored' });
    expect(rows('codex')).toHaveLength(0);
  });

  it('updates only the changed section and removes deleted ones', () => {
    const path = fixtureCopy('claude', 'project_release_gotchas.md');
    harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace('reset every Sunday', 'reset every Saturday')
      .replace(/## Release steps\n\n```bash\n.*\n```\n\n/, ''));

    const result = harvestNativeMemory({ source: 'claude', sourcePath: path, projectIdentity: 'git:demo' });

    expect(result).toEqual({ status: 'harvested', inserted: 0, updated: 1, removed: 1 });
    expect(rows('claude').find(r => r.section_anchor === 'notes')?.text_masked).toContain('Saturday');
  });
});

describe('a full sync pass', () => {
  function home(): { home: string; memory: string } {
    const h = root();
    const project = join(h, 'work', 'demo');
    mkdirSync(project, { recursive: true });
    const folder = join(h, '.claude', 'projects', claudeProjectSlug(project));
    mkdirSync(join(folder, 'memory'), { recursive: true });
    writeFileSync(join(folder, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
    for (const name of ['feedback_quoting_rule.md', 'project_release_gotchas.md', 'MEMORY.md']) copyFileSync(join(FIXTURES, 'claude', name), join(folder, 'memory', name));
    mkdirSync(join(h, '.gemini'));
    copyFileSync(join(FIXTURES, 'gemini', 'GEMINI.md'), join(h, '.gemini', 'GEMINI.md'));
    return { home: h, memory: join(folder, 'memory') };
  }

  it('reads nothing until consent v2 is accepted', () => {
    const { home: h } = home();
    disableLessonsSharing();
    expect(syncLessonSources(h)).toMatchObject({ consent: false, sources: 0 });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM lessons').get() as { n: number }).n).toBe(0);
  });

  it('harvests every host under its project, and deletes rows when a file goes away', () => {
    const { home: h, memory } = home();
    enableLessonsSharing();

    const first = syncLessonSources(h);
    expect(first).toMatchObject({ consent: true, sources: 4, harvested: 3, skipped: 1, unresolvedProjects: 0 });
    const identities = getDb().prepare('SELECT DISTINCT source_cli, project_identity, project_label FROM lessons ORDER BY source_cli').all();
    expect(identities).toEqual([
      { source_cli: 'claude', project_identity: expect.stringMatching(/^(git|path):/), project_label: 'demo' },
      { source_cli: 'gemini', project_identity: 'global:gemini', project_label: null },
    ]);

    unlinkSync(join(memory, 'project_release_gotchas.md'));
    const second = syncLessonSources(h);
    expect(second.removed).toBe(5);
    expect(rows('claude')).toHaveLength(1);
  });
});
