// Veto guides that `veto init` left inside other CLIs' own files.
//
// From v1.4.5 (2026-05-23) through 3.3.0, `veto init` overwrote
// ~/.gemini/GEMINI.md (Gemini's own memory file) and wrote
// ~/.codex/AGENTS.override.md, which Codex reads INSTEAD of the user's
// ~/.codex/AGENTS.md. Init no longer writes either file, so the set of texts it
// can have left behind is closed: the eight guides below, taken from git
// history (every VETO_GUIDE src/cli.ts has ever held; no earlier code named
// either file).
//
// Only a file that IS one of those guides, byte for byte once line endings are
// normalized, is ever moved, and it is renamed rather than deleted. A file with
// anything else in it (memories Gemini saved below the guide, the user's own
// edits) is reported and never touched.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SHIPPED_GUIDE_SHA256: ReadonlySet<string> = new Set([
  '8c283b8f593027cef97f93cc60e2f5472f84637878f4445f4d1de3456eff3558', // 49 tools (v1.4.5)
  '125506e5606e8a7113e78ed6ed45dfa1213e5d489e3b10c96171097f83242c2d', // 49 tools
  '5f7b7c1de6c89fcc73aaa2a6199ca8e57e334b63dd32dc1520c333b7cf20f550', // 62 tools
  'cfc7a5cd1af02527e05d055745b3ab4511b64f84db96ddaa465f336b81f6b369', // 89 tools
  '7ba579cfd46bdbcd16a771e9c1d0ccc672c1414726a91c55bb7648e20616dda6', // 90 tools
  'da098265f2f1d085df681200feef626fcd119ecd1d14e13d771bd4d27bf1e948', // 91 tools
  '0567c129b23ea49fb4e77b43f3e7e757fed2b1eebc6c385dcb4ac967bb8af870', // 92 tools
  '2953a1c3f925955eba2967d87f34cdc30ec951f0785639a4dcb138afd6ad43fe', // 93 tools (through 3.3.0)
]);

// A guide is 1.4 KB. Anything far larger is the user's own file; it is only
// ever checked for an embedded guide, and never read past this at startup.
const MAX_READ_BYTES = 256 * 1024;
const GUIDE_HEADING_RE = /^# Veto MCP Server[ \t]*$/m;

export type LeftoverGuide = {
  host: 'codex' | 'gemini';
  path: string;
  /** exact: the file is nothing but a guide Veto wrote. embedded: a guide plus other content. */
  kind: 'exact' | 'embedded';
};

export type MovedGuide = LeftoverGuide & { backupPath: string };

const normalize = (raw: string) => raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The only two files init ever wrote into (always under the home directory, never CODEX_HOME). */
export function leftoverGuideTargets(home = homedir()): Array<{ host: LeftoverGuide['host']; path: string }> {
  return [
    { host: 'codex', path: join(home, '.codex', 'AGENTS.override.md') },
    { host: 'gemini', path: join(home, '.gemini', 'GEMINI.md') },
  ];
}

function classify(path: string): LeftoverGuide['kind'] | null {
  let text: string;
  try {
    if (statSync(path).size > MAX_READ_BYTES) return null;
    text = normalize(readFileSync(path, 'utf8'));
  } catch { return null; }
  if (SHIPPED_GUIDE_SHA256.has(sha256(text))) return 'exact';
  return GUIDE_HEADING_RE.test(text) && /\bVeto is active\b/.test(text) ? 'embedded' : null;
}

export function findLeftoverGuides(home = homedir()): LeftoverGuide[] {
  const found: LeftoverGuide[] = [];
  for (const target of leftoverGuideTargets(home)) {
    const kind = classify(target.path);
    if (kind) found.push({ ...target, kind });
  }
  return found;
}

function freeBackupPath(path: string, now: Date): string {
  const plain = `${path}.veto-backup`;
  if (!existsSync(plain)) return plain;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${plain}-${stamp}`;
}

/**
 * Rename each file that is exactly a guide Veto wrote to `<file>.veto-backup`.
 * Embedded guides are returned in `kept`, untouched. The file is re-checked
 * immediately before the rename, so content a host appended in the meantime is
 * never moved away with it.
 */
export function moveAsideLeftoverGuides(home = homedir(), now = new Date()): { moved: MovedGuide[]; kept: LeftoverGuide[] } {
  const moved: MovedGuide[] = [];
  const kept: LeftoverGuide[] = [];
  for (const guide of findLeftoverGuides(home)) {
    if (guide.kind !== 'exact' || classify(guide.path) !== 'exact') { kept.push(guide); continue; }
    const backupPath = freeBackupPath(guide.path, now);
    try {
      renameSync(guide.path, backupPath);
      moved.push({ ...guide, backupPath });
    } catch {
      kept.push(guide);
    }
  }
  return { moved, kept };
}

/**
 * One line about a leftover. `owner` is how the file's owner is named: "your"
 * in the terminal, "the user's" in text handed to the agent.
 */
export function describeLeftover(guide: LeftoverGuide, home = homedir(), owner = 'your'): string {
  const shown = guide.path.startsWith(home) ? `~${guide.path.slice(home.length).replace(/\\/g, '/')}` : guide.path;
  const why = guide.host === 'codex' ? `Codex reads it INSTEAD of ${owner} own ~/.codex/AGENTS.md` : "it is Gemini's own memory file";
  return guide.kind === 'exact'
    ? `${shown} is an old Veto guide (${why})`
    : `${shown} starts with an old Veto guide above ${owner} own content`;
}

/**
 * Startup tip for the MCP `instructions` field, present only while a leftover
 * exists, so it resolves itself. Like the status-line tip, it hands the offer
 * to the agent; nothing is changed unless the user agrees.
 */
export function leftoverGuideInstruction(home = homedir()): string | undefined {
  const found = findLeftoverGuides(home);
  if (found.length === 0) return undefined;
  const exact = found.filter(g => g.kind === 'exact');
  const embedded = found.filter(g => g.kind === 'embedded');
  const lines = [
    'CLEANUP TIP — old Veto guide files (mention once per session; drop it if the user declines).',
    'Older versions of `veto init` wrote Veto\'s guide into other CLIs\' own files, which no current version does.',
  ];
  if (exact.length) {
    lines.push(`Found: ${exact.map(g => describeLeftover(g, home, "the user's")).join('; ')}.`);
    lines.push('Offer to run `veto doctor --fix` for the user (without a global install:'
      + ' `npx -y --package @jigyasudham/veto@latest veto doctor --fix`). It renames only those Veto-written'
      + ' copies to *.veto-backup and changes nothing else. Do not run it unless the user agrees.');
  }
  if (embedded.length) {
    lines.push(`Also: ${embedded.map(g => describeLeftover(g, home, "the user's")).join('; ')}. Veto will not edit a file that`
      + ' holds the user\'s own content; if they want, they can delete the "# Veto MCP Server" block by hand.');
  }
  return lines.join(' ');
}
