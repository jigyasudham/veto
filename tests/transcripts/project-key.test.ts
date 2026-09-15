import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { projectKey, projectKeySql } from '../../src/transcripts/project-key.js';
import { normalizeProjectDir } from '../../src/memory/local.js';

// Both platform branches run on every OS: a Linux-only regression here once
// passed every local (Windows) run and failed only in CI.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Does a row stored the way Veto stores it (normalizeProjectDir on write) match a lookup? */
function sqlMatches(stored: string, lookup: string, platform: NodeJS.Platform, raw = false): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (project_dir TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(raw ? stored : normalizeProjectDir(stored));
    const row = db.prepare(`SELECT COUNT(*) AS n FROM t WHERE ${projectKeySql('project_dir', platform)} = ?`).get(projectKey(lookup, platform)) as { n: number };
    return row.n === 1;
  } finally {
    db.close();
  }
}

const SAME_EVERYWHERE: Array<[string, string]> = [
  ['D:\\Veto', 'd:\\Veto'],            // drive-letter case, as normalizeProjectDir always folded it
  ['d:\\Veto\\', 'd:\\Veto'],          // trailing separator
  ['/home/u/proj/', '/home/u/proj'],
];
const SAME_ON_WINDOWS_ONLY: Array<[string, string]> = [
  ['d:\\veto', 'D:\\Veto'],            // Gemini's lowercase record vs a save's spelling
  ['D:/Veto/', 'd:\\Veto'],            // either separator
];

describe.each(['win32', 'linux'] as const)('folder key on %s', (platform) => {
  it.each(SAME_EVERYWHERE)('treats %s and %s as one folder', (a, b) => {
    expect(projectKey(a, platform)).toBe(projectKey(b, platform));
    expect(sqlMatches(a, b, platform)).toBe(true);
    expect(sqlMatches(b, a, platform)).toBe(true);
  });

  it.each(SAME_ON_WINDOWS_ONLY)('folds %s / %s only where paths are case-insensitive', (a, b) => {
    const expected = platform === 'win32';
    expect(projectKey(a, platform) === projectKey(b, platform)).toBe(expected);
    expect(sqlMatches(a, b, platform)).toBe(expected);
  });

  it('matches a row stored before its drive letter was normalized', () => {
    expect(sqlMatches('D:\\Legacy', 'd:\\Legacy', platform, true)).toBe(true);
  });

  it('keeps different folders apart', () => {
    expect(projectKey('d:\\Veto', platform)).not.toBe(projectKey('d:\\Veto2', platform));
    expect(sqlMatches('d:\\Veto', 'd:\\Veto2', platform)).toBe(false);
  });
});
