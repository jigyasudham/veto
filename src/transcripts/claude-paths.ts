// Where Claude Code keeps a project's files, shared by transcript capture and
// lesson harvesting.
//
// ~/.claude/projects/<slug>/ holds one <session-uuid>.jsonl per session (plus
// <uuid>/subagents/*.jsonl side chains) and the project's memory/ folder.
// <slug> is the cwd with every non-alphanumeric character replaced by '-', so
// D:\Veto becomes D--Veto. CLAUDE_CONFIG_DIR relocates ~/.claude.

import { homedir } from 'node:os';
import { join } from 'node:path';

const win32 = process.platform === 'win32';

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export function claudeProjectSlug(projectDir: string): string {
  return projectDir.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Folder names compare case-insensitively on Windows: D--Veto and d--Veto are one project there. */
export function sameClaudeSlug(a: string, b: string): boolean {
  return win32 ? a.toLowerCase() === b.toLowerCase() : a === b;
}
