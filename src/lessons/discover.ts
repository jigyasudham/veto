import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { LessonSource } from './adapters/index.js';

export type NativeMemorySource = {
  source: LessonSource;
  sourcePath: string;
  fileName: string;
  mtimeMs: number;
  /** A host-wide file every session of that host loads, not tied to a project. */
  global: boolean;
  /** Claude only: the ~/.claude/projects/<slug> folder the entry lives in. */
  claudeFolder?: string;
  claudeSlug?: string;
};

function candidate(source: LessonSource, sourcePath: string, extra: Partial<NativeMemorySource> = {}): NativeMemorySource | null {
  try {
    const stat = statSync(sourcePath);
    return stat.isFile() ? { source, sourcePath, fileName: basename(sourcePath), mtimeMs: stat.mtimeMs, global: false, ...extra } : null;
  } catch { return null; }
}

function claudeMemoryFiles(claudeHome: string): NativeMemorySource[] {
  const projects = join(claudeHome, 'projects');
  if (!existsSync(projects)) return [];
  const out: NativeMemorySource[] = [];
  let folders;
  try { folders = readdirSync(projects, { withFileTypes: true }); } catch { return out; }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const claudeFolder = join(projects, folder.name);
    const memory = join(claudeFolder, 'memory');
    let files;
    try { files = readdirSync(memory, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith('.md')) continue;
      const found = candidate('claude', join(memory, file.name), { claudeFolder, claudeSlug: folder.name });
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * Known native-memory locations only; discovery reads directory listings and
 * file metadata and performs no writes. CODEX_HOME relocates ~/.codex, as it
 * does for Codex itself.
 */
export function discoverNativeMemorySources(home = homedir()): NativeMemorySource[] {
  const codexHome = home === homedir() && process.env.CODEX_HOME ? process.env.CODEX_HOME : join(home, '.codex');
  const out = claudeMemoryFiles(join(home, '.claude'));
  for (const path of [join(codexHome, 'AGENTS.md'), join(codexHome, 'AGENTS.override.md')]) {
    const found = candidate('codex', path, { global: true });
    if (found) out.push(found);
  }
  const gemini = candidate('gemini', join(home, '.gemini', 'GEMINI.md'), { global: true });
  if (gemini) out.push(gemini);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
