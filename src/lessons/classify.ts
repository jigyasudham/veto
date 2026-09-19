// Deterministic classification of a harvested section (council 320c40dc).
//
// Scope decides WHERE a note may go; quarantine decides whether it may leave
// its own project at all. Both are rules, not judgement: "ambiguous" always
// resolves to the narrower answer, because a wrong narrow call costs a missed
// note while a wrong wide call spreads text into other projects and vendors.

import type { LessonSource, MemoryFrontmatter, MemorySection } from './adapters/index.js';

export type LessonScope = 'project' | 'user' | 'machine';

/** Which rule set the scope; `veto lessons why` explains it from this. */
export type ScopeReason = 'global-file' | 'names-project' | 'user-entry' | 'feedback-entry' | 'environment-heading' | 'project-default';

export type LessonClassification = {
  scope: LessonScope;
  scopeReason: ScopeReason;
  kind: string;
  /** Non-null keeps the note inside its own project, whatever its scope. */
  quarantineReason: string | null;
};

// Notes ABOUT secrets, identity, sanitization or credentials never cross scope.
// Matched on what names the note (file name, entry name and description,
// section heading), not on every passing mention in its body.
const SENSITIVE_NAME_RE = /(secret|credential|passw(or)?d|api[-_ ]?key|private[-_ ]?key|ssh[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|api[-_ ]?token|identit(y|ies)|saniti[sz]|\bpii\b|personal|profile|employer)/i;

// A section whose heading names the shell, console or network environment is a
// machine lesson (cp1252, Git Bash quoting, dead IPv6). Heading only: a body
// that merely mentions PowerShell is still a project note.
const ENVIRONMENT_TITLE_RE = /\b(git[ -]bash|powershell|pwsh|cmd\.exe|wsl|cp\d{3,4}|code ?page|encoding|utf-?8|crlf|line endings?|ipv[46]|dns|proxy|locale|terminal|console|shell)\b/i;

const URL_RE = /\b(?:https?|ftp|file|ssh|git|wss?):\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;

const EXECUTABLES = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python3?', 'py', 'pip3?', 'uv', 'uvx', 'git', 'gh',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp', 'docker', 'kubectl', 'helm',
  'terraform', 'aws', 'gcloud', 'az', 'powershell(?:\\.exe)?', 'pwsh', 'cmd(?:\\.exe)?', 'bash', 'sh', 'zsh',
  'sudo', 'chmod', 'chown', 'rm', 'del', 'rmdir', 'mv', 'cp', 'iwr', 'irm', 'iex', 'invoke-webrequest',
  'invoke-restmethod', 'invoke-expression', 'start-process', 'remove-item', 'set-executionpolicy', 'reg',
  'schtasks', 'certutil', 'bitsadmin', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'winget', 'choco', 'scoop',
  'brew', 'apt(?:-get)?', 'yum', 'dnf', 'cargo', 'make', 'mcp-publisher', 'smithery', 'veto',
].join('|');
const EXEC = `(?:${EXECUTABLES})(?:\\.(?:cmd|exe|bat|ps1))?`;
// Prose lines are NOT scanned for a leading executable ("Make sure…", "Node
// 22.13 is the floor"); commands are recognised where commands are written:
// behind a prompt, inside a code span, inside a fence, or after "run".
const PROMPT_LINE_RE = /(?:^|\n)[ \t]*(?:\$|PS>|PS [^>\n]*>)[ \t]*\S/;
const COMMAND_SPAN_RE = new RegExp('`[ \\t]*(?:\\$[ \\t]*)?' + EXEC + '(?:[ \\t][^`]*)?`', 'i');
const FENCED_LINE_RE = new RegExp(`^[ \\t]*(?:\\$[ \\t]*)?${EXEC}(?:[ \\t]|$)`, 'i');
const SHELL_FENCE_RE = /(?:^|\n)[ \t]*(?:```|~~~)[ \t]*(?:bash|sh|zsh|shell|console|terminal|powershell|pwsh|ps1?|cmd|bat|batch)\b/i;
const PIPE_TO_SHELL_RE = /\|\s*(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i;
const RUN_DIRECTIVE_RE = new RegExp(`\\b(?:run|execute|exec|type|paste|invoke)\\s+[\`'"]?${EXEC}\\b`, 'i');

const DIRECTIVE_RES: RegExp[] = [
  /\b(?:ignore|disregard|override|forget)\b[^.\n]{0,30}\b(?:previous|prior|above|system|all|earlier)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|guidelines?)\b/i,
  /\b(?:always|must|should)\s+(?:run|execute)\s+(?:this|these|it|them|the following)\b/i,
  /\b(?:always|must|should)\s+(?:download|fetch|install|open|visit|send|upload)\b/i,
  /\b(?:download|fetch)\b[^.\n]{0,60}\b(?:from|url|link|script)\b/i,
  /\b(?:send|post|upload|exfiltrate|forward)\b[^.\n]{0,60}\bto\b[^.\n]{0,40}(?:\[email redacted\]|server|endpoint|webhook|url|address)/i,
];

function fencedCommand(text: string): boolean {
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence && FENCED_LINE_RE.test(line)) return true;
  }
  return false;
}

function quarantineReason(text: string, secrets: number, sensitive: boolean): string | null {
  if (sensitive) return 'sensitive';
  if (secrets > 0 || /REDACTED\[sha256:/.test(text)) return 'credential';
  if (URL_RE.test(text)) return 'url';
  if (SHELL_FENCE_RE.test(text) || PROMPT_LINE_RE.test(text) || COMMAND_SPAN_RE.test(text) || fencedCommand(text)
    || PIPE_TO_SHELL_RE.test(text) || RUN_DIRECTIVE_RE.test(text)) return 'command';
  if (DIRECTIVE_RES.some(re => re.test(text))) return 'directive';
  return null;
}

export function isSensitiveNote(fileName: string, frontmatter: MemoryFrontmatter, sectionTitle: string): boolean {
  return [fileName, frontmatter.name, frontmatter.description, sectionTitle].some(label => SENSITIVE_NAME_RE.test(label ?? ''));
}

function namesProject(text: string, names: string[]): boolean {
  return names.some(name => {
    const pattern = name.trim().split(/[\s_-]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+');
    return pattern && new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  });
}

/**
 * Scope rules. User and machine scope can come ONLY from the sources below,
 * and even then a note that names its own project is about that project:
 * - a host's GLOBAL file (~/.codex/AGENTS.md, ~/.gemini/GEMINI.md) is the
 *   user's own standing instructions → user;
 * - a Claude entry typed `user` or `feedback` → user;
 * - a section whose heading names the environment → machine;
 * - everything else, including anything untyped → project.
 */
export function classifyLesson(input: {
  source: LessonSource;
  fileName: string;
  global: boolean;
  frontmatter: MemoryFrontmatter;
  section: MemorySection;
  maskedText: string;
  secrets: number;
  /** The note's own project's names (folder, repository); empty for global files. */
  projectNames?: string[];
}): LessonClassification {
  const type = input.frontmatter.type;
  const kind = type ?? (input.global ? 'instructions' : 'note');
  let scope: LessonScope = 'project';
  let scopeReason: ScopeReason = 'project-default';
  if (input.global) { scope = 'user'; scopeReason = 'global-file'; }
  else if (namesProject(input.maskedText, input.projectNames ?? [])) scopeReason = 'names-project';
  else if (type === 'user' || type === 'feedback') { scope = 'user'; scopeReason = `${type}-entry`; }
  else if (ENVIRONMENT_TITLE_RE.test(input.section.title)) { scope = 'machine'; scopeReason = 'environment-heading'; }
  const sensitive = isSensitiveNote(input.fileName, input.frontmatter, input.section.title);
  return { scope, scopeReason, kind, quarantineReason: quarantineReason(input.maskedText, input.secrets, sensitive) };
}
