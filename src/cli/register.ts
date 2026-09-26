// Register Veto with a host, and find out what the host itself says about it.
//
// See hosts.ts for why the host's own CLI comes first. Two fallbacks the old
// code used were not fallbacks at all and are gone:
//   • Claude Code without its CLI on PATH got an `mcpServers` key written into
//     ~/.claude/settings.json and a ✓. Claude Code does not read MCP servers
//     from that file, so the ✓ was false. Now the user gets the command to run.
//   • `veto doctor` accepted that same settings.json key as "registered".

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectHost, entryDisabled, parseMcpList, serverCommand, type HostSpec, type Installed, type ListedState } from './hosts.js';
import { mergeServerEntry, readJsonConfig, vetoEntry, type ConfigRead } from './json-config.js';

function winQuote(a: string): string {
  return /^[\w@./:=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

export type CliRun = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

/** Run a host CLI without a console window. Windows needs a shell to resolve .cmd shims. */
export function runHostCli(bin: string, args: string[], timeoutMs: number): CliRun {
  const isWin = process.platform === 'win32';
  const r = isWin
    ? spawnSync([bin, ...args].map(winQuote).join(' '), { shell: true, windowsHide: true, encoding: 'utf8', timeout: timeoutMs })
    : spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: timeoutMs });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut };
}

// ─── Registering ─────────────────────────────────────────────────────────────

export type RegisterOutcome =
  | { status: 'registered' | 'already' | 'updated'; via: 'cli' | 'file'; detail: string; backup?: string | null }
  | { status: 'manual'; detail: string; instructions: string[] }
  | { status: 'skipped'; detail: string };

function manualCommand(spec: HostSpec): string | null {
  if (!spec.cli) return null;
  const { command, args } = serverCommand();
  return [spec.cli.bin, ...spec.cli.add(command, args)].join(' ');
}

export function registerHost(spec: HostSpec, installed: Installed, runner: typeof runHostCli = runHostCli): RegisterOutcome {
  const { command, args } = serverCommand();

  if (spec.cli && installed.via === 'path') {
    const r = runner(spec.cli.bin, spec.cli.add(command, args), 30_000);
    if (r.ok) return { status: 'registered', via: 'cli', detail: `${spec.cli.bin} mcp add` };
    if (/already|exists/i.test(r.stderr + r.stdout)) return { status: 'already', via: 'cli', detail: `${spec.cli.bin} reports veto is already registered` };
    // The CLI is there but refused: fall through to the file only for hosts
    // whose file is authoritative; otherwise hand the user the command.
    if (!spec.config || spec.config.format === 'toml') {
      return { status: 'manual', detail: `${spec.cli.bin} mcp add failed${r.timedOut ? ' (timed out)' : ''}`, instructions: [manualCommand(spec)!, (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''].filter(Boolean) };
    }
  }

  if (spec.id === 'claude') {
    // Claude Code keeps MCP servers in its own registry; no plain file is read.
    return { status: 'manual', detail: 'the claude command is not on PATH', instructions: [manualCommand(spec)!] };
  }

  if (spec.config?.format === 'toml') {
    const res = writeVetoTomlEntry(spec.config.path, command, args);
    if (res === 'skipped') return { status: 'manual', detail: `could not write ${spec.config.path}`, instructions: [manualCommand(spec) ?? ''] };
    return { status: res === 'exists' ? 'already' : 'registered', via: 'file', detail: spec.config.path };
  }

  if (spec.config) {
    const entry: Record<string, unknown> = spec.config.key === 'servers'
      ? { type: 'stdio', command, args }
      : { command, args };
    const res = mergeServerEntry(spec.config.path, spec.config.key, entry);
    if (res.result === 'manual') {
      return { status: 'manual', detail: `${spec.config.path} was left untouched: ${res.reason}`, instructions: [`Add this to ${spec.config.path}:`, res.snippet] };
    }
    if (res.result === 'unchanged') return { status: 'already', via: 'file', detail: spec.config.path };
    return { status: res.result === 'created' ? 'registered' : 'updated', via: 'file', detail: spec.config.path, backup: res.backup };
  }

  return { status: 'skipped', detail: 'no registration method' };
}

/** Append a [mcp_servers.veto] table to Codex's config.toml when its CLI is unavailable. */
export function writeVetoTomlEntry(path: string, command: string, args: string[]): 'created' | 'exists' | 'skipped' {
  try {
    let existing = '';
    if (existsSync(path)) {
      existing = readFileSync(path, 'utf8');
      if (/^\s*\[mcp_servers\.veto\]\s*$/m.test(existing)) return 'exists';
    }
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const entry = `\n[mcp_servers.veto]\ncommand = ${q(command)}\nargs = [${args.map(q).join(', ')}]\n`;
    writeFileSync(path, existing + entry, 'utf8');
    return 'created';
  } catch {
    return 'skipped';
  }
}

// ─── Inspecting ──────────────────────────────────────────────────────────────

export type RegistrationState =
  | ListedState                  // what the host's own `mcp list` reported
  | 'in-file' | 'in-file-disabled' // read from the file the host reads (its CLI unavailable)
  | 'missing'
  | 'unreadable';

export type HostReport = {
  spec: HostSpec;
  installed: Installed;
  state: RegistrationState;
  /** Where the state came from. */
  source: string;
  /** Veto is only in a file this host no longer reads. */
  legacyOnly: boolean;
  /** The command/args the host was given, when they could be read (for probing). */
  entry: { command: string; args: string[] } | null;
  note: string | null;
};

function tomlVetoSection(text: string): string | null {
  const m = text.match(/^\s*\[mcp_servers\.veto\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m);
  return m ? m[1] : null;
}

function entryFromToml(section: string): { command: string; args: string[] } | null {
  const cmd = section.match(/^\s*command\s*=\s*["']([^"']+)["']/m)?.[1];
  const argsRaw = section.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (!cmd) return null;
  const args = argsRaw ? [...argsRaw.matchAll(/["']([^"']*)["']/g)].map(m => m[1]) : [];
  return { command: cmd, args };
}

function entryFromJson(entry: unknown): { command: string; args: string[] } | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  // Zed's older shape nests it: { command: { path, args } }
  if (e.command && typeof e.command === 'object') {
    const c = e.command as Record<string, unknown>;
    return typeof c.path === 'string' ? { command: c.path, args: Array.isArray(c.args) ? c.args.map(String) : [] } : null;
  }
  return typeof e.command === 'string' ? { command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [] } : null;
}

function claudeUserEntry(home: string): { command: string; args: string[] } | null {
  const read = readJsonConfig(join(home, '.claude.json'));
  return entryFromJson(vetoEntry(read, 'mcpServers'));
}

export function inspectHost(spec: HostSpec, options: { home?: string; runner?: typeof runHostCli; useCli?: boolean; env?: NodeJS.ProcessEnv } = {}): HostReport {
  const home = options.home ?? homedir();
  const runner = options.runner ?? runHostCli;
  const installed = detectHost(spec, options.env);
  const base = { spec, installed, legacyOnly: false, entry: null as HostReport['entry'], note: null as string | null };
  if (!installed.installed) return { ...base, state: 'missing', source: 'not installed' };

  // What the host's file says (used for the probe command, and as the answer
  // when the host's CLI is not available).
  let fileState: RegistrationState = 'missing';
  let fileRead: ConfigRead | null = null;
  if (spec.config?.format === 'toml') {
    try {
      const section = existsSync(spec.config.path) ? tomlVetoSection(readFileSync(spec.config.path, 'utf8')) : null;
      if (section !== null) {
        base.entry = entryFromToml(section);
        fileState = /^\s*enabled\s*=\s*false\s*$/m.test(section) ? 'in-file-disabled' : 'in-file';
      }
    } catch { fileState = 'unreadable'; }
  } else if (spec.config) {
    fileRead = readJsonConfig(spec.config.path);
    if (fileRead.state === 'invalid') fileState = 'unreadable';
    const entry = vetoEntry(fileRead, spec.config.key);
    if (entry) {
      base.entry = entryFromJson(entry);
      fileState = entryDisabled(entry) ? 'in-file-disabled' : 'in-file';
    }
  } else if (spec.id === 'claude') {
    base.entry = claudeUserEntry(home);
    if (base.entry) fileState = 'in-file';
  }

  // Legacy files: present, but this host does not read them.
  const legacyHasVeto = (spec.legacyConfigs ?? []).some(p => !!vetoEntry(readJsonConfig(p), 'mcpServers'));

  if (spec.cli && installed.via === 'path' && options.useCli !== false) {
    const r = runner(spec.cli.bin, spec.cli.list, 60_000);
    if (r.ok || r.stdout.trim()) {
      const listed = parseMcpList(r.stdout + '\n' + r.stderr);
      if (!base.entry && fileState === 'missing' && listed !== 'absent') base.entry = serverCommand();
      return {
        ...base,
        state: listed === 'absent' ? 'missing' : listed,
        source: `${spec.cli.bin} ${spec.cli.list.join(' ')}`,
        legacyOnly: listed === 'absent' && legacyHasVeto,
      };
    }
    base.note = `${spec.cli.bin} ${spec.cli.list.join(' ')} ${r.timedOut ? 'timed out' : 'failed'} — fell back to reading the config file`;
  }

  const source = spec.config?.path ?? (spec.id === 'claude' ? join(home, '.claude.json') : 'none');
  if (fileRead?.state === 'ok' && fileRead.hasComments && fileState === 'missing') {
    base.note = `${source} has comments; Veto reads it but will not rewrite it`;
  }
  return { ...base, state: fileState, source, legacyOnly: fileState === 'missing' && legacyHasVeto };
}

/** States that mean "the host will start Veto". Anything else is a problem. */
export function isWorking(state: RegistrationState): boolean {
  return state === 'connected' || state === 'enabled' || state === 'listed' || state === 'in-file';
}
