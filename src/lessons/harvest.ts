import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { isLessonsSharingEnabled } from '../memory/config.js';
import { parseNativeMemory, type LessonSource } from './adapters/index.js';
import { classifyLesson } from './classify.js';
import { discoverNativeMemorySources, type NativeMemorySource } from './discover.js';
import { projectNames, resolveProjectIdentity } from './identity.js';
import { maskLessonText } from './mask.js';
import { resolveClaudeProjectFolder } from './source-project.js';
import { disableLessonSource, isLessonSourceEnabled, purgeVanishedLessonSources, syncLessons, type HarvestedSection } from './store.js';

export type HarvestOutcome =
  | { status: 'harvested'; inserted: number; updated: number; removed: number }
  | { status: 'skipped'; reason: 'empty' | 'index' | 'veto-authored'; removed: number }
  | { status: 'disabled' | 'unavailable'; reason: string };

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
}): HarvestOutcome {
  if (!isLessonSourceEnabled(input.source)) return { status: 'disabled', reason: 'source disabled after format drift' };
  let raw: string;
  let mtime: string;
  try {
    raw = readFileSync(input.sourcePath, 'utf8');
    mtime = statSync(input.sourcePath).mtime.toISOString();
  } catch {
    return { status: 'unavailable', reason: 'native memory file could not be read' };
  }
  const fileName = basename(input.sourcePath);
  const parsed = parseNativeMemory(input.source, raw, fileName);
  if (!parsed.ok) {
    disableLessonSource(input.source, `${fileName}: ${parsed.reason}`);
    return { status: 'disabled', reason: parsed.reason };
  }
  const base = { sourceCli: input.source, sourcePath: input.sourcePath, projectIdentity: input.projectIdentity, projectLabel: input.projectLabel ?? null, sourceMtime: mtime };
  if ('skip' in parsed) {
    return { status: 'skipped', reason: parsed.skip, removed: syncLessons({ ...base, sections: [] }).removed };
  }
  const sections: HarvestedSection[] = parsed.sections.map(section => {
    const masked = maskLessonText(section.text);
    const classified = classifyLesson({
      source: input.source, fileName, global: input.global === true, frontmatter: parsed.frontmatter,
      section, maskedText: masked.text, secrets: masked.secrets, projectNames: input.projectNames,
    });
    return { anchor: section.anchor, textMasked: masked.text, ...classified };
  });
  return { status: 'harvested', ...syncLessons({ ...base, sections }) };
}

export type LessonSyncReport = {
  consent: boolean;
  sources: number;
  harvested: number;
  skipped: number;
  disabled: number;
  unavailable: number;
  inserted: number;
  updated: number;
  removed: number;
  unresolvedProjects: number;
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
 * One full pass: discover every known native-memory file, harvest it under its
 * project's identity, and delete rows whose file has gone. Nothing is read
 * until the user has accepted consent v2.
 */
export function syncLessonSources(home?: string): LessonSyncReport {
  const report: LessonSyncReport = {
    consent: isLessonsSharingEnabled(), sources: 0, harvested: 0, skipped: 0, disabled: 0, unavailable: 0,
    inserted: 0, updated: 0, removed: 0, unresolvedProjects: 0,
  };
  if (!report.consent) return report;
  const sources = discoverNativeMemorySources(home);
  report.sources = sources.length;
  const folders = new Map<string, SourceProject>();
  for (const source of sources) {
    const project = sourceProject(source, folders);
    const outcome = harvestNativeMemory({
      source: source.source, sourcePath: source.sourcePath, projectIdentity: project.identity,
      projectLabel: project.label, projectNames: project.names, global: source.global,
    });
    report[outcome.status]++;
    if (outcome.status === 'harvested') { report.inserted += outcome.inserted; report.updated += outcome.updated; report.removed += outcome.removed; }
    if (outcome.status === 'skipped') report.removed += outcome.removed;
  }
  report.unresolvedProjects = [...folders.values()].filter(f => f.identity.startsWith('claude-slug:')).length;
  report.removed += purgeVanishedLessonSources(sources);
  return report;
}
