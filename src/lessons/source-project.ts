// Which project does a Claude memory folder belong to?
//
// Claude Code keeps a project's memory in ~/.claude/projects/<slug>/memory,
// where <slug> is the project's cwd with every non-alphanumeric character
// replaced by '-'. The slug is lossy (D:\a-b and D:\a\b share one), so it is
// reversed from evidence, most reliable first:
//   1. a transcript in the same folder recording its `cwd` (Claude deletes
//      these after about 30 days, so many folders have none left);
//   2. a project directory Veto already knows about with the same slug;
//   3. a walk down from the drive or filesystem root, entering only folders
//      whose own slug prefixes what is left. The walk is bounded, and more
//      than one match counts as unresolved.
// Unresolved folders keep a slug identity that matches no other project.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../memory/local.js';
import { claudeProjectSlug, sameClaudeSlug } from '../transcripts/claude-paths.js';

export { claudeProjectSlug, sameClaudeSlug };

const HEAD_BYTES = 256 * 1024;
const TRANSCRIPTS_TO_TRY = 3;
const WALK_BUDGET = 400;
const WALK_DEPTH = 16;
const win32 = process.platform === 'win32';

function readHead(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function cwdFromTranscripts(folder: string, slug: string): string | null {
  let names: string[];
  try { names = readdirSync(folder).filter(name => name.endsWith('.jsonl')); } catch { return null; }
  const newest = names
    .map(name => { try { return { path: join(folder, name), mtime: statSync(join(folder, name)).mtimeMs }; } catch { return null; } })
    .filter((entry): entry is { path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, TRANSCRIPTS_TO_TRY);
  for (const { path } of newest) {
    for (const match of readHead(path).matchAll(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      try {
        const cwd = JSON.parse(match[1]) as string;
        if (cwd && sameClaudeSlug(claudeProjectSlug(cwd), slug)) return cwd;
      } catch { /* a truncated field at the end of the head */ }
    }
  }
  return null;
}

function cwdFromKnownProjects(slug: string): string | null {
  const db = getDb();
  // Keyed case-folded on Windows so D:\Veto and d:\veto count once; the first
  // spelling seen (sessions before the case-folded alias table) is kept.
  const found = new Map<string, string>();
  for (const sql of [
    'SELECT DISTINCT project_dir AS dir FROM sessions WHERE project_dir IS NOT NULL',
    'SELECT alias_path AS dir FROM project_identity_aliases',
  ]) {
    try {
      for (const { dir } of db.prepare(sql).all() as Array<{ dir: string }>) {
        const key = (win32 ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '');
        if (sameClaudeSlug(claudeProjectSlug(dir), slug) && !found.has(key)) found.set(key, dir);
      }
    } catch { /* table absent in an old database */ }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

function cwdFromWalk(slug: string): string | null {
  const drive = /^([A-Za-z])--(.*)$/.exec(slug);
  let root: string;
  let rest: string;
  if (win32 && drive) { root = `${drive[1]}:\\`; rest = drive[2]; }
  else if (!win32 && slug.startsWith('-')) { root = '/'; rest = slug.slice(1); }
  else return null;

  const matches: string[] = [];
  let budget = WALK_BUDGET;
  const visit = (dir: string, remaining: string, depth: number): void => {
    if (matches.length > 1 || budget-- <= 0 || depth > WALK_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const part = claudeProjectSlug(entry.name);
      if (sameClaudeSlug(part, remaining)) { matches.push(join(dir, entry.name)); continue; }
      const prefix = `${part}-`;
      if (sameClaudeSlug(remaining.slice(0, prefix.length), prefix)) visit(join(dir, entry.name), remaining.slice(prefix.length), depth + 1);
    }
  };
  if (rest) visit(root, rest, 0);
  return matches.length === 1 ? matches[0] : null;
}

export type ClaudeFolderProject = { projectDir: string | null; via: 'transcript' | 'known' | 'walk' | 'unresolved' };

/** Resolve a ~/.claude/projects/<slug> folder to the project directory it was created for. */
export function resolveClaudeProjectFolder(folder: string, slug: string): ClaudeFolderProject {
  const fromTranscript = cwdFromTranscripts(folder, slug);
  if (fromTranscript) return { projectDir: fromTranscript, via: 'transcript' };
  const known = cwdFromKnownProjects(slug);
  if (known) return { projectDir: known, via: 'known' };
  const walked = cwdFromWalk(slug);
  if (walked) return { projectDir: walked, via: 'walk' };
  return { projectDir: null, via: 'unresolved' };
}
