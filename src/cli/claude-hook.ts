// The Claude Code secrets-scan hook `veto init` installs in a project.
//
// Every version before 3.7.0 installed one that could never fire:
//   • Its command passed "$CLAUDE_TOOL_INPUT_FILE_PATH". Claude Code sets no such
//     variable — a hook receives its input as JSON on stdin — so the script got an
//     empty path and exited 0 on every write.
//   • On a finding it exited 1, which Claude Code treats as a non-blocking error
//     shown only to the user in verbose mode. Exit 2 is what sends stderr back to
//     the model.
//   • It also wrote `.claude/hooks/pre-compact` and `post-file-write`, files Claude
//     Code never runs (hooks are declared in settings.json), and pre-compact called
//     `veto veto_session_save`, a CLI command that has never existed.
//
// The replacement is a dependency-free Node script (Node is already required by
// Veto), identical on every OS, reading the hook JSON from stdin.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HOOK_FILE = 'veto-secrets-scan.mjs';
export const HOOK_COMMAND = `node .claude/hooks/${HOOK_FILE}`;

export const HOOK_SCRIPT = `// Veto: scan a file Claude Code just wrote for exposed secrets.
// Installed by \`veto init\`. Claude Code passes the tool call as JSON on stdin.
// Exit 2 sends the message on stderr back to Claude; exit 0 means nothing found.
import { readFileSync, statSync } from 'node:fs';

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { process.exit(0); }
let path = '';
try { path = JSON.parse(input)?.tool_input?.file_path ?? ''; } catch { process.exit(0); }
if (!path) process.exit(0);
try { if (statSync(path).size > 2_000_000) process.exit(0); } catch { process.exit(0); }

let text = '';
try { text = readFileSync(path, 'utf8'); } catch { process.exit(0); }

const PATTERNS = [
  ['AWS access key', /\\bAKIA[0-9A-Z]{16}\\b/],
  ['GitHub token', /\\bgh[pousr]_[A-Za-z0-9]{36,}\\b/],
  ['Slack token', /\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b/],
  ['OpenAI/Anthropic-style key', /\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\\b/],
  ['Google API key', /\\bAIza[0-9A-Za-z_-]{35}\\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['hard-coded secret', /(?:api[_-]?key|secret[_-]?key|password|passwd|access[_-]?token|private[_-]?key)["']?\\s*[:=]\\s*["'][A-Za-z0-9+\\/_\\-]{16,}["']/i],
];
const hits = [];
const lines = text.split(/\\r?\\n/);
for (let i = 0; i < lines.length && hits.length < 5; i++) {
  for (const [name, re] of PATTERNS) {
    if (re.test(lines[i])) { hits.push(\`line \${i + 1}: \${name}\`); break; }
  }
}
if (hits.length) {
  process.stderr.write(\`Veto: possible secret in \${path} — \${hits.join('; ')}. Move it to an environment variable or secret store before committing.\\n\`);
  process.exit(2);
}
process.exit(0);
`;

/** Is this PostToolUse hook entry the broken one an older `veto init` wrote? */
export function isLegacyVetoHook(command: unknown): boolean {
  return typeof command === 'string' && command.includes('veto-secrets-scan') && command.includes('CLAUDE_TOOL_INPUT_FILE_PATH');
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

export type HookInstall = {
  settings: 'added' | 'migrated' | 'present' | 'failed';
  removedDeadFiles: string[];
};

// What older inits wrote into .claude/hooks — removed only when byte-identical.
const DEAD_FILES: Record<string, string[]> = {
  'pre-compact': [
    '@npx -y @jigyasudham/veto veto_session_save --auto_summarize=true',
    '#!/bin/sh\nnpx -y @jigyasudham/veto veto_session_save --auto_summarize=true',
  ],
  'post-file-write': [
    '@powershell -NoProfile -ExecutionPolicy Bypass -File ".claude\\hooks\\veto-secrets-scan.ps1" "%1"',
    '#!/bin/sh\n./.claude/hooks/veto-secrets-scan.sh "$1"',
  ],
};

export function installClaudeHook(projectDir: string): HookInstall {
  const hooksDir = join(projectDir, '.claude', 'hooks');
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  const removedDeadFiles: string[] = [];
  try {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, HOOK_FILE), HOOK_SCRIPT, 'utf8');

    for (const [name, contents] of Object.entries(DEAD_FILES)) {
      const p = join(hooksDir, name);
      try {
        if (existsSync(p) && contents.includes(readFileSync(p, 'utf8'))) { unlinkSync(p); removedDeadFiles.push(p); }
      } catch { /* leave it */ }
    }

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>; }
      catch { return { settings: 'failed', removedDeadFiles }; }
    } else {
      mkdirSync(dirname(settingsPath), { recursive: true });
    }
    const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown>;
    const post = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as HookGroup[]) : [];

    let migrated = false;
    let present = false;
    for (const group of post) {
      for (const h of group.hooks ?? []) {
        if (isLegacyVetoHook(h.command)) { h.command = HOOK_COMMAND; migrated = true; }
        else if (h.command === HOOK_COMMAND) present = true;
      }
    }
    let outcome: HookInstall['settings'];
    if (migrated) outcome = 'migrated';
    else if (present) outcome = 'present';
    else {
      post.push({ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: HOOK_COMMAND }] });
      outcome = 'added';
    }
    if (outcome !== 'present') {
      hooks.PostToolUse = post;
      settings.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    }
    return { settings: outcome, removedDeadFiles };
  } catch {
    return { settings: 'failed', removedDeadFiles };
  }
}

/** For `veto doctor`: does this project still carry the hook that never fired? */
export function projectHookState(projectDir: string): 'working' | 'legacy-broken' | 'none' {
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: { PostToolUse?: HookGroup[] } };
    const commands = (settings.hooks?.PostToolUse ?? []).flatMap(g => (g.hooks ?? []).map(h => h.command));
    if (commands.some(isLegacyVetoHook)) return 'legacy-broken';
    if (commands.includes(HOOK_COMMAND) && existsSync(join(projectDir, '.claude', 'hooks', HOOK_FILE))) return 'working';
  } catch { /* no settings */ }
  return 'none';
}
