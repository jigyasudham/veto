// Reads .gitignore + optional .vetoignore and returns a pattern matcher.
// Used by the repo-map, project map scanning, and code analysis to skip generated/vendor files.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Always-skip directories — regardless of ignore files
export const ALWAYS_SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.next', 'dist', 'build', 'target',
  '.cache', 'coverage', '.venv', 'venv', '.idea', '.vs', 'out', '.turbo',
  '.nuxt', '.svelte-kit', '.output', 'vendor', 'bower_components', '.parcel-cache',
]);

export interface IgnoreRules {
  patterns: string[];          // raw pattern strings for display/debug
  shouldIgnore: (relativePath: string) => boolean;
}

function parseIgnoreFile(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function globToRegex(pattern: string): RegExp | null {
  try {
    // Strip leading slash
    const p = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    // Escape regex specials except * and ?
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§GLOBSTAR§')   // ** → match anything including /
      .replace(/\*/g, '[^/]*')           // * → match anything except /
      .replace(/§GLOBSTAR§/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${escaped}(/|$)`);
  } catch {
    return null;
  }
}

export function loadIgnoreRules(projectDir: string): IgnoreRules {
  const gitIgnorePath = join(projectDir, '.gitignore');
  const vetoIgnorePath = join(projectDir, '.vetoignore');

  const patterns = [
    ...parseIgnoreFile(gitIgnorePath),
    ...parseIgnoreFile(vetoIgnorePath),
  ];

  const regexes = patterns
    .map(globToRegex)
    .filter((r): r is RegExp => r !== null);

  return {
    patterns,
    shouldIgnore(relativePath: string): boolean {
      const normalized = relativePath.replace(/\\/g, '/');
      const parts = normalized.split('/');
      // Fast path: check any path segment against ALWAYS_SKIP
      if (parts.some(p => ALWAYS_SKIP.has(p))) return true;
      // Pattern match
      return regexes.some(r => r.test(normalized));
    },
  };
}

export function shouldSkipDir(name: string): boolean {
  return ALWAYS_SKIP.has(name);
}
