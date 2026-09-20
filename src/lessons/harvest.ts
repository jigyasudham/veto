import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, relative, isAbsolute } from 'node:path';
import { isLessonsSharingEnabled } from '../memory/config.js';
import { parseNativeMemory, type LessonSource } from './adapters/index.js';
import { classifyLesson } from './classify.js';
import { discoverNativeMemorySources, type NativeMemorySource } from './discover.js';
import { projectNames, resolveProjectIdentity } from './identity.js';
import { maskLessonText } from './mask.js';
import { resolveClaudeProjectFolder } from './source-project.js';
import {
  deleteLessonSource, disableLessonSource, isLessonSourceEnabled, isProjectExcluded, lessonFileState,
  purgeVanishedLessonFileState, purgeVanishedLessonSources, recordLessonFileState, recordLessonFileUnavailable,
  syncLessons, unresolvedProjectCount, type HarvestedSection,
} from './store.js';

/**
 * Bump when anything that decides what a file yields changes: this harvester,
 * the adapters, mask.ts or classify.ts. Every remembered file fingerprint is
 * invalidated, so the next pass re-reads and re-classifies everything.
 * `tests/lessons-harvester-version.test.ts` fails if those files change
 * without this being bumped, so the reminder is not a comment alone.
 */
export const HARVESTER_VERSION = 1;

/**
 * A memory file is a hand-written note; anything this large is not one. The
 * cap stops an unbounded read on the save path (council 534e2bd5, security).
 */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * After this many passes in a row where a file could not be read, a save stops
 * probing it. Reading it is what costs seconds when the drive holding it is no
 * longer plugged in, and a save must not wait for that. A command still tries
 * every time, so plugging the drive back in and running `veto lessons` works.
 */
const UNAVAILABLE_BACKOFF_AFTER = 3;

export type HarvestOutcome =
  | { status: 'harvested'; inserted: number; updated: number; removed: number }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: 'empty' | 'index' | 'veto-authored'; removed: number }
  | { status: 'disabled' | 'unavailable'; reason: string };

/**
 * A memory file is followed only while it really lives inside the user's home
 * directory — a dotfiles checkout is a real setup worth supporting, but a link
 * dropped into a memory folder must not turn the harvester into a reader of
 * arbitrary files elsewhere on the machine.
 *
 * The whole path is resolved, not just its last part: a symlinked *folder*
 * anywhere above the file leads out of home just as effectively, and testing
 * only the file itself would not notice.
 */
function resolvesOutsideHome(sourcePath: string): boolean {
  try {
    const target = realpathSync(sourcePath);
    const home = realpathSync(homedir());
    const rel = relative(home, target);
    return rel.startsWith('..') || isAbsolute(rel);
  } catch { return true; }
}

/**
 * Everything that decides what this file yields: its bytes, and the project
 * identity and names that classification reads. Identity is part of it because
 * an alias can move a file to another project without touching its contents —
 * skipping on content alone would silently ignore `veto lessons alias`.
 */
function fingerprint(raw: string, input: { projectIdentity: string; projectLabel?: string | null; projectNames?: string[]; global?: boolean }): string {
  return createHash('sha256')
    .update(raw).update('\u0000')
    .update(input.projectIdentity).update('\u0000')
    .update(input.projectLabel ?? '').update('\u0000')
    .update((input.projectNames ?? []).join('\u0000')).update('\u0000')
    .update(input.global === true ? '1' : '0')
    .digest('hex');
}

/**
 * Read and harvest a single host-native memory file. The source is only ever
 * opened for reading. An unrecognised shape disables that host's harvester
 * (the format-drift canary) and leaves its existing rows untouched; selection
 * stops serving them while the host is disabled.
 */
export function harvestNativeMemory(input: {
  source: LessonSource;
  sourcePath: string;
  projectIdentity: string;
  projectLabel?: string | null;
  /** The project's own names; a note naming its project stays project scope. */
  projectNames?: string[];
  global?: boolean;
  /** Ignore what this file looked like last time and read it again regardless. */
  forced?: boolean;
}): HarvestOutcome {
  if (!isLessonSourceEnabled(input.source)) return { status: 'disabled', reason: 'source disabled after format drift' };
  if (resolvesOutsideHome(input.sourcePath)) {
    return { status: 'unavailable', reason: 'memory file resolves outside your home folder and was not read' };
  }

  // Stat first: an unchanged file costs this and nothing more. No transaction
  // is opened on this path, so a quiet pass takes no write lock at all.
  let size: number;
  let mtime: string;
  try {
    const stat = statSync(input.sourcePath);
    size = stat.size;
    mtime = stat.mtime.toISOString();
  } catch {
    recordLessonFileUnavailable(input.source, input.sourcePath);
    return { status: 'unavailable', reason: 'native memory file could not be read' };
  }
  if (size > MAX_SOURCE_BYTES) {
    // Left alone rather than emptied: this is a file we declined to read, not
    // a file we read and found nothing in.
    return { status: 'unavailable', reason: `memory file is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)} MB and was not read` };
  }

  const known = input.forced ? null : lessonFileState(input.source, input.sourcePath);
  // Identity is part of the comparison because an alias, or a drive coming
  // back, moves a file to another project without touching a byte of it. It
  // costs nothing here: the caller has already worked out which project this
  // file belongs to.
  const current = known?.harvester_version === HARVESTER_VERSION && known?.project_identity === input.projectIdentity;
  if (current && known?.mtime === mtime && known?.size === size) return { status: 'unchanged' };

  let raw: string;
  try {
    raw = readFileSync(input.sourcePath, 'utf8');
  } catch {
    recordLessonFileUnavailable(input.source, input.sourcePath);
    return { status: 'unavailable', reason: 'native memory file could not be read' };
  }

  // mtime moved but the content did not — a touch, a sync tool, a restore.
  // Remember the new mtime so the cheap path hits next time, and parse nothing.
  const digest = fingerprint(raw, input);
  const remember = (): void => recordLessonFileState({
    source: input.source, sourcePath: input.sourcePath, mtime, size, contentHash: digest,
    projectIdentity: input.projectIdentity, harvesterVersion: HARVESTER_VERSION,
  });
  if (current && known?.content_hash === digest) {
    remember();
    return { status: 'unchanged' };
  }
  const fileName = basename(input.sourcePath);
  const parsed = parseNativeMemory(input.source, raw, fileName);
  if (!parsed.ok) {
    disableLessonSource(input.source, `${fileName}: ${parsed.reason}`);
    return { status: 'disabled', reason: parsed.reason };
  }
  const base = { sourceCli: input.source, sourcePath: input.sourcePath, projectIdentity: input.projectIdentity, projectLabel: input.projectLabel ?? null, sourceMtime: mtime };
  if ('skip' in parsed) {
    const removed = syncLessons({ ...base, sections: [] }).removed;
    remember();
    return { status: 'skipped', reason: parsed.skip, removed };
  }
  const sections: HarvestedSection[] = parsed.sections.map(section => {
    const masked = maskLessonText(section.text);
    const classified = classifyLesson({
      source: input.source, fileName, global: input.global === true, frontmatter: parsed.frontmatter,
      section, maskedText: masked.text, secrets: masked.secrets, projectNames: input.projectNames,
    });
    return { anchor: section.anchor, textMasked: masked.text, ...classified };
  });
  const synced = syncLessons({ ...base, sections });
  remember();
  return { status: 'harvested', ...synced };
}

export type LessonSyncReport = {
  consent: boolean;
  sources: number;
  harvested: number;
  /** Files whose bytes and project are what they were last time; nothing was parsed. */
  unchanged: number;
  skipped: number;
  disabled: number;
  unavailable: number;
  /** Sources belonging to a project kept out of sharing; nothing of theirs is stored. */
  excluded: number;
  inserted: number;
  updated: number;
  removed: number;
  unresolvedProjects: number;
  /** Files the pass never reached because it ran out of its time budget. */
  notReached: number;
  elapsedMs: number;
};

export type SyncOptions = {
  home?: string;
  /** Re-read every file even if it looks untouched. Policy changes need this. */
  forced?: boolean;
  /**
   * Stop once this many milliseconds have gone, checked before every file.
   * What is left waits for the next pass; the work is idempotent, so nothing
   * is lost by stopping. Only the save path sets it.
   */
  budgetMs?: number;
};

type SourceProject = { identity: string; label: string | null; names: string[] };

function sourceProject(source: NativeMemorySource, folders: Map<string, SourceProject>): SourceProject {
  if (source.global || !source.claudeFolder || !source.claudeSlug) return { identity: `global:${source.source}`, label: null, names: [] };
  const cached = folders.get(source.claudeFolder);
  if (cached) return cached;
  const { projectDir } = resolveClaudeProjectFolder(source.claudeFolder, source.claudeSlug);
  const resolved = projectDir
    ? { identity: resolveProjectIdentity(projectDir), label: basename(projectDir.replace(/[\\/]+$/, '')) || projectDir, names: projectNames(projectDir) }
    : { identity: `claude-slug:${source.claudeSlug}`, label: source.claudeSlug, names: [] };
  folders.set(source.claudeFolder, resolved);
  return resolved;
}

/**
 * Whether a file can be passed over without reading it or resolving which
 * project it belongs to. Deliberately cheap: one stat and one indexed read.
 * Project resolution is the expensive part of a pass — it can walk a drive
 * root — so a quiet pass must never get that far.
 */
function untouchedSince(source: NativeMemorySource, recheckUnresolved: boolean): boolean | 'gone' {
  const known = lessonFileState(source.source, source.sourcePath);
  if (!known) return false;
  // A file that has failed to be read this many times running is treated as
  // gone until a command looks for it again; even the stat is skipped, because
  // the stat is the part that hangs.
  if (!recheckUnresolved && known.unavailable_streak >= UNAVAILABLE_BACKOFF_AFTER) return 'gone';
  if (known.harvester_version !== HARVESTER_VERSION) return false;
  // A folder never traced to a directory on this machine may become traceable
  // when a drive is plugged back in, and only resolving it again would notice.
  // A pass with time to spare looks; a save does not, because that lookup is
  // the one that walks a drive root.
  if (recheckUnresolved && known.project_identity?.startsWith('claude-slug:')) return false;
  try {
    const stat = statSync(source.sourcePath);
    return known.mtime === stat.mtime.toISOString() && known.size === stat.size;
  } catch { return false; }
}

/**
 * One pass: discover every known native-memory file, harvest what changed
 * under its project's identity, and delete rows whose file has gone. Nothing
 * is read until the user has accepted consent v2, and an excluded project's
 * files are never read at all.
 *
 * A pass given a budget stops cleanly when it runs out and reports what it did
 * not reach. Every step is idempotent, so the next pass simply carries on.
 */
export function syncLessonSources(options: string | SyncOptions = {}): LessonSyncReport {
  const opts: SyncOptions = typeof options === 'string' ? { home: options } : options;
  const started = Date.now();
  const report: LessonSyncReport = {
    consent: isLessonsSharingEnabled(), sources: 0, harvested: 0, unchanged: 0, skipped: 0, disabled: 0, unavailable: 0, excluded: 0,
    inserted: 0, updated: 0, removed: 0, unresolvedProjects: 0, notReached: 0, elapsedMs: 0,
  };
  if (!report.consent) return report;
  const sources = discoverNativeMemorySources(opts.home);
  report.sources = sources.length;
  const folders = new Map<string, SourceProject>();
  // Only a pass that is not racing a save can afford to look for folders that
  // were unresolved last time.
  const recheckUnresolved = opts.budgetMs === undefined;
  let index = 0;
  for (const source of sources) {
    // Checked before every file, not once at the start: a single slow stat on
    // a drive that is no longer plugged in must not carry the whole pass past
    // its bound (council 534e2bd5, devil).
    if (opts.budgetMs !== undefined && Date.now() - started >= opts.budgetMs) {
      report.notReached = sources.length - index;
      break;
    }
    index++;
    if (!opts.forced) {
      const state = untouchedSince(source, recheckUnresolved);
      if (state === 'gone') { report.unavailable++; continue; }
      if (state) { report.unchanged++; continue; }
    }

    const project = sourceProject(source, folders);
    if (isProjectExcluded(project.identity)) {
      // Not even read: an excluded project's notes never reach the store.
      report.excluded++;
      report.removed += deleteLessonSource(source.source, source.sourcePath);
      continue;
    }
    const outcome = harvestNativeMemory({
      source: source.source, sourcePath: source.sourcePath, projectIdentity: project.identity,
      projectLabel: project.label, projectNames: project.names, global: source.global, forced: opts.forced,
    });
    report[outcome.status]++;
    if (outcome.status === 'harvested') { report.inserted += outcome.inserted; report.updated += outcome.updated; report.removed += outcome.removed; }
    if (outcome.status === 'skipped') report.removed += outcome.removed;
  }
  report.unresolvedProjects = unresolvedProjectCount();
  // A pass cut short has not seen every source, so it cannot conclude that a
  // missing one is gone for good.
  if (report.notReached === 0) {
    report.removed += purgeVanishedLessonSources(sources);
    purgeVanishedLessonFileState(sources);
  }
  report.elapsedMs = Date.now() - started;
  return report;
}
