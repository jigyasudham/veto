// `veto lessons`: see and control what Veto harvests from each AI's own memory
// (Harvest-and-Share, council 320c40dc). Nothing here delivers a note to any
// AI; it only shows the user their notes and where the rules would let them go.

import { LESSON_SOURCES, type LessonSource } from '../lessons/adapters/index.js';
import type { LessonScope } from '../lessons/classify.js';
import {
  aliasGroups, explainLesson, excludeProjectDir, findLesson, forgetLesson, HOST_NAMES, includeProjectDir, lessonFlows,
  lessonReach, lessonsStatus, lessonTitle, listLessons, projectName, recheckSource, refreshLessons,
  removeProjectAlias, setProjectAlias, turnLessonsOff, unresolvedFolders, type FindLesson,
} from '../lessons/manage.js';
import type { LessonRow } from '../lessons/store.js';

type Out = (line?: string) => void;
type Colors = Record<'bold' | 'dim' | 'green' | 'yellow' | 'cyan' | 'red', (s: string) => string>;

const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const COLORS: Colors = { bold: ansi(1), dim: ansi(2), green: ansi(32), yellow: ansi(33), cyan: ansi(36), red: ansi(31) };
const PLAIN: Colors = { bold: s => s, dim: s => s, green: s => s, yellow: s => s, cyan: s => s, red: s => s };

const RULE = '─────────────────────────────────────────────────────';
const SHADOW = 'shadow mode: nothing is delivered to any AI yet';
const USAGE = [
  'veto lessons [status]',
  'veto lessons list [--scope=user|machine|project] [--source=claude|codex|gemini] [--shared] [--held] [--project=<dir>] [--json]',
  'veto lessons why <id>',
  'veto lessons forget <id>',
  'veto lessons flows',
  'veto lessons off',
  'veto lessons exclude [<dir>]   ·   veto lessons include [<dir>]',
  'veto lessons alias [<path> --to=<dir>]   ·   veto lessons alias --remove <path>',
  'veto lessons recheck <claude|codex|gemini>',
];

const VALUE_FLAGS = new Set(['scope', 'source', 'project', 'to']);

function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name) && i + 1 < args.length && !args[i + 1].startsWith('--')) flags.set(name, args[++i]);
    else flags.set(name, true);
  }
  return { positional, flags };
}

const shortId = (row: LessonRow) => row.id.slice(0, 8);
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function reachLabel(row: LessonRow): string {
  const reach = lessonReach(row);
  if (reach === 'any-project') return 'any project';
  if (row.quarantined) return `held: ${row.quarantine_reason ?? 'held'}`;
  return reach === 'own-project' ? 'own project' : 'nowhere';
}

function lookup(found: FindLesson, id: string, out: Out, c: Colors): LessonRow | null {
  if ('row' in found) return found.row;
  if ('matches' in found) {
    out(c.red(`  ${id} matches more than one note. Give more of the ID:`));
    for (const row of found.matches) out(`    ${c.cyan(row.id.slice(0, 12))}  ${clip(lessonTitle(row), 60)}`);
  } else if (found.error === 'too-short') out(c.red('  Give at least the first 4 characters of the note ID, as veto lessons list shows it.'));
  else out(c.red(`  No note ${id}. See veto lessons list.`));
  return null;
}

function sharingLine(c: Colors): string {
  const s = lessonsStatus();
  if (s.sharing) return `${c.green('on')}${s.consentAt ? c.dim(` · accepted ${s.consentAt.slice(0, 10)}`) : ''} · ${c.dim(SHADOW)}`;
  if (s.needsReconsent) return c.yellow('paused: the disclosure changed since you accepted it');
  return `${c.dim('off')}${s.notes ? '' : c.dim(": Veto has not read any AI's memory")}`;
}

function status(out: Out, c: Colors, home: string | undefined): number {
  refreshLessons(home);
  const s = lessonsStatus();
  out('');
  out(c.bold('  Veto Lessons: notes your AIs wrote, shared between them'));
  out(c.dim(`  ${RULE}`));
  out(`  Sharing:      ${sharingLine(c)}`);
  if (s.notes || s.sharing) {
    out(`  Notes:        ${s.notes} ${c.dim(`(${LESSON_SOURCES.map(host => `${HOST_NAMES[host]} ${s.byHost[host]}`).join(' · ')})`)}`);
    out(`  Reach:        ${plural(s.anyProject, 'note')} may go to any project · ${s.held} held in their own project`);
  }
  for (const [host, reason] of s.disabledHosts) {
    out(c.yellow(`  Switched off: ${HOST_NAMES[host]}, its memory format changed (${reason})`) + c.dim(` → veto lessons recheck ${host}`));
  }
  if (s.excluded.length) out(`  Kept out:     ${s.excluded.map(e => e.project_label ?? e.project_identity).join(', ')} ${c.dim('(nothing leaves, nothing enters)')}`);
  if (s.unresolved) out(`  Unlinked:     ${plural(s.unresolved, 'memory folder')} with no project Veto can find ${c.dim('→ veto lessons alias')}`);
  if (s.forgotten) out(`  Forgotten:    ${s.forgotten} ${c.dim('(permanent)')}`);
  if (s.shadowLog) out(`  Shadow log:   ${plural(s.shadowLog, 'record')} of what would have been shared`);
  if (s.notes && !s.sharing) out(c.yellow('  Sharing is off, but notes harvested earlier are still stored.') + c.dim(' Delete them with: veto lessons off'));
  out('');
  out(c.dim('  list · why <id> · forget <id> · flows · off · exclude|include [dir] · alias · recheck <host>'));
  out('');
  return 0;
}

function list(flags: Map<string, string | true>, out: Out, c: Colors, home: string | undefined): number {
  const scope = flags.get('scope');
  const source = flags.get('source');
  const project = flags.get('project');
  if (scope !== undefined && !['user', 'machine', 'project'].includes(String(scope))) { out(c.red('  --scope must be user, machine or project.')); return 1; }
  if (source !== undefined && !(LESSON_SOURCES as readonly string[]).includes(String(source))) { out(c.red('  --source must be claude, codex or gemini.')); return 1; }
  refreshLessons(home);
  const rows = listLessons({
    scope: typeof scope === 'string' ? scope as LessonScope : undefined,
    source: typeof source === 'string' ? source as LessonSource : undefined,
    projectDir: typeof project === 'string' ? project : undefined,
    shared: flags.has('shared'),
    held: flags.has('held'),
  });
  if (flags.has('json')) { out(JSON.stringify(rows, null, 2)); return 0; }
  out('');
  out(c.bold(`  Notes Veto has read from your AIs' memory: ${rows.length}`));
  out(c.dim(`  ${RULE}`));
  out(`  Sharing: ${sharingLine(c)}`);
  let group: string | null = null;
  for (const row of rows) {
    const name = projectName(row);
    if (name !== group) {
      group = name;
      out('');
      out(`  ${c.bold(name)}`);
    }
    out(`    ${c.cyan(shortId(row))}  ${HOST_NAMES[row.source_cli].padEnd(6)}  ${c.dim(row.source_mtime.slice(0, 10))}  ${reachLabel(row).padEnd(13)}  ${clip(lessonTitle(row), 60)}`);
  }
  if (!rows.length) out(c.dim(flags.size ? '  (no notes match)' : '  (none)'));
  out('');
  out(c.dim('  why <id> shows a note and where it may go · forget <id> removes it for good'));
  out('');
  return 0;
}

function why(id: string | undefined, out: Out, c: Colors, home: string | undefined): number {
  if (!id) { out(c.red('  Usage: veto lessons why <id>')); return 1; }
  refreshLessons(home);
  const row = lookup(findLesson(id), id, out, c);
  if (!row) return 1;
  const e = explainLesson(row);
  out('');
  out(c.bold(`  Note ${shortId(row)}`) + c.dim(`  ${e.provenance}`));
  out(c.dim(`  ${RULE}`));
  out(`  Source     ${row.source_path} ${c.dim(`(section: ${row.section_anchor})`)}`);
  out(`  Scope      ${e.scope}`);
  if (e.held) out(`  Held       ${e.held}`);
  out(`  May reach  ${e.reach}`);
  if (e.hostDisabled) out(c.yellow(`  Paused     ${HOST_NAMES[row.source_cli]}'s memory format changed, so none of its notes are used (${e.hostDisabled})`));
  out(`  Delivered  ${c.dim(`never yet: ${SHADOW}`)}`);
  out('');
  out(c.dim('  ┌─ the note as it would be shared (email addresses, home folders and secrets masked)'));
  for (const line of row.text_masked.split('\n')) out(`${c.dim('  │')} ${line}`);
  out(c.dim('  └─'));
  out('');
  out(c.dim(`  Forget it for good: veto lessons forget ${shortId(row)}`));
  out('');
  return 0;
}

function forget(id: string | undefined, out: Out, c: Colors): number {
  if (!id) { out(c.red('  Usage: veto lessons forget <id>')); return 1; }
  const row = lookup(findLesson(id), id, out, c);
  if (!row) return 1;
  const { removed } = forgetLesson(row);
  out('');
  out(c.green(`  ✓ Forgot ${shortId(row)}: ${clip(lessonTitle(row), 60)}`));
  if (removed > 1) out(c.dim(`    Also removed ${plural(removed - 1, 'copy', 'copies')} of it kept elsewhere.`));
  out(c.dim(`    It will not be read again, even if ${HOST_NAMES[row.source_cli]} edits it. Its memory file is untouched.`));
  out('');
  return 0;
}

function flows(out: Out, c: Colors, home: string | undefined): number {
  refreshLessons(home);
  const all = lessonFlows();
  const s = lessonsStatus();
  out('');
  out(c.bold('  Where each AI\'s notes may go'));
  out(c.dim(`  ${RULE}`));
  out(`  Sharing: ${sharingLine(c)}`);
  for (const flow of all) {
    out('');
    out(`  ${c.bold(`${HOST_NAMES[flow.source]} memory · ${flow.projectLabel}`)}  ${c.dim(plural(flow.notes, 'note'))}`);
    const to = flow.source === 'claude' ? 'Codex, Gemini, and Claude in other folders'
      : `${LESSON_SOURCES.filter(host => host !== flow.source).map(host => HOST_NAMES[host]).join(', ')}`;
    if (flow.anyProject) out(`    ${String(flow.anyProject).padStart(4)}  → any project, in ${to}`);
    if (flow.ownProject) out(`    ${String(flow.ownProject).padStart(4)}  → ${flow.projectLabel} only, in ${to}`);
    if (flow.nowhere) {
      out(`    ${String(flow.nowhere).padStart(4)}  → nowhere ${c.dim(flow.unresolved ? '(no known project folder: see veto lessons alias)' : '(held back, and no project of their own)')}`);
    }
    const held = Object.entries(flow.heldBack);
    if (held.length) out(c.dim(`          held in their project instead of shared: ${held.map(([reason, n]) => `${n} ${reason}`).join(', ')}`));
    if (s.disabledHosts.has(flow.source)) out(c.yellow(`          paused: ${HOST_NAMES[flow.source]}'s memory format changed → veto lessons recheck ${flow.source}`));
  }
  if (!all.length) { out(''); out(c.dim('  (no notes)')); }
  if (s.excluded.length) { out(''); out(`  Kept out: ${s.excluded.map(e => e.project_label ?? e.project_identity).join(', ')} ${c.dim('(nothing leaves, nothing enters)')}`); }
  out('');
  out(c.dim('  A note is only ever shared into the project it came from, unless it is about you or this machine'));
  out(c.dim('  and carries no command, web address, credential or instruction.'));
  out('');
  return 0;
}

function off(out: Out, c: Colors): number {
  const r = turnLessonsOff();
  out('');
  out(c.green(`  ✓ Sharing is off${r.wasOn ? '' : ' (it already was)'}.`));
  out(`    Deleted ${plural(r.notes, 'harvested note')} and ${plural(r.shadowLog, 'shadow-log record')}.`);
  if (r.remaining === 0) out(c.dim('    Checked: nothing harvested is left in Veto\'s database. Your AIs\' own memory files are untouched.'));
  else out(c.red(`    ${r.remaining} rows could not be deleted. Run this again, or report it.`));
  out(c.dim('    Forgotten notes, excluded projects and aliases are kept, so they still apply if you turn sharing back on.'));
  out('');
  return r.remaining === 0 ? 0 : 1;
}

function excludeOrInclude(sub: 'exclude' | 'include', dir: string, out: Out, c: Colors): number {
  if (sub === 'exclude') {
    const r = excludeProjectDir(dir);
    out('');
    out(c.green(`  ✓ ${r.label} is kept out of sharing${r.added ? '' : ' (it already was)'}.`) + c.dim(' Its notes are not read, and no note is chosen for it.'));
    if (r.removed) out(c.dim(`    Deleted ${plural(r.removed, 'note')} already harvested from it.`));
    out('');
    return 0;
  }
  const r = includeProjectDir(dir);
  out('');
  out(r.removed ? c.green(`  ✓ ${r.label} takes part in sharing again.`) : c.dim(`  ${r.label} was not kept out.`));
  out('');
  return 0;
}

function alias(positional: string[], flags: Map<string, string | true>, out: Out, c: Colors, home: string | undefined): number {
  const remove = flags.get('remove');
  const target = flags.get('to');
  const path = typeof remove === 'string' ? remove : positional[0];
  if (remove !== undefined) {
    if (!path) { out(c.red('  Usage: veto lessons alias --remove <path>')); return 1; }
    out(removeProjectAlias(path) ? c.green(`  ✓ ${path} is no longer linked to another project.`) : c.dim(`  ${path} had no link.`));
    return 0;
  }
  if (path) {
    if (typeof target !== 'string') { out(c.red('  Usage: veto lessons alias <path> --to=<project folder>')); return 1; }
    const r = setProjectAlias(path, target);
    if (!r.ok) {
      out(c.red(r.error === 'target-missing' ? `  ${target} is not a folder on this machine.`
        : r.error === 'same-folder' ? '  Those are the same folder.'
        : `  ${path} is a different repository from ${target}, so its notes are not ${target}'s. Nothing was linked.`));
      return 1;
    }
    out(c.green(`  ✓ Notes from ${path} now count as ${r.label}'s.`));
    if (!r.memoryFolders) out(c.yellow("    No AI memory Veto has read belongs to that path, so nothing moves yet. Check the spelling against veto lessons alias."));
    const report = refreshLessons(home);
    if (report) out(c.dim(`    Re-read your AIs' memory: ${report.updated} notes moved or changed.`));
    return 0;
  }
  refreshLessons(home);
  const groups = aliasGroups();
  const unresolved = unresolvedFolders();
  out('');
  out(c.bold('  Folders Veto treats as one project'));
  out(c.dim(`  ${RULE}`));
  if (!groups.length) out(c.dim('  (none: each project is checked out in one place)'));
  for (const group of groups) out(`  ${group.paths.join(c.dim('  =  '))}`);
  if (unresolved.length) {
    out('');
    out(c.bold('  Memory with no project folder'));
    out(c.dim('  Its project notes reach no session until you link it, for example a copy on a drive that is not plugged in:'));
    for (const folder of unresolved) {
      out(`  ${folder.label}  ${c.dim(plural(folder.notes, 'note'))}`);
      const s = folder.suggestion;
      if (s) out(`      ${c.dim(s.aliasPath ? 'link it:' : 'probably this project; give its folder:')} veto lessons alias "${s.aliasPath ?? '<its folder>'}" --to="${s.targetDir}"`);
    }
    out(c.dim('  Link one with: veto lessons alias "<its folder>" --to="<the project folder on this machine>"'));
  }
  out('');
  return 0;
}

function recheck(host: string | undefined, out: Out, c: Colors, home: string | undefined): number {
  if (!host || !(LESSON_SOURCES as readonly string[]).includes(host)) { out(c.red('  Usage: veto lessons recheck <claude|codex|gemini>')); return 1; }
  const r = recheckSource(host as LessonSource, home);
  out('');
  if (r.stillDisabled) out(c.yellow(`  ${HOST_NAMES[host as LessonSource]}'s memory still has a format Veto does not recognise (${r.stillDisabled}), so it stays off.`));
  else if (!r.report) out(c.green(`  ✓ ${HOST_NAMES[host as LessonSource]} is back on.`) + c.dim(' It will be read once sharing is on.'));
  else out(c.green(`  ✓ ${HOST_NAMES[host as LessonSource]} is back on${r.wasDisabled ? '' : ' (it was not off)'}.`) + c.dim(` Read ${plural(r.report.harvested, 'file')}.`));
  out('');
  return r.stillDisabled ? 1 : 0;
}

/** Runs one `veto lessons` subcommand and returns its exit code. */
export function runLessonsCommand(args: string[], options: { out?: Out; color?: boolean; cwd?: string; home?: string } = {}): number {
  const out = options.out ?? ((line = '') => console.log(line));
  const c = options.color === false ? PLAIN : COLORS;
  const [sub = 'status', ...rest] = args;
  const { positional, flags } = parseArgs(rest);
  const cwd = options.cwd ?? process.cwd();
  const home = options.home;
  switch (sub) {
    case 'status': return status(out, c, home);
    case 'list': return list(flags, out, c, home);
    case 'why': return why(positional[0], out, c, home);
    case 'forget': return forget(positional[0], out, c);
    case 'flows': return flows(out, c, home);
    case 'off': return off(out, c);
    case 'exclude':
    case 'include': return excludeOrInclude(sub, positional[0] ?? cwd, out, c);
    case 'alias': return alias(positional, flags, out, c, home);
    case 'recheck': return recheck(positional[0], out, c, home);
    default:
      out(c.red(`  Unknown lessons subcommand: ${sub}`));
      for (const line of USAGE) out(c.dim(`  ${line}`));
      return 1;
  }
}
