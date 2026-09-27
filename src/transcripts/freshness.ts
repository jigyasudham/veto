// Is transcript capture still keeping up with each host, or has it gone quiet?
//
// Capture reads each host's own session files, whose formats belong to other
// projects and change without notice. When one changes, capture does not fail —
// it archives nothing, and nothing says so (five such bugs were found in one
// audit on 2026-09-15). The tell is simple: the user saved a Veto session from a
// host AFTER that host's newest archive, and that host has newer session files
// on disk, yet nothing new was archived. That is what this reports.
//
// Read-only and deterministic: archive rows, the sessions table, file mtimes,
// the host-start ledger.

import { getDb } from '../memory/local.js';
import { readHostStarts, startsForHost, type HostStart } from '../host-starts.js';
import { listArchives } from './manage.js';
import { discoverAntigravitySessions, discoverCodexSessions, discoverGeminiSessions } from './discover.js';
import { TRANSCRIPT_SOURCES, type TranscriptSource } from './adapters/index.js';

export type SourceFreshness = {
  source: TranscriptSource;
  newestArchive: string | null;
  lastSaveFromHost: string | null;
  newestOnDisk: string | null;
  /** A save came through this host after its newest archive, and newer files exist, yet nothing was archived. */
  stalled: boolean;
  /** This host has not yet started a Veto that captures it (see CAPTURED_SINCE), so there is nothing to judge. */
  awaitingUpgrade?: boolean;
};

/** A save from a host more than this long after its newest archive, with nothing archived since, is a stall. */
const GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * The Veto version that first captured each source added after capture shipped.
 * Saves made through an older Veto skipped capture on purpose, so they must not
 * read as a stall — Antigravity's did, from every 3.7.1 install, the moment
 * 3.8.0 could capture it.
 */
export const CAPTURED_SINCE: Partial<Record<TranscriptSource, string>> = { antigravity: '3.8.0' };

function atLeast(version: string, min: string): boolean {
  const a = version.split('.').map(n => parseInt(n, 10) || 0);
  const b = min.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * When this host first ran a Veto that captures it, from the host-start ledger.
 * Undefined when the source needs no such version; null when the host has not
 * run one yet.
 */
export function capturedSinceFor(source: TranscriptSource, starts: HostStart[]): string | null | undefined {
  const min = CAPTURED_SINCE[source];
  if (!min) return undefined;
  const times = startsForHost(source, starts)
    .filter(s => atLeast(s.veto_version, min))
    .map(s => s.version_since ?? s.first_seen)
    .sort();
  return times[0] ?? null;
}

export function captureFreshness(options: { discover?: boolean; captureSince?: string | null; sources?: ReadonlyArray<TranscriptSource>; starts?: HostStart[] } = {}): SourceFreshness[] {
  const archives = listArchives({ limit: 500 });
  const db = getDb();
  const starts = options.starts ?? readHostStarts();
  const out: SourceFreshness[] = [];
  // Only hosts that are installed: a save labelled "gemini" on a machine without
  // Gemini CLI came from somewhere else, and its capture cannot be "stalled".
  for (const source of options.sources ?? TRANSCRIPT_SOURCES) {
    const newestArchive = archives.filter(a => a.source === source).map(a => a.updatedAt).sort().pop() ?? null;
    const lastSave = (db.prepare('SELECT MAX(created_at) AS t FROM sessions WHERE lower(platform) = ?').get(source) as { t: string | null }).t;
    const supportedSince = capturedSinceFor(source, starts);
    if (supportedSince === null && !newestArchive) {
      out.push({ source, newestArchive, lastSaveFromHost: lastSave, newestOnDisk: null, stalled: false, awaitingUpgrade: true });
      continue;
    }
    // Saves made before this host ran a Veto that captures it could not have been archived.
    const captureSince = [options.captureSince ?? null, supportedSince ?? null].filter((t): t is string => !!t).sort().pop() ?? null;
    let newestOnDisk: string | null = null;
    if (options.discover !== false && source !== 'claude') {
      try {
        // The discover* functions only read; discoverSessions would also record mappings.
        const find = source === 'codex' ? discoverCodexSessions : source === 'gemini' ? discoverGeminiSessions : discoverAntigravitySessions;
        const found = find(50);
        const t = Math.max(0, ...found.map(f => f.mtimeMs));
        newestOnDisk = t > 0 ? new Date(t).toISOString() : null;
      } catch { /* discovery is best-effort */ }
    }
    const stalled = isStalled({ source, newestArchive, lastSave, newestOnDisk, captureSince });
    out.push({ source, newestArchive, lastSaveFromHost: lastSave, newestOnDisk, stalled });
  }
  return out;
}

/** The stall rule on its own, so it can be tested without a database. ISO strings throughout. */
export function isStalled(s: { source: TranscriptSource; newestArchive: string | null; lastSave: string | null; newestOnDisk: string | null; captureSince: string | null }): boolean {
  const saveAfterArchive = !!s.lastSave && (!s.newestArchive || Date.parse(s.lastSave) - Date.parse(s.newestArchive) > GRACE_MS);
  // Claude's files are found per project at save time, so there is no global "newest on disk" to compare.
  const newerFiles = s.source === 'claude' ? true : !!s.newestOnDisk && (!s.newestArchive || s.newestOnDisk > s.newestArchive);
  // A host never saved from is not "stalled". One that has never been archived
  // counts only for saves made after capture was switched on.
  if (s.newestArchive) return saveAfterArchive && newerFiles;
  const savedSinceCaptureOn = !!s.lastSave && !!s.captureSince && s.lastSave > s.captureSince;
  return savedSinceCaptureOn && newerFiles;
}
