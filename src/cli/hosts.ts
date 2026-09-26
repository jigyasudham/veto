// Every AI host Veto registers with, in one table.
//
// Before 3.7.0 each host's config path was written out three times — once for
// `veto init`, once for `veto doctor`, once for `veto_platform_setup` — and all
// three still named the file Antigravity stopped reading when it moved its
// global MCP config to ~/.gemini/config/mcp_config.json. `init` kept writing the
// old file, `doctor` kept finding Veto in it and printed a green tick, and every
// Antigravity session since that host update started with no Veto tools at all.
//
// So the rules here are:
//   • One entry per host, read by init, doctor and platform setup alike.
//   • Where a host has its own registration CLI (claude, codex, agy), use it:
//     the host decides where its config lives, so a move on its side cannot
//     strand Veto in a file nobody reads.
//   • "Registered" is whatever the HOST reports (`<cli> mcp list`), not "a file
//     Veto wrote contains a veto key". A file is only the fallback when the
//     host's CLI is not on PATH, and doctor says which one it used.
//   • "Installed" means the host's binary is on PATH or its own app directory
//     exists — never a directory another host also creates (~/.gemini is made
//     by Antigravity too, which is how a machine without Gemini CLI was told
//     Gemini CLI was "registered").

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

export type HostId = 'claude' | 'codex' | 'antigravity' | 'gemini' | 'cursor' | 'windsurf' | 'zed';

export type JsonKey = 'mcpServers' | 'servers' | 'context_servers';

export type HostSpec = {
  id: HostId;
  name: string;
  /** Executables whose presence on PATH means the host is installed. */
  binaries: string[];
  /**
   * Directories that belong to this host alone. Used for GUI apps that put no
   * binary on PATH. Must never be a directory another host also creates.
   */
  ownDirs: string[];
  /** The host's own registration CLI, when it has one. */
  cli?: {
    bin: string;
    add: (command: string, args: string[]) => string[];
    list: string[];
  };
  /** The config file the host reads, used when its CLI is unavailable (and for reporting). */
  config?: { path: string; key: JsonKey; format: 'json' | 'jsonc' | 'toml' };
  /** Files Veto once wrote that this host no longer reads. Reported, never trusted. */
  legacyConfigs?: string[];
  /** Where Veto's fallback skill goes, for hosts that list skills to the model. */
  skillDirs?: string[];
};

export const SERVER_PACKAGE = '@jigyasudham/veto@latest';

/** The command every host is given. npx.cmd on Windows: hosts cannot resolve a bare `npx` there. */
export function serverCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return { command: platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '--package', SERVER_PACKAGE, 'veto-server'] };
}

export function hostSpecs(home: string = homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): HostSpec[] {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const zedDir = platform === 'win32' ? join(appData, 'Zed') : join(home, '.config', 'zed');
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      binaries: ['claude'],
      ownDirs: [join(home, '.claude')],
      cli: {
        bin: 'claude',
        add: (command, args) => ['mcp', 'add', 'veto', '-s', 'user', '--', command, ...args],
        list: ['mcp', 'list'],
      },
      skillDirs: [join(home, '.claude', 'skills')],
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      binaries: ['codex'],
      ownDirs: [codexHome],
      cli: {
        bin: 'codex',
        add: (command, args) => ['mcp', 'add', 'veto', '--', command, ...args],
        list: ['mcp', 'list'],
      },
      config: { path: join(codexHome, 'config.toml'), key: 'mcpServers', format: 'toml' },
      skillDirs: [join(codexHome, 'skills')],
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      binaries: ['agy'],
      ownDirs: [join(home, '.gemini', 'antigravity-cli'), join(home, '.gemini', 'antigravity')],
      cli: {
        bin: 'agy',
        add: (command, args) => ['mcp', 'add', 'veto', '--', command, ...args],
        list: ['mcp', 'list'],
      },
      // Verified 2026-09-26 against agy's own `mcp list` with a scratch home:
      // only this file is read; the antigravity-cli copy is ignored.
      config: { path: join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers', format: 'json' },
      legacyConfigs: [join(home, '.gemini', 'antigravity-cli', 'mcp_config.json')],
      // Antigravity's global customization root is ~/.gemini/config/ (its own
      // guide says so). Verified 2026-09-26: a skill in ~/.gemini/skills was
      // never listed to the model; the same file in ~/.gemini/config/skills was
      // read, and the model ran `veto continue` as the skill says.
      skillDirs: [join(home, '.gemini', 'config', 'skills')],
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      binaries: ['gemini'],
      ownDirs: [],
      config: { path: join(home, '.gemini', 'settings.json'), key: 'mcpServers', format: 'json' },
      skillDirs: [join(home, '.gemini', 'skills')],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      binaries: ['cursor'],
      ownDirs: [join(home, '.cursor')],
      config: { path: join(home, '.cursor', 'mcp.json'), key: 'mcpServers', format: 'json' },
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      binaries: ['windsurf'],
      ownDirs: [join(home, '.codeium', 'windsurf')],
      config: { path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers', format: 'json' },
    },
    {
      id: 'zed',
      name: 'Zed',
      binaries: ['zed'],
      ownDirs: [zedDir],
      // Zed's settings file allows comments; see json-config.ts for why Veto will not rewrite one that has them.
      config: { path: join(zedDir, 'settings.json'), key: 'context_servers', format: 'jsonc' },
    },
  ];
}

/**
 * Find an executable on PATH without spawning anything (no console window on
 * Windows, no shell). Honours PATHEXT, so `claude` finds `claude.cmd`.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}

export type Installed = { installed: boolean; via: 'path' | 'dir' | null; binary: string | null };

export function detectHost(spec: HostSpec, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Installed {
  for (const b of spec.binaries) {
    const found = findOnPath(b, env, platform);
    if (found) return { installed: true, via: 'path', binary: found };
  }
  if (spec.ownDirs.some(d => existsSync(d))) return { installed: true, via: 'dir', binary: null };
  return { installed: false, via: null, binary: null };
}

// ─── Reading what the host itself reports ────────────────────────────────────

/** What a host's own `mcp list` says about Veto. */
export type ListedState = 'connected' | 'failed' | 'enabled' | 'disabled' | 'listed' | 'absent';

/**
 * Parse `<host> mcp list` output for the `veto` entry — and only that entry:
 * a `veto-dev` or `my-veto-fork` server must not count as Veto.
 *
 *   claude:       `veto: npx.cmd -y … veto-server - ✔ Connected` (or `✗ Failed to connect`)
 *   codex:        a table; `veto  npx.cmd  -y …  -  -  enabled  Unsupported`
 *   antigravity:  a table; `veto  stdio  enabled  npx.cmd -y …`
 */
export function parseMcpList(output: string): ListedState {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^veto(?::|\s)/.test(line)) continue;
    if (/[✔✓]\s*connected/i.test(line)) return 'connected';
    if (/[✗✘x]\s*failed|failed to connect|disconnected/i.test(line)) return 'failed';
    if (/\bdisabled\b/i.test(line)) return 'disabled';
    if (/\benabled\b/i.test(line)) return 'enabled';
    return 'listed';
  }
  return 'absent';
}

/** Is a server entry, as a host stores it, switched off? */
export function entryDisabled(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return e.disabled === true || e.enabled === false;
}
