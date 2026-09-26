// Is transcript capture still keeping up with each host, or has it gone quiet?
//
// Capture reads each host's own session files, whose formats belong to other
// projects and change without notice. When one changes, capture does not fail —
// it archives nothing, and nothing says so (five such bugs were found in one
// audit on 2026-09-15). The tell is simple: the user saved a Veto session from a
// host AFTER that host's newest archive, and that host has newer session files
// on disk, yet nothing new was archived. That is what this reports.
//
// Read-only and deterministic: archive rows, the sessions table, file mtimes.

import { getDb } from '../memory/local.js';
import { listArchives } from './manage.js';
import { discoverCodexSessions, discoverGeminiSessions } from './discover.js';

export type SourceFreshness = {
  source: 'claude' | 'codex' | 'gemini';
  newestArchive: string | null;
  lastSaveFromHost: string | null;
  newestOnDisk: string | null;
  /** A save came through this host after its newest archive, and newer files exist, yet nothing was archived. */
  stalled: boolean;
};

/** A save from a host more than this long after its newest archive, with nothing archived since, is a stall. */
const GRACE_MS = 2 * 60 * 60 * 1000;

export function captureFreshness(options: { discover?: boolean; captureSince?: string | null; sources?: ReadonlyArray<'claude' | 'codex' | 'gemini'> } = {}): SourceFreshness[] {
  const archives = listArchives({ limit: 500 });
  const db = getDb();
  const out: SourceFreshness[] = [];
  // Only hosts that are installed: a save labelled "gemini" on a machine without
  // Gemini CLI came from somewhere else, and its capture cannot be "stalled".
  for (const source of options.sources ?? (['claude', 'codex', 'gemini'] as const)) {
    const newestArchive = archives.filter(a => a.source === source).map(a => a.updatedAt).sort().pop() ?? null;
    const lastSave = (db.prepare('SELECT MAX(created_at) AS t FROM sessions WHERE lower(platform) = ?').get(source) as { t: string | null }).t;
    let newestOnDisk: string | null = null;
    if (options.discover !== false && source !== 'claude') {
      try {
        const found = source === 'codex' ? discoverCodexSessions(50) : discoverGeminiSessions(50);
        const t = Math.max(0, ...found.map(f => f.mtimeMs));
        newestOnDisk = t > 0 ? new Date(t).toISOString() : null;
      } catch { /* discovery is best-effort */ }
    }
    const stalled = isStalled({ source, newestArchive, lastSave, newestOnDisk, captureSince: options.captureSince ?? null });
    out.push({ source, newestArchive, lastSaveFromHost: lastSave, newestOnDisk, stalled });
  }
  return out;
}

/** The stall rule on its own, so it can be tested without a database. ISO strings throughout. */
export function isStalled(s: { source: 'claude' | 'codex' | 'gemini'; newestArchive: string | null; lastSave: string | null; newestOnDisk: string | null; captureSince: string | null }): boolean {
  const saveAfterArchive = !!s.lastSave && (!s.newestArchive || Date.parse(s.lastSave) - Date.parse(s.newestArchive) > GRACE_MS);
  // Claude's files are found per project at save time, so there is no global "newest on disk" to compare.
  const newerFiles = s.source === 'claude' ? true : !!s.newestOnDisk && (!s.newestArchive || s.newestOnDisk > s.newestArchive);
  // A host never saved from is not "stalled". One that has never been archived
  // counts only for saves made after capture was switched on.
  if (s.newestArchive) return saveAfterArchive && newerFiles;
  const savedSinceCaptureOn = !!s.lastSave && !!s.captureSince && s.lastSave > s.captureSince;
  return savedSinceCaptureOn && newerFiles;
}
