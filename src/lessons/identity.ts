import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { getDb, normalizeProjectDir } from '../memory/local.js';

function git(projectDir: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null; }
  catch { return null; }
}

/**
 * The alias key for a checkout: absolute, no trailing separator, and on
 * Windows case-folded (D:\Veto and d:\veto are one folder there).
 */
export function canonicalProjectPath(projectDir: string): string {
  let path = resolve(projectDir);
  if (!/^[A-Za-z]:\\$|^\/$/.test(path)) path = path.replace(/[\\/]+$/, '');
  path = normalizeProjectDir(path);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** `git@host:o/r.git`, `https://user:tok@host/o/r` and `ssh://git@host/o/r` are one remote. */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(u);
  u = scp ? `${scp[1]}/${scp[2]}` : u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  return u.toLowerCase();
}

/**
 * A repository is identified by its origin remote and its ROOT commit(s),
 * never by where it is checked out, so the D:, F: and G: copies of one repo
 * share an identity. HEAD would not do: it moves with every commit. A folder
 * without git history falls back to its own path.
 */
export function computeProjectIdentity(projectDir: string): string {
  const roots = git(projectDir, ['rev-list', '--max-parents=0', 'HEAD']);
  if (roots) {
    const remote = git(projectDir, ['config', '--get', 'remote.origin.url']);
    const key = [remote ? normalizeRemote(remote) : '', ...roots.split(/\s+/).sort()].join('\n');
    return `git:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  }
  return `path:${canonicalProjectPath(projectDir)}`;
}

export function resolveProjectIdentity(projectDir: string): string {
  const alias = canonicalProjectPath(projectDir);
  const db = getDb();
  const known = db.prepare('SELECT project_identity FROM project_identity_aliases WHERE alias_path = ?').get(alias) as { project_identity: string } | undefined;
  // A git identity, or an alias set by hand, is final. Only this folder's own
  // path fallback is re-checked, so a folder that later gains git history
  // joins its other checkouts.
  if (known && known.project_identity !== `path:${alias}`) return known.project_identity;
  const identity = computeProjectIdentity(projectDir);
  if (known?.project_identity !== identity) addProjectAlias(projectDir, identity);
  return identity;
}

/**
 * What a project is called: its folder name and its origin repository's name.
 * A note naming its own project is about that project (see classify.ts).
 */
export function projectNames(projectDir: string): string[] {
  const names = new Set<string>();
  const folder = basename(projectDir.replace(/[\\/]+$/, ''));
  if (folder) names.add(folder);
  const remote = git(projectDir, ['config', '--get', 'remote.origin.url']);
  const repoName = remote ? normalizeRemote(remote).split('/').pop() : null;
  if (repoName) names.add(repoName);
  return [...names].filter(name => name.length >= 3);
}

/** Explicitly unify an additional checked-out path with an existing identity. */
export function addProjectAlias(aliasPath: string, projectIdentity: string): void {
  getDb().prepare(`INSERT INTO project_identity_aliases (alias_path, project_identity, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(alias_path) DO UPDATE SET project_identity = excluded.project_identity, updated_at = excluded.updated_at`)
    .run(canonicalProjectPath(aliasPath), projectIdentity, new Date().toISOString());
}
