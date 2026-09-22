// The `veto lessons` surface: what Veto has harvested from each AI's own
// memory, where each note may go, and the controls that stop it (council
// 320c40dc, UX conditions). Everything here reads or changes Veto's own tables;
// no host's memory file is ever written.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { getConfig, disableLessonsSharing, isLessonsSharingEnabled, LESSONS_CONSENT_VERSION } from '../memory/config.js';
import { getDb } from '../memory/local.js';
import { LESSON_SOURCES, type LessonSource } from './adapters/index.js';
import type { LessonScope, ScopeReason } from './classify.js';
import { syncLessonSources, type LessonSyncReport } from './harvest.js';
import { addProjectAlias, canonicalProjectPath, computeProjectIdentity, resolveProjectIdentity } from './identity.js';
import { claudeProjectSlug, sameClaudeSlug } from './source-project.js';
import {
  clearLessonFileState, clearLessonFolderState, disabledLessonSourceReasons, enableLessonSource, excludedProjects, excludeProject, includeProject, tombstoneLesson,
  type LessonRow, type ProjectExclusion,
} from './store.js';

export const HOST_NAMES: Record<LessonSource, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

/**
 * Re-read every source so what is shown matches the files as they are now.
 * Only with consent. A pass run from a command has no time budget: a person
 * waiting for output would rather wait than be told a half-truth.
 */
export function refreshLessons(home?: string, options: { forced?: boolean } = {}): LessonSyncReport | null {
  return isLessonsSharingEnabled() ? syncLessonSources({ home, forced: options.forced }) : null;
}

/**
 * Forget what every file looked like, so the next pass reads them all again.
 * Needed after a decision that changes what a file would yield without
 * touching the file: re-including a project, or pointing an alias somewhere
 * new. Without this the fast path would skip exactly the files that changed
 * meaning. An alias also changes which project a folder belongs to, so what
 * passes worked out about folders goes too.
 */
function invalidateHarvestedState(): void {
  clearLessonFileState();
  clearLessonFolderState();
}

export const lessonTitle = (row: LessonRow): string => row.text_masked.split('\n', 1)[0].trim();

const isGlobal = (identity: string): boolean => identity.startsWith('global:');

/** A project no session can ever open under: a Claude folder never traced to a directory, or a folder that is not there. */
function isUnresolved(identity: string): boolean {
  if (identity.startsWith('claude-slug:')) return true;
  if (!identity.startsWith('path:')) return false;
  try { return !statSync(identity.slice('path:'.length)).isDirectory(); } catch { return true; }
}

export function projectName(row: Pick<LessonRow, 'project_identity' | 'project_label'>): string {
  return isGlobal(row.project_identity) ? 'all projects' : row.project_label ?? row.project_identity;
}

/** The label every note carries: which AI wrote it, for which project, when. */
export function provenance(row: LessonRow): string {
  return `from ${HOST_NAMES[row.source_cli]} memory · ${projectName(row)} · ${row.source_mtime.slice(0, 10)}`;
}

export type LessonReach = 'any-project' | 'own-project' | 'nowhere';

/**
 * Where a note may be selected (select.ts `eligible`): project notes and held
 * notes only into their own project; the rest into any project. A held note
 * from a global file, or any note of a folder no session can open under, has
 * no project to go to.
 */
export function lessonReach(row: LessonRow): LessonReach {
  if (row.scope !== 'project' && row.quarantined === 0) return 'any-project';
  return isGlobal(row.project_identity) || isUnresolved(row.project_identity) ? 'nowhere' : 'own-project';
}

/** Which AIs may receive it. The AI that wrote it already reads it, except Claude in other folders. */
export function receivingHosts(row: LessonRow): string {
  if (row.source_cli === 'claude') return 'Codex and Gemini, and Claude working in another folder';
  return LESSON_SOURCES.filter(host => host !== row.source_cli).map(host => HOST_NAMES[host]).join(' and ')
    + ` (${HOST_NAMES[row.source_cli]} already reads it)`;
}

const SCOPE_REASONS: Record<ScopeReason, (row: LessonRow) => string> = {
  'global-file': row => `it is in ${HOST_NAMES[row.source_cli]}'s global file, which it reads in every project`,
  'names-project': row => `it names its own project (${projectName(row)}), so it is about that project`,
  'user-entry': () => 'Claude saved it as a note about you (type: user)',
  'feedback-entry': () => 'Claude saved it as feedback on how to work (type: feedback)',
  'environment-heading': () => "its heading is about this machine's shell, console or network",
  'project-default': () => 'anything not clearly about you or this machine stays with its project',
};

const QUARANTINE_REASONS: Record<string, string> = {
  sensitive: 'it is about secrets, credentials, identity or personal details',
  credential: 'it contains something that looks like a credential',
  url: 'it contains a web address',
  command: 'it contains a shell or network command',
  directive: 'it tells an AI to fetch, send or run something, or to ignore its instructions',
};

export const quarantineText = (reason: string | null): string => QUARANTINE_REASONS[reason ?? ''] ?? reason ?? '';

export type LessonExplanation = {
  row: LessonRow;
  provenance: string;
  scope: string;
  held: string | null;
  reach: string;
  hostDisabled: string | null;
};

export function explainLesson(row: LessonRow): LessonExplanation {
  const reason = row.scope_reason ? SCOPE_REASONS[row.scope_reason]?.(row) : null;
  const reach = lessonReach(row);
  const where = reach === 'any-project' ? 'any project'
    : reach === 'own-project' ? `${projectName(row)} only`
    : isGlobal(row.project_identity) ? 'nowhere: it is held back and has no project of its own'
    : 'nowhere yet: Veto cannot tell which folder this memory belongs to (see veto lessons alias)';
  return {
    row,
    provenance: provenance(row),
    scope: `${row.scope}: ${reason ?? 'classified before Veto recorded why'}`,
    held: row.quarantined ? `kept in its own project: ${quarantineText(row.quarantine_reason)}` : null,
    reach: reach === 'nowhere' ? where : `${where}, in ${receivingHosts(row)}`,
    hostDisabled: disabledLessonSourceReasons().get(row.source_cli) ?? null,
  };
}

export type LessonFilter = { scope?: LessonScope; source?: LessonSource; projectDir?: string; shared?: boolean; held?: boolean };

export function listLessons(filter: LessonFilter = {}): LessonRow[] {
  const identity = filter.projectDir ? resolveProjectIdentity(filter.projectDir) : null;
  const rows = getDb().prepare('SELECT * FROM lessons').all() as LessonRow[];
  return rows
    .filter(row => (!filter.scope || row.scope === filter.scope)
      && (!filter.source || row.source_cli === filter.source)
      && (!identity || row.project_identity === identity)
      && (!filter.shared || lessonReach(row) === 'any-project')
      && (!filter.held || row.quarantined === 1))
    .sort((a, b) => Number(isGlobal(a.project_identity)) - Number(isGlobal(b.project_identity))
      || projectName(a).localeCompare(projectName(b))
      || b.source_mtime.localeCompare(a.source_mtime)
      || a.id.localeCompare(b.id));
}

const MIN_ID_PREFIX = 4;

export type FindLesson = { row: LessonRow } | { error: 'too-short' | 'not-found' } | { error: 'ambiguous'; matches: LessonRow[] };

/** A note by its ID or any unique prefix of it (list shows the first 8 characters). */
export function findLesson(idOrPrefix: string): FindLesson {
  const prefix = idOrPrefix.trim().toLowerCase();
  if (prefix.length < MIN_ID_PREFIX) return { error: 'too-short' };
  const matches = getDb().prepare("SELECT * FROM lessons WHERE substr(id, 1, ?) = ? ORDER BY id LIMIT 6").all(prefix.length, prefix) as LessonRow[];
  if (matches.length === 1) return { row: matches[0] };
  return matches.length ? { error: 'ambiguous', matches } : { error: 'not-found' };
}

/** Permanent: the note and every copy of it are deleted and never harvested again. */
export function forgetLesson(row: LessonRow): { removed: number } {
  return { removed: tombstoneLesson(row) };
}

export type LessonsOffResult = { wasOn: boolean; notes: number; shadowLog: number; remaining: number };

/**
 * Turn sharing off and delete everything harvested, plus the would-have-shared
 * log. Forgotten-note tombstones, exclusions and aliases stay: they are the
 * user's own decisions and hold no note text. `remaining` is the purge proof.
 */
export function turnLessonsOff(): LessonsOffResult {
  const wasOn = isLessonsSharingEnabled();
  disableLessonsSharing();
  const db = getDb();
  const notes = Number(db.prepare('DELETE FROM lessons').run().changes);
  clearLessonFileState();
  clearLessonFolderState();
  const shadowLog = Number(db.prepare('DELETE FROM lesson_shadow_log').run().changes);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { wasOn, notes, shadowLog, remaining: count('lessons') + count('lesson_shadow_log') };
}

export type LessonFlow = {
  source: LessonSource;
  projectIdentity: string;
  projectLabel: string;
  notes: number;
  anyProject: number;
  ownProject: number;
  nowhere: number;
  /** Notes whose scope would have let them travel, kept home by quarantine, by reason. */
  heldBack: Record<string, number>;
  unresolved: boolean;
};

/** Source → destination, one line per AI and project the notes came from. */
export function lessonFlows(): LessonFlow[] {
  const flows = new Map<string, LessonFlow>();
  for (const row of getDb().prepare('SELECT * FROM lessons').all() as LessonRow[]) {
    const key = `${row.source_cli}\n${row.project_identity}`;
    let flow = flows.get(key);
    if (!flow) {
      flow = {
        source: row.source_cli, projectIdentity: row.project_identity, projectLabel: projectName(row),
        notes: 0, anyProject: 0, ownProject: 0, nowhere: 0, heldBack: {}, unresolved: isUnresolved(row.project_identity),
      };
      flows.set(key, flow);
    }
    flow.notes++;
    const reach = lessonReach(row);
    if (reach === 'any-project') flow.anyProject++;
    else if (reach === 'own-project') flow.ownProject++;
    else flow.nowhere++;
    if (row.quarantined && row.scope !== 'project') {
      const reason = row.quarantine_reason ?? 'held';
      flow.heldBack[reason] = (flow.heldBack[reason] ?? 0) + 1;
    }
  }
  return [...flows.values()].sort((a, b) => Number(isGlobal(a.projectIdentity)) - Number(isGlobal(b.projectIdentity))
    || b.notes - a.notes || a.projectLabel.localeCompare(b.projectLabel));
}

// --- Projects: aliases, exclusions ---------------------------------------------

/** The link that would most likely fix an unlinked folder. `aliasPath` is null when only the project is known, not the folder's own path. */
export type AliasSuggestion = { aliasPath: string | null; targetDir: string };

export type UnresolvedFolder = { identity: string; label: string; notes: number; suggestion: AliasSuggestion | null };

const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** A folder as the file system spells it (D:/Veto, not the case-folded d:/veto the alias table keeps). */
const trueCase = (dir: string): string => { try { return realpathSync.native(dir); } catch { return dir; } };

/** A Claude folder slug without its root: `F--a-b` and `D--a-b` differ only in the drive. */
function slugTail(slug: string): { drive: string | null; tail: string } {
  const drive = /^([A-Za-z])--(.*)$/.exec(slug);
  return drive ? { drive: drive[1], tail: drive[2] } : { drive: null, tail: slug.replace(/^-+/, '') };
}

/** Project folders on this machine that Veto has seen, spelled as the file system spells them. */
function knownProjectDirs(): string[] {
  const db = getDb();
  const dirs = new Map<string, string>();
  for (const sql of [
    'SELECT DISTINCT project_dir AS dir FROM sessions WHERE project_dir IS NOT NULL',
    'SELECT alias_path AS dir FROM project_identity_aliases',
  ]) {
    try {
      for (const { dir } of db.prepare(sql).all() as Array<{ dir: string }>) {
        const key = canonicalProjectPath(dir);
        if (!dirs.has(key) && isDirectory(dir)) dirs.set(key, trueCase(dir));
      }
    } catch { /* table absent in an old database */ }
  }
  return [...dirs.values()];
}

/**
 * The same project checked out on this machine: a known folder whose slug is
 * the unlinked one's with another root (F:/a/b for D:/a/b, whose folder path
 * is then known too), or failing that, one whose slug it ends with (a backup
 * nested deeper, whose own path cannot be read back from its lossy slug).
 * Anything but exactly one candidate suggests nothing.
 */
export function suggestAlias(identity: string, known: string[]): AliasSuggestion | null {
  const exactPath = identity.startsWith('path:') ? identity.slice('path:'.length) : null;
  const unlinked = slugTail(exactPath ? claudeProjectSlug(exactPath) : identity.slice('claude-slug:'.length));
  const same = known.filter(dir => sameClaudeSlug(slugTail(claudeProjectSlug(dir)).tail, unlinked.tail));
  const nested = known.filter(dir => {
    const tail = slugTail(claudeProjectSlug(dir)).tail;
    return unlinked.tail.length > tail.length + 1 && sameClaudeSlug(unlinked.tail.slice(-(tail.length + 1)), `-${tail}`);
  });
  const match = same.length ? same : nested;
  if (match.length !== 1) return null;
  const targetDir = match[0];
  if (exactPath) return { aliasPath: exactPath, targetDir };
  const drive = same.length && unlinked.drive && /^[A-Za-z]:/.test(targetDir) ? `${unlinked.drive.toUpperCase()}:${targetDir.slice(2)}` : null;
  return { aliasPath: drive, targetDir };
}

/** Memory whose project Veto could not trace to a folder that exists: its project notes reach no session. */
export function unresolvedFolders(): UnresolvedFolder[] {
  const rows = getDb().prepare('SELECT project_identity, project_label, COUNT(*) AS notes FROM lessons GROUP BY project_identity, project_label')
    .all() as Array<{ project_identity: string; project_label: string | null; notes: number }>;
  const unresolved = rows.filter(row => isUnresolved(row.project_identity));
  const known = unresolved.length ? knownProjectDirs() : [];
  return unresolved.map(row => ({
    identity: row.project_identity,
    label: row.project_label ?? row.project_identity,
    notes: row.notes,
    suggestion: suggestAlias(row.project_identity, known),
  }));
}

/** Checkouts treated as one project: only groups of two or more folders are worth showing. */
export function aliasGroups(): Array<{ identity: string; paths: string[] }> {
  const rows = getDb().prepare('SELECT alias_path, project_identity FROM project_identity_aliases ORDER BY alias_path')
    .all() as Array<{ alias_path: string; project_identity: string }>;
  const groups = new Map<string, string[]>();
  for (const row of rows) groups.set(row.project_identity, [...(groups.get(row.project_identity) ?? []), row.alias_path]);
  return [...groups].filter(([, paths]) => paths.length > 1).map(([identity, paths]) => ({ identity, paths }));
}

export type SetAliasResult =
  /** memoryFolders: Claude memory folders this path names; 0 usually means a mistyped path. */
  | { ok: true; identity: string; label: string; memoryFolders: number }
  | { ok: false; error: 'target-missing' | 'same-folder' | 'different-repository' };

/**
 * Treat `aliasPath` as another checkout of the project at `targetDir`: its
 * notes then count as that project's. For a drive that is not mounted, which
 * is the case this exists for, the alias path need not exist. A folder that
 * does exist and is a different repository is refused, since aliasing it
 * would carry one project's private notes into another.
 */
export function setProjectAlias(aliasPath: string, targetDir: string): SetAliasResult {
  if (!isDirectory(targetDir)) return { ok: false, error: 'target-missing' };
  if (canonicalProjectPath(aliasPath) === canonicalProjectPath(targetDir)) return { ok: false, error: 'same-folder' };
  const identity = resolveProjectIdentity(targetDir);
  if (existsSync(aliasPath)) {
    const own = computeProjectIdentity(aliasPath);
    if (own.startsWith('git:') && own !== identity) return { ok: false, error: 'different-repository' };
  }
  addProjectAlias(aliasPath, identity);
  invalidateHarvestedState();
  const slug = claudeProjectSlug(canonicalProjectPath(aliasPath));
  const folders = getDb().prepare("SELECT DISTINCT source_path FROM lessons WHERE source_cli = 'claude'").all() as Array<{ source_path: string }>;
  const memoryFolders = new Set(folders.map(row => basename(dirname(dirname(row.source_path)))).filter(folder => sameClaudeSlug(folder, slug))).size;
  return { ok: true, identity, label: basename(targetDir.replace(/[\\/]+$/, '')) || targetDir, memoryFolders };
}

export function removeProjectAlias(aliasPath: string): boolean {
  const removed = Number(getDb().prepare('DELETE FROM project_identity_aliases WHERE alias_path = ?').run(canonicalProjectPath(aliasPath)).changes) > 0;
  if (removed) invalidateHarvestedState();
  return removed;
}

export function excludeProjectDir(projectDir: string): { label: string; added: boolean; removed: number } {
  const label = basename(projectDir.replace(/[\\/]+$/, '')) || projectDir;
  return { label, ...excludeProject(resolveProjectIdentity(projectDir), label) };
}

export function includeProjectDir(projectDir: string): { label: string; removed: boolean } {
  const removed = includeProject(resolveProjectIdentity(projectDir));
  // The project's files are untouched, so only forgetting their fingerprints
  // brings its notes back.
  if (removed) invalidateHarvestedState();
  return { label: basename(projectDir.replace(/[\\/]+$/, '')) || projectDir, removed };
}

/** Switch a host's harvester back on after a format change, and check it again straight away. */
export function recheckSource(source: LessonSource, home?: string): { wasDisabled: boolean; stillDisabled: string | null; report: LessonSyncReport | null } {
  const wasDisabled = enableLessonSource(source);
  // The file that tripped the canary has not changed; only our willingness to
  // read it has.
  if (wasDisabled) invalidateHarvestedState();
  const report = refreshLessons(home, { forced: true });
  return { wasDisabled, stillDisabled: disabledLessonSourceReasons().get(source) ?? null, report };
}

// --- Status ------------------------------------------------------------------------

export type LessonsStatus = {
  sharing: boolean;
  /** Consent was given for an older disclosure; sharing stays off until it is accepted again. */
  needsReconsent: boolean;
  consentAt: string | null;
  notes: number;
  byHost: Record<LessonSource, number>;
  anyProject: number;
  held: number;
  disabledHosts: Map<LessonSource, string>;
  excluded: ProjectExclusion[];
  unresolved: number;
  forgotten: number;
  shadowLog: number;
};

export function lessonsStatus(): LessonsStatus {
  const config = getConfig().lessons;
  const db = getDb();
  const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[];
  const byHost = { claude: 0, codex: 0, gemini: 0 } as Record<LessonSource, number>;
  for (const row of rows) byHost[row.source_cli] = (byHost[row.source_cli] ?? 0) + 1;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    sharing: isLessonsSharingEnabled(config),
    needsReconsent: config.enabled && config.consent_version !== LESSONS_CONSENT_VERSION,
    consentAt: config.consent_at,
    notes: rows.length,
    byHost,
    anyProject: rows.filter(row => lessonReach(row) === 'any-project').length,
    held: rows.filter(row => row.quarantined === 1).length,
    disabledHosts: disabledLessonSourceReasons(),
    excluded: excludedProjects(),
    unresolved: unresolvedFolders().length,
    forgotten: (db.prepare('SELECT COUNT(DISTINCT forget_id) AS n FROM lesson_tombstones').get() as { n: number }).n,
    shadowLog: count('lesson_shadow_log'),
  };
}
