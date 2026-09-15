import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/memory/local.js';
import { addProjectAlias, computeProjectIdentity, normalizeRemote, projectNames, resolveProjectIdentity } from '../../src/lessons/identity.js';
import { claudeProjectSlug, resolveClaudeProjectFolder } from '../../src/lessons/source-project.js';

const roots: string[] = [];
const root = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-identity-'))); roots.push(dir); return dir; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
// The root message is the folder path: two empty commits with the same author,
// message and second would otherwise be the SAME commit.
function repo(dir: string, remote?: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', `root of ${dir}`);
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

let ceiling: string | undefined;
beforeEach(() => {
  resetDb();
  // Keep git from finding a repository above the temp folders.
  ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
});
afterEach(() => {
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('project identity', () => {
  it.each([
    'https://github.com/Owner/Repo.git',
    'https://github.com/owner/repo/',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://user:secret-token@github.com/owner/repo',
  ])('normalizes %s to one remote', (url) => {
    expect(normalizeRemote(url)).toBe('github.com/owner/repo');
  });

  it('does not change when HEAD moves', () => {
    const dir = repo(join(root(), 'a'), 'https://github.com/o/r.git');
    const before = computeProjectIdentity(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(before).toMatch(/^git:[0-9a-f]{16}$/);
    expect(computeProjectIdentity(dir)).toBe(before);
  });

  it('unifies two checkouts of one repository, whatever their paths', () => {
    const base = root();
    const original = repo(join(base, 'D', 'app'), 'git@github.com:o/r.git');
    execFileSync('git', ['clone', '-q', original, join(base, 'F', 'copy')], { stdio: 'ignore' });
    git(join(base, 'F', 'copy'), 'remote', 'set-url', 'origin', 'https://github.com/o/r');
    expect(computeProjectIdentity(join(base, 'F', 'copy'))).toBe(computeProjectIdentity(original));
  });

  it('keeps unrelated histories apart even under the same remote', () => {
    const base = root();
    expect(computeProjectIdentity(repo(join(base, 'one'), 'https://github.com/o/r')))
      .not.toBe(computeProjectIdentity(repo(join(base, 'two'), 'https://github.com/o/r')));
  });

  it('falls back to the path, and re-checks it once the folder gains history', () => {
    const dir = join(root(), 'plain');
    mkdirSync(dir);
    expect(resolveProjectIdentity(dir)).toMatch(/^path:/);
    repo(dir);
    expect(resolveProjectIdentity(dir)).toMatch(/^git:/);
  });

  it("names a project by its folder and its origin repository", () => {
    const dir = repo(join(root(), 'checkout'), 'git@github.com:owner/demo-app.git');
    expect(projectNames(dir)).toEqual(['checkout', 'demo-app']);
  });

  it('keeps an alias set by hand', () => {
    const base = root();
    const identity = resolveProjectIdentity(repo(join(base, 'main')));
    const copy = join(base, 'copy-without-git');
    mkdirSync(copy);
    addProjectAlias(copy, identity);
    expect(resolveProjectIdentity(copy)).toBe(identity);
  });
});

describe('Claude memory folder → project', () => {
  function folderFor(base: string, projectDir: string, transcriptCwd?: string): { folder: string; slug: string } {
    const slug = claudeProjectSlug(projectDir);
    const folder = join(base, 'projects', slug);
    mkdirSync(join(folder, 'memory'), { recursive: true });
    if (transcriptCwd) writeFileSync(join(folder, 'session.jsonl'), `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd: transcriptCwd })}\n`);
    return { folder, slug };
  }

  it('reads the project from a transcript in the folder', () => {
    const base = root();
    const project = join(base, 'work', 'my app');
    const { folder, slug } = folderFor(base, project, project);
    expect(resolveClaudeProjectFolder(folder, slug)).toEqual({ projectDir: project, via: 'transcript' });
  });

  it('ignores a transcript cwd that does not produce the folder slug', () => {
    const base = root();
    const project = join(base, 'nowhere-a');
    const { folder, slug } = folderFor(base, project, join(base, 'somewhere-else'));
    expect(resolveClaudeProjectFolder(folder, slug).via).not.toBe('transcript');
  });

  it('uses a project Veto already knows when no transcript is left', () => {
    const base = root();
    const project = join(base, 'known project');
    addProjectAlias(project, 'git:0000000000000000');
    const { folder, slug } = folderFor(base, project);
    expect(resolveClaudeProjectFolder(folder, slug).via).toBe('known');
  });

  it('walks the disk when nothing else knows the folder', () => {
    const base = root();
    const project = join(base, 'walk me', 'sub-dir');
    mkdirSync(project, { recursive: true });
    const { folder, slug } = folderFor(join(base, 'claude'), project);
    expect(resolveClaudeProjectFolder(folder, slug)).toEqual({ projectDir: project, via: 'walk' });
  });

  it('leaves a slug that fits two folders unresolved', () => {
    const base = root();
    mkdirSync(join(base, 'x', 'a-b'), { recursive: true });
    mkdirSync(join(base, 'x', 'a', 'b'), { recursive: true });
    const { folder, slug } = folderFor(join(base, 'claude'), join(base, 'x', 'a-b'));
    expect(resolveClaudeProjectFolder(folder, slug)).toEqual({ projectDir: null, via: 'unresolved' });
  });
});
