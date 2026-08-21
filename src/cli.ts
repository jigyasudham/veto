#!/usr/bin/env node
// Veto CLI — entry point for `npx veto init`

// Suppress Node experimental warnings (node:sqlite) for clean UX
process.removeAllListeners('warning');

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { repairBrokenClaudeEntry } from './cli/claude-repair.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
const TAGLINE = '93 agentic tools. 49 specialists. Every major AI CLI. Self-learning. Zero extra cost on subscriptions.';
const VETO_DIR = join(homedir(), '.veto');
const HOME = homedir();

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function printBanner() {
  console.log('');
  console.log(c.bold(c.cyan('  ██╗   ██╗███████╗████████╗ ██████╗')));
  console.log(c.bold(c.cyan('  ██║   ██║██╔════╝╚══██╔══╝██╔═══██╗')));
  console.log(c.bold(c.cyan('  ██║   ██║█████╗     ██║   ██║   ██║')));
  console.log(c.bold(c.cyan('  ╚██╗ ██╔╝██╔══╝     ██║   ██║   ██║')));
  console.log(c.bold(c.cyan('   ╚████╔╝ ███████╗   ██║   ╚██████╔╝')));
  console.log(c.bold(c.cyan('    ╚═══╝  ╚══════╝   ╚═╝    ╚═════╝')));
  console.log('');
  console.log(c.dim(`  ${TAGLINE}`));
  console.log(c.dim(`  v${VERSION}`));
  console.log('');
}

// Merge veto entry into an existing JSON config file, creating it if needed.
// Supports both "mcpServers" format (Gemini/Cursor/Windsurf) and "context_servers" (Zed)
// and "servers" format (VS Code).
function writeVetoConfig(
  configPath: string,
  format: 'mcpServers' | 'servers' | 'context_servers'
): 'created' | 'updated' | 'skipped' {
  let existing: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      // Unreadable / invalid JSON — skip to avoid corrupting it
      return 'skipped';
    }
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const wasEmpty = Object.keys(existing).length === 0;

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  if (format === 'mcpServers') {
    const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
    servers['veto'] = { command: npxCmd, args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] };
    existing.mcpServers = servers;
  } else if (format === 'context_servers') {
    const servers = (existing.context_servers as Record<string, unknown>) ?? {};
    servers['veto'] = { command: npxCmd, args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] };
    existing.context_servers = servers;
  } else {
    const servers = (existing.servers as Record<string, unknown>) ?? {};
    servers['veto'] = { type: 'stdio', command: npxCmd, args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] };
    existing.servers = servers;
  }

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return wasEmpty ? 'created' : 'updated';
}

// Append a [mcp_servers.veto] section to a TOML config file (used for Codex CLI fallback).
function writeVetoTomlEntry(configPath: string): 'created' | 'updated' | 'skipped' {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    let existing = '';
    if (existsSync(configPath)) {
      try { existing = readFileSync(configPath, 'utf8'); } catch { return 'skipped'; }
      if (/\[mcp_servers\.veto\]/.test(existing)) return 'updated';
    }
    const entry = `\n[mcp_servers.veto]\ncommand = '${npxCmd}'\nargs = ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server']\n`;
    writeFileSync(configPath, existing + entry, 'utf8');
    return existing.trim() === '' ? 'created' : 'updated';
  } catch {
    return 'skipped';
  }
}

// All platforms Veto supports, with their config paths and formats.
// Claude Code and Codex CLI are NOT in this list — they are handled separately via
// their own CLIs (`claude mcp add -s user` / `codex mcp add`) because they store MCP
// registrations internally and do NOT read plain mcpServers JSON files.
const PLATFORMS = [
  {
    name: 'Gemini CLI',
    path: join(HOME, '.gemini', 'settings.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.gemini'),
  },
  {
    name: 'Antigravity CLI',
    path: join(HOME, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.gemini', 'antigravity-cli'),
  },
  {
    name: 'Cursor',
    path: join(HOME, '.cursor', 'mcp.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.cursor'),
  },
  {
    name: 'Windsurf',
    path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.codeium', 'windsurf'),
  },
  {
    name: 'Zed',
    // macOS/Linux: ~/.config/zed/settings.json  |  Windows: %APPDATA%\Zed\settings.json
    path: process.platform === 'win32'
      ? join(process.env.APPDATA ?? HOME, 'Zed', 'settings.json')
      : join(HOME, '.config', 'zed', 'settings.json'),
    format: 'context_servers' as const,
    detectionDir: process.platform === 'win32'
      ? join(process.env.APPDATA ?? HOME, 'Zed')
      : join(HOME, '.config', 'zed'),
  },
];

async function initCommand() {
  printBanner();

  // 1. Create ~/.veto directory
  if (!existsSync(VETO_DIR)) {
    mkdirSync(VETO_DIR, { recursive: true });
    console.log(c.green('  ✓') + ` Created ${VETO_DIR}`);
  } else {
    console.log(c.dim('  · ') + `Found existing ${VETO_DIR}`);
  }

  // 2. Initialize SQLite database
  process.stdout.write('  · Initializing SQLite database...');
  const { getDb, getDbPath, saveSession } = await import('./memory/local.js');

  try {
    const db = getDb();
    const dbPath = getDbPath();
    const { session_id } = saveSession({
      platform: 'claude',
      summary: 'Veto initialized',
      context: 'Initial setup via npx veto init',
    });
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id);
    if (!row) throw new Error('DB smoke test failed');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session_id);
    console.log(c.green(' ✓'));
    console.log(c.green('  ✓') + ` Database ready at ${dbPath}`);
  } catch (err: unknown) {
    console.log(c.red(' ✗'));
    const msg = err instanceof Error ? err.message : String(err);
    console.error(c.red(`  Error initializing database: ${msg}`));
    process.exit(1);
  }

  // 3. Auto-import VETO_MEMORY.md if present in cwd
  const cwd = resolve(process.cwd());
  const vetoMemoryPath = join(cwd, 'VETO_MEMORY.md');
  if (existsSync(vetoMemoryPath)) {
    process.stdout.write('  · Importing VETO_MEMORY.md...');
    try {
      const { importMemoryMarkdown } = await import('./memory/sync.js');
      const importResult = importMemoryMarkdown(vetoMemoryPath);
      console.log(c.green(' ✓') + ` ${importResult.imported} knowledge entries imported`);
    } catch {
      console.log(c.dim(' skipped'));
    }
  }

  // 4. Auto-scan current project and store project map
  const { updateProjectMap } = await import('./memory/local.js');
  const { discoverProject } = await import('./discover.js');
  try {
    process.stdout.write('  · Scanning project directory...');
    const disc = discoverProject(cwd, 'standard');
    updateProjectMap({
      project_dir: disc.project_dir,
      structure: { ecosystems: disc.ecosystems, key_files: disc.key_files, file_counts: disc.file_counts, total_files: disc.total_files, scanned_at: disc.scanned_at },
      key_modules: disc.key_files,
      tech_stack: disc.tech_stack,
    });
    const stackStr = disc.tech_stack.length ? ` (${disc.tech_stack.slice(0, 4).join(', ')})` : '';
    console.log(c.green(' ✓') + ` Project map saved${stackStr}`);
  } catch {
    console.log(c.dim(' skipped'));
  }

  // 4. Auto-configure every AI CLI / IDE found on this machine
  console.log('');
  console.log('  Configuring all AI tools found on this machine...');
  console.log('');

  let configured = 0;
  let skipped = 0;

  // ── Claude Code: use `claude mcp add -s user` (global across all windows/projects) ──
  // Claude Code does NOT read mcp_servers.json — it manages MCPs via its own registry.
  // The -s user flag stores the config at user scope so every window/project picks it up.
  const claudeDir = join(HOME, '.claude');
  if (existsSync(claudeDir)) {
    // Use npx.cmd on Windows — Claude Code cannot resolve a bare `npx` there.
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const mcpCmd = `claude mcp add veto -s user -- ${npxBin} -y --package @jigyasudham/veto@latest veto-server`;
    try {
      execSync(mcpCmd, { stdio: 'pipe', timeout: 15000 });
      console.log(c.green('  ✓ ') + 'Claude Code — registered (user scope: all windows & projects)');
      configured++;
    } catch (err: unknown) {
      const stderr = (err instanceof Error && 'stderr' in err) ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr) : '';
      // "already exists" means it was previously registered. But a stale entry can be
      // BROKEN — e.g. an old `node <global-install>/dist/server.js` that stops resolving
      // once the global install is removed (`npm rm -g`). Detect that and self-repair.
      if (/already|exists/i.test(stderr)) {
        if (repairBrokenClaudeEntry(join(HOME, '.claude.json'), mcpCmd)) {
          console.log(c.green('  ✓ ') + 'Claude Code — repaired stale registration (was pointing at a missing file)');
        } else {
          console.log(c.green('  ✓ ') + 'Claude Code — already registered (user scope)');
        }
        configured++;
      } else {
        // claude CLI not in PATH — fall back to ~/.claude/settings.json directly
        const result = writeVetoConfig(join(claudeDir, 'settings.json'), 'mcpServers');
        if (result === 'skipped') {
          console.log(c.yellow('  ⚠ ') + 'Claude Code — could not auto-configure. Run manually:');
          console.log(c.dim(`          ${mcpCmd}`));
          skipped++;
        } else {
          console.log(c.yellow('  ⚠ ') + `Claude Code — wrote settings.json (restart Claude Code)`);
          console.log(c.dim(`         For global scope, also run: ${mcpCmd}`));
          configured++;
        }
      }
    }
  } else {
    console.log(c.dim('  · ') + c.dim('Claude Code — not detected, skipping'));
  }

  // ── Codex CLI: use `codex mcp add` (writes to config.toml, NOT config.json) ──
  // Codex CLI stores MCP servers under [mcp_servers.name] in config.toml.
  // Writing to config.json with mcpServers format has no effect on Codex.
  const codexDir = join(HOME, '.codex');
  if (existsSync(codexDir)) {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const codexMcpCmd = `codex mcp add veto -- ${npxCmd} -y --package @jigyasudham/veto@latest veto-server`;
    try {
      execSync(codexMcpCmd, { stdio: 'pipe', timeout: 15000 });
      console.log(c.green('  ✓ ') + 'Codex CLI — registered');
      configured++;
    } catch (err: unknown) {
      const stderr = (err instanceof Error && 'stderr' in err) ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr) : '';
      if (/already|exists/i.test(stderr)) {
        console.log(c.green('  ✓ ') + 'Codex CLI — already registered');
        configured++;
      } else {
        // codex CLI not in PATH — write directly to config.toml
        const tomlResult = writeVetoTomlEntry(join(codexDir, 'config.toml'));
        if (tomlResult === 'skipped') {
          console.log(c.yellow('  ⚠ ') + 'Codex CLI — could not auto-configure. Run manually:');
          console.log(c.dim(`          ${codexMcpCmd}`));
          skipped++;
        } else {
          console.log(c.yellow('  ⚠ ') + 'Codex CLI — wrote config.toml (restart Codex to pick up)');
          configured++;
        }
      }
    }
  } else {
    console.log(c.dim('  · ') + c.dim('Codex CLI — not detected, skipping'));
  }

  // ── All other platforms: write global config files ─────────────────────────
  for (const platform of PLATFORMS) {
    const detected = existsSync(platform.detectionDir);
    if (!detected) {
      console.log(c.dim('  · ') + c.dim(`${platform.name} — not installed, skipping`));
      continue;
    }

    const result = writeVetoConfig(platform.path, platform.format);

    if (result === 'skipped') {
      console.log(c.yellow('  ⚠ ') + `${platform.name} — config unreadable, skipped`);
      skipped++;
    } else if (result === 'created') {
      console.log(c.green('  ✓ ') + `${platform.name} — configured (restart ${platform.name} to pick up)`);
      configured++;
    } else {
      console.log(c.green('  ✓ ') + `${platform.name} — updated (restart ${platform.name} to pick up)`);
      configured++;
    }
  }

  console.log('');

  // 5. Write platform-specific context guidance files
  // These are read at session start by each AI client — zero tool calls needed.
  console.log('  Writing context guidance files...');
  console.log('');

  const VETO_GUIDE = `# Veto MCP Server

Veto is active. 93 tools across 6 categories:

**Session & Context** — veto_status · veto_session_save · veto_continue · veto_handoff
Save work at 60–70% context capacity. veto_status triggers auto-save above 70%.

**Code Intelligence** — veto_diff_review · veto_code_review · veto_security_scan · veto_secrets_scan · veto_ci_gate
Run veto_diff_review before any merge — it runs all three scans in parallel.

**Council & Routing** — veto_council_debate · veto_route_task · veto_execute_parallel
Council = 7 specialist agents (Lead Dev, PM, Architect, UX, Devil's Advocate, Legal, Security).
Verdicts: GREEN (proceed) · YELLOW (warnings) · RED (blocked) · DEADLOCK (human decision needed).
Two-phase LLM-backed flow: call with { task } → get debate_prompt → reason as all 7 agents → call again with { task, agent_responses }.

**Memory & Discovery** — veto_discover · veto_summarize · veto_memory_store · veto_memory_search
Run veto_discover on any unfamiliar repo before touching files.

**Observability** — veto_usage_status · veto_health · veto_audit_log · veto_learning_stats

Recommended start sequence:
1. veto_status — confirm running
2. veto_discover — map the project
3. veto_route_task — pick the right agent
4. veto_diff_review — validate before shipping
5. veto_session_save — checkpoint before context fills
`;

  let ctxWritten = 0;

  // Gemini & Antigravity CLI: ~/.gemini/GEMINI.md
  const geminiDir = join(HOME, '.gemini');
  if (existsSync(geminiDir)) {
    try {
      writeFileSync(join(geminiDir, 'GEMINI.md'), VETO_GUIDE, 'utf8');
      console.log(c.green('  ✓ ') + 'Gemini/Antigravity CLI — wrote ~/.gemini/GEMINI.md');
      ctxWritten++;
    } catch { console.log(c.yellow('  ⚠ ') + 'Gemini/Antigravity CLI — could not write GEMINI.md'); }
  }

  // Codex CLI: project AGENTS.md + global ~/.codex/AGENTS.override.md
  const codexDir2 = join(HOME, '.codex');
  if (existsSync(codexDir2)) {
    // Project-level: only write if not already present (user may have customized it)
    const projectAgents = join(cwd, 'AGENTS.md');
    if (!existsSync(projectAgents)) {
      try {
        writeFileSync(projectAgents, VETO_GUIDE, 'utf8');
        console.log(c.green('  ✓ ') + `Codex CLI — wrote AGENTS.md in ${cwd}`);
        ctxWritten++;
      } catch { console.log(c.yellow('  ⚠ ') + 'Codex CLI — could not write AGENTS.md'); }
    } else {
      console.log(c.dim('  · ') + c.dim('Codex CLI — AGENTS.md already exists, skipping'));
    }
    // Global override
    try {
      writeFileSync(join(codexDir2, 'AGENTS.override.md'), VETO_GUIDE, 'utf8');
      console.log(c.green('  ✓ ') + 'Codex CLI — wrote ~/.codex/AGENTS.override.md');
      ctxWritten++;
    } catch { console.log(c.yellow('  ⚠ ') + 'Codex CLI — could not write AGENTS.override.md'); }
  }

  // Windsurf: ~/.codeium/windsurf/rules/veto.md
  const windsurfRulesDir = join(HOME, '.codeium', 'windsurf', 'rules');
  if (existsSync(join(HOME, '.codeium', 'windsurf'))) {
    try {
      mkdirSync(windsurfRulesDir, { recursive: true });
      writeFileSync(join(windsurfRulesDir, 'veto.md'), VETO_GUIDE, 'utf8');
      console.log(c.green('  ✓ ') + 'Windsurf — wrote ~/.codeium/windsurf/rules/veto.md');
      ctxWritten++;
    } catch { console.log(c.yellow('  ⚠ ') + 'Windsurf — could not write rules/veto.md'); }
  }

  if (ctxWritten > 0) console.log('');

  // 6. Write Claude Code hook templates to .claude/hooks/ in current project
  // Hooks enforce secrets scanning on every file write and auto-save before compaction.
  if (existsSync(claudeDir)) {
    const hooksDir = join(cwd, '.claude', 'hooks');
    const settingsPath = join(cwd, '.claude', 'settings.json');
    try {
      mkdirSync(hooksDir, { recursive: true });

      // Secrets scan — bash (Mac/Linux)
      const shLines = [
        '#!/usr/bin/env bash',
        '# Veto hook: scan written files for exposed secrets (no API key needed).',
        '# Triggered by Claude Code PostToolUse after Write/Edit tool calls.',
        'FILE="$1"',
        '[ -z "$FILE" ] && exit 0',
        '[ ! -f "$FILE" ] && exit 0',
        "PATTERNS='(api[_-]?key|secret[_-]?key|password|passwd|token|access[_-]?key|private[_-]?key)\\s*[=:]\\s*[A-Za-z0-9+/]{20,}'",
        'if grep -qiE "$PATTERNS" "$FILE" 2>/dev/null; then',
        '  echo "Veto: possible secret detected in $FILE — run veto_secrets_scan to confirm"',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ];
      writeFileSync(join(hooksDir, 'veto-secrets-scan.sh'), shLines.join('\n'), 'utf8');

      // Secrets scan — PowerShell (Windows)
      const ps1Lines = [
        '# Veto hook: scan written files for exposed secrets (no API key needed).',
        'param([string]$File)',
        'if (-not $File -or -not (Test-Path $File)) { exit 0 }',
        "$pattern = '(api[_-]?key|secret[_-]?key|password|passwd|token|access[_-]?key|private[_-]?key)\\s*[=:]\\s*[A-Za-z0-9+/]{20,}'",
        'if (Select-String -Path $File -Pattern $pattern -Quiet -CaseSensitive:$false) {',
        '  Write-Host "Veto: possible secret detected in $File — run veto_secrets_scan to confirm"',
        '  exit 1',
        '}',
        'exit 0',
        '',
      ];
      writeFileSync(join(hooksDir, 'veto-secrets-scan.ps1'), ps1Lines.join('\n'), 'utf8');

      // Phase 1.4: Write standard hook files that Claude Code looks for
      const postFileWrite = process.platform === 'win32'
        ? `@powershell -NoProfile -ExecutionPolicy Bypass -File ".claude\\hooks\\veto-secrets-scan.ps1" "%1"`
        : `#!/bin/sh\n./.claude/hooks/veto-secrets-scan.sh "$1"`;

      const preCompact = process.platform === 'win32'
        ? `@npx -y @jigyasudham/veto veto_session_save --auto_summarize=true`
        : `#!/bin/sh\nnpx -y @jigyasudham/veto veto_session_save --auto_summarize=true`;

      writeFileSync(join(hooksDir, 'post-file-write'), postFileWrite, { mode: 0o755 });
      writeFileSync(join(hooksDir, 'pre-compact'), preCompact, { mode: 0o755 });

      // Wire hooks into .claude/settings.json if it exists or create it
      let projectSettings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try { projectSettings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* leave empty */ }
      } else {
        mkdirSync(dirname(settingsPath), { recursive: true });
      }
      const hooks = (projectSettings.hooks as Record<string, unknown>) ?? {};
      // Only add if not already configured
      if (!hooks['PostToolUse']) {
        const scanCmd = process.platform === 'win32'
          ? 'powershell -ExecutionPolicy Bypass -File .claude/hooks/veto-secrets-scan.ps1 "$CLAUDE_TOOL_INPUT_FILE_PATH"'
          : 'bash .claude/hooks/veto-secrets-scan.sh "$CLAUDE_TOOL_INPUT_FILE_PATH"';
        hooks['PostToolUse'] = [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: scanCmd }] }];
        projectSettings.hooks = hooks;
        writeFileSync(settingsPath, JSON.stringify(projectSettings, null, 2) + '\n', 'utf8');
        console.log(c.green('  ✓ ') + 'Claude Code — wrote .claude/hooks/veto-secrets-scan + PostToolUse hook entry');
      } else {
        console.log(c.dim('  · ') + c.dim('Claude Code — PostToolUse hook already configured, skipping'));
      }
    } catch { console.log(c.yellow('  ⚠ ') + 'Claude Code — could not write hook templates (permission denied?)'); }
    console.log('');
  }

  if (configured === 0 && skipped === 0) {
    console.log(c.yellow('  ⚠  No AI tools detected.'));
    console.log('  Install Claude Code, Gemini CLI, Antigravity CLI, or Codex CLI and run veto init again.');
    console.log('');
  } else {
    console.log('');
    console.log(c.green(`  ✓ Veto configured for ${configured} tool${configured !== 1 ? 's' : ''}!`));
    console.log('');
    console.log('  Next steps:');
    console.log(c.dim('  1.') + ' Fully restart each configured AI client (not just reload)');
    console.log(c.dim('  2.') + ' For Claude Code: config is user-scoped — every window picks it up automatically');
    console.log(c.dim('  3.') + ' For Gemini / Cursor / Windsurf / Zed: config is written globally to your home dir');
    console.log(c.dim('  4.') + ' Verify: call veto_status in your AI client — should return { "status": "running" }');
    console.log('');
    console.log(c.dim('  Tip: run `veto init` again anytime to install newly-added AI tools.'));
    console.log('');
  }

  // ── Billing mode detection ──────────────────────────────────────────────────
  // Check for API key env vars as a signal the user may be on pay-per-token billing.
  const apiKeyEnvVars = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
  const detectedKeys = apiKeyEnvVars.filter(k => !!process.env[k]);
  const { setConfig: setVetoConfig } = await import('./memory/config.js');

  if (detectedKeys.length > 0) {
    setVetoConfig({ billing_mode: 'api' });
    console.log(c.yellow('  ⚠  API key environment variables detected:') + c.dim(` ${detectedKeys.join(', ')}`));
    console.log(c.yellow('     Veto has set billing_mode = api in ~/.veto/config.json.'));
    console.log('');
    console.log('  ' + c.bold('Important — cost warning:'));
    console.log('  Veto\'s "zero cost" claim applies to subscription plans (Claude Max, Gemini');
    console.log('  Advanced, etc.). On API/pay-per-token billing, any MCP Sampling calls made');
    console.log('  by Veto agents will count toward your token usage and be billed accordingly.');
    console.log('');
    console.log(c.dim('  To silence this warning if you are on a subscription:'));
    console.log(c.dim('  Edit ~/.veto/config.json and set "billing_mode": "subscription"'));
    console.log('');
  } else {
    setVetoConfig({ billing_mode: 'subscription' });
  }

  // ── Post-install health check ───────────────────────────────────────────────
  // Confirm the server can actually run before the user discovers a failure inside
  // their AI client. The one real runtime risk is node:sqlite (unflagged in 22.13+/23.4+).
  console.log('  ' + c.bold('Post-install check'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  let healthOk = true;

  // Ask the runtime whether it can actually load node:sqlite rather than deriving it
  // from the version number. The arithmetic version of this check accepted 22.5–22.12
  // and 23.0–23.3, where the module exists only behind --experimental-sqlite, so
  // `veto doctor` reported a green tick on installs whose persistence was dead.
  const { sqliteAvailable } = await import('./memory/local.js');
  if (sqliteAvailable()) {
    console.log(`  ${c.green('✓')} Node.js ${process.version}`);
  } else {
    console.log(`  ${c.red('✗')} Node.js ${process.version} — Veto needs >= 22.13 (or >= 23.4) for node:sqlite; persistence will not work`);
    healthOk = false;
  }

  try {
    const { getDb } = await import('./memory/local.js');
    getDb(); // exercises node:sqlite + schema/migration init
    console.log(`  ${c.green('✓')} Local database initialised`);
  } catch (err: unknown) {
    console.log(`  ${c.red('✗')} Database failed to initialise: ${err instanceof Error ? err.message : String(err)}`);
    healthOk = false;
  }
  console.log('');

  // MCP Sampling support is client-dependent and can't be probed from the CLI —
  // surface the honest guidance so the fallback path isn't a surprise.
  console.log('  ' + c.bold('MCP Sampling') + c.dim(' (powers zero-extra-cost agent reasoning)'));
  console.log(c.dim('  Clients with Sampling (Claude Code, Cursor, Windsurf, VS Code) run agents'));
  console.log(c.dim('  directly. Clients without it get an agentic-fallback prompt to reason instead.'));
  console.log(c.dim('  Run `veto doctor` anytime for the full health + registration report.'));
  console.log('');

  if (!healthOk) {
    console.log(c.yellow('  ⚠  Resolve the issues above before using Veto in your AI client.'));
    console.log('');
  }
}


// ─── Doctor Command ─────────────────────────────────────────────────────────────

async function doctorCommand() {
  console.log('');
  console.log(c.bold('  Veto Doctor') + c.dim(' — system health check'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log('');

  let issues = 0;

  // Node.js version
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeMajor >= 22) {
    console.log(`  ${c.green('✓')} Node.js ${process.version}`);
  } else {
    console.log(`  ${c.red('✗')} Node.js ${process.version} — need >= 22`);
    issues++;
  }

  // Version — the running build, compared best-effort against the registry's
  // latest so an out-of-date install is visible at a glance.
  let latest = '';
  try {
    latest = execSync('npm view @jigyasudham/veto version', { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* offline / npm unavailable — skip the comparison */ }

  if (latest && latest !== VERSION) {
    console.log(`  ${c.yellow('⚠')} Veto v${VERSION} — ${c.yellow(`v${latest} is available`)}`);
    issues++;
  } else if (latest) {
    console.log(`  ${c.green('✓')} Veto v${VERSION} ${c.dim('(latest)')}`);
  } else {
    console.log(`  ${c.green('✓')} Veto v${VERSION}`);
  }

  // Global CLI install — how the bare `veto` command gets on PATH. Since 2.7.1
  // every generated MCP config pins `@latest`, which npx must re-resolve against
  // the registry, so a global copy can no longer shadow the MCP server. Only
  // flag it when it has fallen behind the registry.
  let globalVersion = '';
  try {
    const out = execSync('npm ls -g @jigyasudham/veto --depth=0', { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });
    globalVersion = out.match(/@jigyasudham\/veto@([\d.]+)/)?.[1] ?? '';
  } catch { /* not installed globally — CLI still reachable via npx */ }

  if (globalVersion && latest && globalVersion !== latest) {
    console.log(`  ${c.yellow('⚠')} Global CLI install v${globalVersion} — ${c.yellow(`v${latest} is available`)}`);
    console.log(`  ${c.dim(`    update: ${c.cyan('npm i -g @jigyasudham/veto@latest')} (the MCP server is unaffected — its config pins @latest)`)}`);
    issues++;
  } else if (globalVersion) {
    console.log(`  ${c.green('✓')} Global CLI install v${globalVersion} ${c.dim('— bare veto commands on PATH')}`);
  } else {
    console.log(`  ${c.dim('·')} No global CLI install — bare ${c.cyan('veto')} commands unavailable in this terminal`);
    console.log(`  ${c.dim(`    optional: ${c.cyan('npm i -g @jigyasudham/veto')} — safe: MCP configs pin @latest, so a global copy cannot shadow the server`)}`);
  }

  // ~/.veto directory
  if (existsSync(VETO_DIR)) {
    console.log(`  ${c.green('✓')} ${c.dim(VETO_DIR)} exists`);
  } else {
    console.log(`  ${c.red('✗')} ${VETO_DIR} missing — run: ${c.cyan('veto init')}`);
    issues++;
  }

  // SQLite database
  try {
    const { getDb, getDbPath } = await import('./memory/local.js');
    const db = getDb();
    const dbPath = getDbPath();
    const sessions  = (db.prepare('SELECT COUNT(*) as c FROM sessions').get()       as { c: number }).c;
    const memories  = (db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get() as { c: number }).c;
    const patterns  = (db.prepare('SELECT COUNT(*) as c FROM patterns').get()       as { c: number }).c;
    console.log(`  ${c.green('✓')} Database ${c.dim(dbPath)}`);
    console.log(`  ${c.dim('    ')}${sessions} sessions · ${memories} memories · ${patterns} patterns`);
  } catch (err: unknown) {
    console.log(`  ${c.red('✗')} Database error: ${err instanceof Error ? err.message : String(err)}`);
    issues++;
  }

  // Semantic search model. It degrades SILENTLY at query time — by design, so a
  // damaged copy can never take recall down — which is precisely why its state
  // belongs in a health check. Without this line, a missing model is
  // indistinguishable from search simply getting worse.
  try {
    const { isCaptureEnabled } = await import('./transcripts/config.js');
    const { embeddingsAvailable, modelProvenance } = await import('./transcripts/embed.js');
    const captureOn = isCaptureEnabled();

    if (embeddingsAvailable()) {
      const { model_id, revision } = modelProvenance();
      console.log(`  ${c.green('✓')} Semantic search ${c.dim(`${model_id}@${revision.slice(0, 12)}`)}`);
      if (!captureOn) {
        console.log(`  ${c.dim(`    transcript capture is off — enable with ${c.cyan('veto transcripts enable')}`)}`);
      }
    } else if (captureOn) {
      // Only an issue when capture is on: that is the one case where a user is
      // actively searching and silently getting less than they should.
      console.log(`  ${c.yellow('⚠')} Semantic search unavailable — recall is keyword-only`);
      console.log(`  ${c.dim(`    the embedding table ships with Veto; reinstall to restore it: ${c.cyan('npm i -g @jigyasudham/veto@latest')}`)}`);
      issues++;
    } else {
      console.log(`  ${c.dim('·')} Semantic search idle ${c.dim('— transcript capture is off')}`);
    }
  } catch {
    // The whole feature is optional; a health check must never be the thing
    // that fails because an optional dependency is absent.
    console.log(`  ${c.dim('·')} Semantic search unavailable ${c.dim('— recall would run keyword-only')}`);
  }

  console.log('');
  console.log('  ' + c.bold('MCP Registrations'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));

  // Claude Code — check via `claude mcp list`, fall back to reading settings.json
  const claudeDir = join(HOME, '.claude');
  if (existsSync(claudeDir)) {
    let claudeOk = false;
    let claudeNote = '';
    try {
      const out = execSync('claude mcp list', { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });
      if (/veto/i.test(out)) { claudeOk = true; }
    } catch { /* claude CLI not in PATH */ }

    // Fall back: check known config files directly
    if (!claudeOk) {
      for (const f of ['settings.json', 'mcp_servers.json']) {
        try {
          const s = JSON.parse(readFileSync(join(claudeDir, f), 'utf8'));
          if (s?.mcpServers?.veto) { claudeOk = true; claudeNote = c.dim(` (${f})`); break; }
        } catch { /* skip */ }
      }
    }
    if (claudeOk) {
      console.log(`  ${c.green('✓')} Claude Code — registered${claudeNote}`);
    } else {
      console.log(`  ${c.red('✗')} Claude Code — not registered`);
      console.log(`  ${c.dim('    fix: claude mcp add veto -s user -- npx -y --package @jigyasudham/veto@latest veto-server')}`);
      issues++;
    }
  } else {
    console.log(`  ${c.dim('·')} ${c.dim('Claude Code — not installed')}`);
  }

  // Codex CLI — check via `codex mcp list`, fall back to reading config.toml
  const codexDirD = join(HOME, '.codex');
  if (existsSync(codexDirD)) {
    let codexOk = false;
    try {
      const out = execSync('codex mcp list', { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });
      if (/veto/i.test(out)) { codexOk = true; }
    } catch { /* codex CLI not in PATH */ }

    if (!codexOk) {
      try {
        const toml = readFileSync(join(codexDirD, 'config.toml'), 'utf8');
        if (/\[mcp_servers\.veto\]/.test(toml)) { codexOk = true; }
      } catch { /* skip */ }
    }

    if (codexOk) {
      console.log(`  ${c.green('✓')} Codex CLI — registered`);
    } else {
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      console.log(`  ${c.red('✗')} Codex CLI — not registered`);
      console.log(`  ${c.dim(`    fix: codex mcp add veto -- ${npxCmd} -y --package @jigyasudham/veto@latest veto-server`)}`);
      issues++;
    }
  } else {
    console.log(`  ${c.dim('·')} ${c.dim('Codex CLI — not installed')}`);
  }

  // Other platforms — check their config JSON files
  const platforms = [
    { name: 'Gemini CLI',      configPath: join(HOME, '.gemini', 'settings.json'),               detectionDir: join(HOME, '.gemini'),             key: 'mcpServers' },
    { name: 'Antigravity CLI', configPath: join(HOME, '.gemini', 'antigravity-cli', 'mcp_config.json'), detectionDir: join(HOME, '.gemini', 'antigravity-cli'), key: 'mcpServers' },
    { name: 'Cursor',          configPath: join(HOME, '.cursor', 'mcp.json'),                    detectionDir: join(HOME, '.cursor'),             key: 'mcpServers' },
    { name: 'Windsurf',        configPath: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), detectionDir: join(HOME, '.codeium', 'windsurf'), key: 'mcpServers' },
    {
      name: 'Zed',
      configPath: process.platform === 'win32'
        ? join(process.env.APPDATA ?? HOME, 'Zed', 'settings.json')
        : join(HOME, '.config', 'zed', 'settings.json'),
      detectionDir: process.platform === 'win32'
        ? join(process.env.APPDATA ?? HOME, 'Zed')
        : join(HOME, '.config', 'zed'),
      key: 'context_servers',
    },
  ];

  for (const p of platforms) {
    if (!existsSync(p.detectionDir)) {
      console.log(`  ${c.dim('·')} ${c.dim(`${p.name} — not installed`)}`);
      continue;
    }
    try {
      const config = JSON.parse(readFileSync(p.configPath, 'utf8'));
      if (config?.[p.key]?.veto) {
        console.log(`  ${c.green('✓')} ${p.name} — registered`);
      } else {
        console.log(`  ${c.red('✗')} ${p.name} — veto missing from config`);
        console.log(`  ${c.dim('    fix: veto init')}`);
        issues++;
      }
    } catch {
      console.log(`  ${c.red('✗')} ${p.name} — config missing or unreadable`);
      console.log(`  ${c.dim('    fix: veto init')}`);
      issues++;
    }
  }

  // Billing mode
  console.log('');
  console.log('  ' + c.bold('Billing'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  const { getConfig: getVetoConfig } = await import('./memory/config.js');
  const vetoConfig = getVetoConfig();
  const apiKeyEnvVarsDoctor = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
  const detectedKeysDoctor = apiKeyEnvVarsDoctor.filter(k => !!process.env[k]);

  if (vetoConfig.billing_mode === 'api' || detectedKeysDoctor.length > 0) {
    console.log(`  ${c.yellow('⚠')} billing_mode: ${c.yellow('api')} — MCP Sampling calls count toward your token usage`);
    console.log(`  ${c.dim('  Veto\'s "zero cost" claim applies to subscription plans only.')}`);
    console.log(`  ${c.dim('  To update: edit ~/.veto/config.json → "billing_mode": "subscription"')}`);
    issues++;
  } else {
    console.log(`  ${c.green('✓')} billing_mode: subscription — zero extra cost`);
  }

  console.log('');
  if (issues === 0) {
    console.log(c.green('  ✓ All checks passed — Veto is healthy!'));
  } else {
    console.log(c.yellow(`  ⚠  ${issues} issue${issues !== 1 ? 's' : ''} found.`) + ` Run ${c.cyan('veto init')} to repair.`);
  }
  console.log('');
}

// ─── CLI Subcommands ────────────────────────────────────────────────────────────

async function statusCommand() {
  const { getDbPath } = await import('./memory/local.js');
  const { getDb } = await import('./memory/local.js');
  const db = getDb();
  const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
  const memoryCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get() as { c: number }).c;
  const patternCount = (db.prepare('SELECT COUNT(*) as c FROM patterns').get() as { c: number }).c;
  const outcomeCount = (db.prepare('SELECT COUNT(*) as c FROM learning_data').get() as { c: number }).c;

  console.log('');
  console.log(c.bold('  Veto Status'));
  console.log(c.dim('  ─────────────────────────────'));
  console.log(`  Version     ${c.cyan(VERSION)}`);
  console.log(`  DB          ${c.dim(getDbPath())}`);
  console.log(`  Sessions    ${c.cyan(String(sessionCount))}`);
  console.log(`  Memory      ${c.cyan(String(memoryCount))} knowledge entries`);
  console.log(`  Patterns    ${c.cyan(String(patternCount))}`);
  console.log(`  Outcomes    ${c.cyan(String(outcomeCount))} recorded`);
  console.log('');
}

async function sessionsCommand() {
  const { listSessions, getDb } = await import('./memory/local.js');

  const flag = process.argv[3];

  if (flag === '--clean') {
    const db = getDb();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(
      "DELETE FROM sessions WHERE save_type = 'auto' AND created_at < ?"
    ).run(cutoff) as { changes: number };
    console.log('');
    console.log(c.green(`  ✓ Removed ${result.changes} auto-save${result.changes !== 1 ? 's' : ''} older than 7 days.`));
    console.log('');
    return;
  }

  const sessions = listSessions(20);

  console.log('');
  console.log(c.bold('  Saved Sessions') + c.dim(` (${sessions.length})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (sessions.length === 0) {
    console.log(c.dim('  No sessions saved yet. Use veto_session_save inside an AI session.'));
  } else {
    for (const s of sessions) {
      const date = new Date(s.started_at).toLocaleString();
      const badge = s.save_type === 'auto' ? c.dim(' [auto]') : '';
      console.log(`  ${c.cyan(s.id.slice(0, 8))}  ${c.dim(date)}  ${c.bold(s.platform ?? 'claude')}${badge}  ${s.summary?.slice(0, 60) ?? ''}`);
    }
  }
  console.log('');
  console.log(c.dim(`  Tip: veto sessions --clean  removes auto-saves older than 7 days`));
  console.log('');
}

async function memoryCommand() {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  // veto memory export [--format=markdown] [--output=path]
  if (subcommand === 'export') {
    const formatArg = args.find(a => a.startsWith('--format='));
    const outputArg = args.find(a => a.startsWith('--output='));
    const format = formatArg?.split('=')[1] ?? 'json';
    const outputPath = outputArg?.split('=')[1];
    const { exportMemory, exportMemoryMarkdown } = await import('./memory/sync.js');
    if (format === 'markdown') {
      const cwd = resolve(process.cwd());
      const result = exportMemoryMarkdown(cwd, outputPath);
      if (result.success) {
        console.log(c.green('  ✓') + ` VETO_MEMORY.md written to ${result.output_path}`);
        console.log(c.dim(`  Sections: ${JSON.stringify(result.sections)}`));
      } else {
        console.error(c.red(`  ✗ Export failed: ${result.error}`));
      }
    } else {
      const result = exportMemory(outputPath);
      if (result.success) {
        console.log(c.green('  ✓') + ` Exported to ${result.export_path}`);
      } else {
        console.error(c.red(`  ✗ Export failed: ${result.error}`));
      }
    }
    return;
  }

  // veto memory import [--format=markdown] <path>
  if (subcommand === 'import') {
    const formatArg = args.find(a => a.startsWith('--format='));
    const format = formatArg?.split('=')[1] ?? 'json';
    const inputPath = args.find(a => !a.startsWith('--')) ?? '';
    const { importMemory, importMemoryMarkdown } = await import('./memory/sync.js');
    if (format === 'markdown') {
      if (!inputPath) { console.error(c.red('  ✗ Provide a file path: veto memory import --format=markdown <path>')); return; }
      const result = importMemoryMarkdown(inputPath);
      console.log(result.success ? c.green('  ✓') + ` ${result.message}` : c.red(`  ✗ ${result.message}`));
    } else {
      const result = importMemory(inputPath || undefined);
      console.log(result.success ? c.green('  ✓') + ` Import complete` : c.red(`  ✗ Import failed: ${result.error}`));
    }
    return;
  }

  // veto memory [query]
  const query = args.join(' ') || undefined;
  const { searchKnowledge } = await import('./memory/local.js');
  const results = searchKnowledge({ query, limit: 20 });

  console.log('');
  console.log(c.bold('  Knowledge Base') + (query ? c.dim(` — "${query}"`) : '') + c.dim(` (${results.length} results)`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (results.length === 0) {
    console.log(c.dim('  No entries found.'));
  } else {
    for (const r of results) {
      const tags = r.tags ? JSON.parse(r.tags).join(', ') : '';
      console.log(`  ${c.cyan(`[${r.type}]`)} ${c.bold(r.title)}`);
      if (tags) console.log(`  ${c.dim('tags: ' + tags)}`);
      console.log(`  ${c.dim(r.content.slice(0, 100).replace(/\n/g, ' ') + (r.content.length > 100 ? '...' : ''))}`);
      console.log('');
    }
  }
}

async function patternsCommand() {
  const { getPatterns } = await import('./memory/local.js');
  const prefix = process.argv[3];
  const patterns = getPatterns(prefix, 30);

  console.log('');
  console.log(c.bold('  Learned Patterns') + c.dim(` (${patterns.length})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (patterns.length === 0) {
    console.log(c.dim('  No patterns yet. Record outcomes with veto_record_outcome to build up patterns.'));
  } else {
    for (const p of patterns) {
      const conf = Math.round(p.confidence * 100);
      const confColor = conf >= 80 ? c.green : conf >= 60 ? c.yellow : c.dim;
      console.log(`  ${confColor(`${conf}%`)}  ${c.cyan(p.pattern_key)}  ${c.dim('→')}  ${p.pattern_val}  ${c.dim(`(seen ${p.seen_count}x)`)}`);
    }
  }
  console.log('');
}

async function statuslineCommand() {
  const sub = process.argv[3] ?? 'status';
  const args = process.argv.slice(4);
  const clientArg = args.find(a => a.startsWith('--client='))?.split('=')[1] ?? 'claude';
  const force = args.includes('--force') || args.includes('--yes') || args.includes('-y');
  const dryRun = args.includes('--dry-run');

  const sl = await import('./cli/statusline.js');

  // Hot path: one line to stdout, nothing else. No banner, no colors-config noise.
  if (sub === 'print') {
    // --capture <file>: verification aid — log the raw Claude Code payload next to
    // the rendered line so you can compare the actual context % against `ctx N%`.
    const capIdx = args.indexOf('--capture');
    const capturePath = capIdx !== -1 ? args[capIdx + 1] : undefined;
    await sl.printStatusline({}, capturePath);
    // Exit promptly: the line is already flushed, and we must not linger holding an
    // open stdin handle if the parent kept the pipe open on this per-render hot path.
    process.exit(0);
  }

  if (sub === 'install') {
    const r = sl.installStatusline(clientArg, { force, dryRun });
    console.log('');
    console.log((r.ok ? c.green('  ✓ ') : c.red('  ✗ ')) + r.message.replace(/\n/g, '\n  '));
    if (r.ok && r.changed) console.log(c.dim('\n  Restart your AI CLI to see the Veto line. Remove with: veto statusline uninstall'));
    console.log('');
    if (!r.ok) process.exit(1);
    return;
  }

  if (sub === 'uninstall') {
    const r = sl.uninstallStatusline(clientArg);
    console.log('');
    console.log((r.ok ? c.green('  ✓ ') : c.red('  ✗ ')) + r.message);
    console.log('');
    if (!r.ok) process.exit(1);
    return;
  }

  if (sub === 'status') {
    const info = sl.statuslineStatusInfo(clientArg);
    console.log('');
    console.log(c.bold('  Veto Statusline'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  Installed:  ${info.installed ? c.green('yes') : c.dim('no')}`);
    if (info.settingsPath) console.log(`  Settings:   ${c.dim(info.settingsPath)}`);
    console.log(`  Sample:     ${info.sample}`);
    console.log('');
    console.log(c.dim('  Install: veto statusline install [--client=claude] [--force] [--dry-run]'));
    console.log('');
    return;
  }

  console.error(c.red(`  Unknown statusline subcommand: ${sub}`));
  console.error(c.dim('  Usage: veto statusline <install|uninstall|print|status>'));
  process.exit(1);
}

async function transcriptsCommand() {
  const sub = process.argv[3] ?? 'status';
  const args = process.argv.slice(4);
  const { enableCapture, disableCapture, captureStatus, consentText } = await import('./transcripts/config.js');

  if (sub === 'enable') {
    const r = enableCapture();
    console.log('');
    console.log(c.green(c.bold('  ✓ Transcript capture enabled')));
    console.log('');
    console.log('  ' + consentText(r.dir, r.retention_days).replace(/\n/g, '\n  '));
    console.log('');
    if (r.reconsented) console.log(c.dim('  (Disclosure changed since you last enabled — consent re-recorded.)\n'));
    return;
  }

  if (sub === 'disable') {
    disableCapture();
    console.log('');
    console.log(c.yellow('  ✓ Transcript capture disabled.') + c.dim(' Existing archives are kept — remove them with: veto transcripts purge'));
    console.log('');
    return;
  }

  if (sub === 'status') {
    const s = captureStatus();
    const { transcriptsDiskUsage, fmtBytes } = await import('./transcripts/manage.js');
    let disk; try { disk = transcriptsDiskUsage(); } catch { disk = null; }
    console.log('');
    console.log(c.bold('  Veto Transcript Capture'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    const state = s.effective ? c.green('enabled') : s.needsReconsent ? c.yellow('needs re-consent — run: veto transcripts enable') : c.dim('disabled');
    console.log(`  Capture:     ${state}`);
    console.log(`  Archive dir: ${c.dim(s.dir)}${s.usingDefaultDir ? c.dim('  (default)') : ''}`);
    console.log(`  Retention:   ${s.retention_days} days`);
    if (disk) console.log(`  Disk usage:  ${fmtBytes(disk.totalBytes)} ${c.dim(`(${disk.archives} session(s); ${fmtBytes(disk.archiveBytes)} archives + ${fmtBytes(disk.dbBytes)} index)`)}`);
    if (s.consent_at) console.log(`  Consent:     ${c.dim(`v${s.consent_version} · accepted ${s.consent_at}`)}`);
    if (s.cloudSyncWarning) console.log(c.yellow(`  ⚠ Archive dir looks cloud-synced (${s.cloudSyncWarning}) — consider a local path.`));
    console.log('');
    console.log(c.dim('  enable · disable · list · sources · show <id> · purge <id>|--project <dir>|--all'));
    console.log('');
    return;
  }

  // Codex and Gemini publish no session mapping of their own, so what capture
  // can see for them is whatever discovery finds on disk. Showing that is the
  // difference between "capture is on" and "capture will actually work here".
  if (sub === 'sources') {
    const { discoverCodexSessions, discoverGeminiSessions, codexSessionsDir, geminiTmpDir } =
      await import('./transcripts/discover.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const { normalizeProjectDir } = await import('./memory/local.js');
    const want = projFlag ? normalizeProjectDir(projFlag) : null;
    console.log('');
    console.log(c.bold('  Transcript sources'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  ${c.cyan('claude')}  ${c.dim('mapped live by the statusline')} ${c.dim('(veto statusline install)')}`);
    for (const [name, find, dir] of [
      ['codex', discoverCodexSessions, codexSessionsDir()],
      ['gemini', discoverGeminiSessions, geminiTmpDir()],
    ] as const) {
      let rows: { sourceSessionId: string; projectDir: string | null; mtimeMs: number }[] = [];
      try { rows = find(); } catch { rows = []; }
      const shown = want ? rows.filter(r => r.projectDir && normalizeProjectDir(r.projectDir) === want) : rows;
      console.log(`  ${c.cyan(name)}  ${c.dim(dir)}`);
      if (shown.length === 0) console.log(c.dim(`     (no sessions discovered${want ? ' for this project' : ''})`));
      for (const r of shown.slice(0, 5)) {
        console.log(`     ${r.sourceSessionId.slice(0, 8)}…  ${c.dim(new Date(r.mtimeMs).toISOString())}  ${r.projectDir ?? c.dim('(unknown project)')}`);
      }
      if (shown.length > 5) console.log(c.dim(`     … and ${shown.length - 5} more`));
    }
    console.log('');
    console.log(c.dim('  Discovered sessions are archived at save time when you pass platform=<source>.'));
    console.log('');
    return;
  }

  if (sub === 'list') {
    const { listArchives, fmtBytes } = await import('./transcripts/manage.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const rows = listArchives({ projectDir: projFlag });
    console.log('');
    console.log(c.bold(`  Archived transcripts${projFlag ? ` (project ${projFlag})` : ''}`));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    if (rows.length === 0) console.log(c.dim('  (none captured yet)'));
    for (const r of rows) {
      console.log(`  ${c.cyan(r.sourceSessionId)}  ${c.dim(r.source)}  ${r.events} ev  ${fmtBytes(r.archiveBytes)}  ${c.dim(r.updatedAt)}${r.indexed ? '' : c.yellow(' (unindexed)')}`);
      if (r.projectDir) console.log(`     ${c.dim(r.projectDir)}`);
    }
    console.log('');
    return;
  }

  if (sub === 'show') {
    const id = args[0];
    if (!id) { console.error(c.red('  Usage: veto transcripts show <source_session_id>')); process.exit(1); }
    const { showArchive, fmtBytes } = await import('./transcripts/manage.js');
    const { renderTOC } = await import('./transcripts/toc.js');
    const { renderFacts } = await import('./transcripts/pyramid.js');
    const d = showArchive(id);
    if (!d) { console.error(c.red(`  No archive for session ${id}`)); process.exit(1); }
    console.log('');
    console.log(c.bold(`  Transcript ${id}`));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  ${d.summary.events} events · ${fmtBytes(d.summary.archiveBytes)} · captured ${d.summary.capturedAt}`);
    console.log('');
    console.log(c.bold('  Facts')); console.log('  ' + renderFacts(d.facts).replace(/\n/g, '\n  '));
    console.log('');
    console.log(c.bold(`  Table of contents (${d.toc.length} phases)`));
    console.log('  ' + renderTOC(d.toc).replace(/\n/g, '\n  '));
    console.log('');
    return;
  }

  if (sub === 'purge') {
    const { purgeSession, purgeProject, purgeAll } = await import('./transcripts/manage.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const all = args.includes('--all');
    const id = args.find(a => !a.startsWith('--'));
    let r;
    if (all) r = purgeAll();
    else if (projFlag) r = purgeProject(projFlag);
    else if (id) r = purgeSession(id);
    else { console.error(c.red('  Usage: veto transcripts purge <source_session_id> | --project=<dir> | --all')); process.exit(1); }
    console.log('');
    console.log(c.green(`  ✓ Purged ${r.archives} archive(s): ${r.events} events, ${r.indexRows} index rows, ${r.files} file(s), ${r.mappings} mapping(s) removed.`));
    console.log('');
    return;
  }

  console.error(c.red(`  Unknown transcripts subcommand: ${sub}`));
  console.error(c.dim('  Usage: veto transcripts <enable|disable|status|list|show|purge>'));
  process.exit(1);
}

function shortHelpCommand() {
  console.log('');
  console.log(c.bold(c.cyan('  veto')) + c.dim(` v${VERSION}`) + c.dim(` — 93 agentic tools. 49 specialists. Every major AI CLI. Zero extra cost on subscriptions.`));
  console.log('');
  console.log(c.bold('  CLI Commands'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('veto init')}                    Configure all AI tools + scan project`);
  console.log(`  ${c.cyan('veto doctor')}                  Check MCP registrations + system health`);
  console.log(`  ${c.cyan('veto status')}                  Version, DB path, memory/session counts`);
  console.log(`  ${c.cyan('veto sessions')}                List last 20 saved sessions`);
  console.log(`  ${c.cyan('veto tools')} ${c.dim('[filter]')}         List all MCP tools (--json supported)`);
  console.log(`  ${c.cyan('veto agents')} ${c.dim('[filter]')}        List all worker + council agents (--json)`);
  console.log(`  ${c.cyan('veto memory')} ${c.dim('[query]')}         Search knowledge base`);
  console.log(`  ${c.cyan('veto patterns')} ${c.dim('[prefix]')}      List learned agent/routing patterns`);
  console.log(`  ${c.cyan('veto routing')} ${c.dim('[status|enable|disable|reset|log]')}`);
  console.log(`                         Routing feedback loop (opt-in signal storage)`);
  console.log(`  ${c.cyan('veto statusline')} ${c.dim('[install|uninstall|print|status]')}`);
  console.log(`                         Compact Veto line under your AI CLI prompt`);
  console.log(`  ${c.cyan('veto transcripts')} ${c.dim('[enable|disable|status]')}`);
  console.log(`                         Opt-in local session-transcript capture (off by default)`);
  console.log(`  ${c.cyan('veto version')}                 Show version (alias for status)`);
  console.log(`  ${c.cyan('veto hook install')}            Install pre-commit secrets scan hook`);
  console.log(`  ${c.cyan('veto hook remove')}             Remove the veto pre-commit hook`);
  console.log(`  ${c.cyan('veto check')}                   Scan staged changes for secrets (used by hook)`);
  console.log(`  ${c.cyan('veto help')}                    Show this help`);
  console.log(`  ${c.cyan('veto help --troubleshoot')}     Show troubleshooting guide`);
  console.log('');
  console.log(c.bold('  MCP Tools (93 Agentic Tools)'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('Session')}       veto_status · veto_session_save · veto_session_restore · veto_sessions_list · veto_session_replay · veto_autosave_status · veto_snapshot`);
  console.log(`  ${c.dim('Council')}       veto_council_debate · veto_benchmark · veto_adr`);
  console.log(`  ${c.dim('Intelligence')}  veto_agent_plan · veto_execute_parallel · veto_explain · veto_delegate · veto_compose_agents`);
  console.log(`  ${c.dim('Scanning')}      veto_code_review · veto_security_scan · veto_secrets_scan · veto_diff_review · veto_full_review · veto_pr_review`);
  console.log(`  ${c.dim('Pipelines')}     veto_workflow · veto_task_parse · veto_new_feature · veto_pre_commit · veto_ci_gate`);
  console.log(`  ${c.dim('Watching')}      veto_watch · veto_watch_poll · veto_watch_stop`);
  console.log(`  ${c.dim('Advanced')}      veto_local_llm · veto_semantic_search · veto_sdd_agent · veto_playwright · veto_notify_ide · veto_translate · veto_a11y_advisor`);
  console.log(`  ${c.dim('Quality')}       veto_type_coverage · veto_test_gaps · veto_clone_detector · veto_lint_rules · veto_api_contract`);
  console.log(`  ${c.dim('Discovery')}     veto_discover · veto_summarize · veto_git_blame · veto_changelog · veto_onboard · veto_debt_register`);
  console.log(`  ${c.dim('DevTools')}      veto_docs_fetch · veto_context_status · veto_openapi_gen · veto_flag_auditor · veto_env_setup · veto_diagram · veto_rca`);
  console.log(`                veto_commit_message · veto_pr_description · veto_pr_post · veto_prompt_optimizer · veto_sre_advisor · veto_merge_conflict`);
  console.log(`  ${c.dim('System')}        veto_route_task · veto_rate_status · veto_audit_log · veto_health · veto_metrics · veto_learning_stats · veto_learning_apply · veto_handoff · veto_continue · veto_platform_setup · veto_plugins`);
  console.log('');
  console.log(c.bold('  MCP Resources'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('veto://sessions')}              All saved sessions`);
  console.log(`  ${c.cyan('veto://project-map?dir=<path>')} Project structure map`);
  console.log(`  ${c.cyan('veto://memory?q=<query>')}      Knowledge base search`);
  console.log(`  ${c.cyan('veto://patterns')}              Learned patterns`);
  console.log('');
  console.log(c.bold('  MCP Prompts'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('code-review')} · ${c.cyan('security-audit')} · ${c.cyan('deploy-checklist')} · ${c.cyan('explain-file')}`);
  console.log(`  ${c.cyan('full-review')} · ${c.cyan('new-feature')} · ${c.cyan('debug-incident')} · ${c.cyan('onboard')}`);
  console.log('');
  console.log(c.bold('  Docs & Support'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('GitHub:')}  https://github.com/jigyasudham/veto`);
  console.log(`  ${c.dim('Issues:')} https://github.com/jigyasudham/veto/issues`);
  console.log(`  ${c.dim('npm:')}     https://www.npmjs.com/package/@jigyasudham/veto`);
  console.log('');
}

function troubleshootCommand() {
  console.log('');
  console.log(c.bold('  Troubleshooting'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.yellow('Veto not available in a new VS Code window / project')}`);
  console.log(`  ${c.dim('→')} Claude Code: MCP must be registered at user scope, not project scope`);
  console.log(`  ${c.dim('→')} Run: ${c.cyan('claude mcp add veto -s user -- npx -y --package @jigyasudham/veto@latest veto-server')}`);
  console.log(`  ${c.dim('→')} The ${c.cyan('-s user')} flag makes Veto global across ALL windows and projects`);
  console.log(`  ${c.dim('→')} Gemini / Cursor / Windsurf / Zed: run ${c.cyan('veto init')} once — config is written globally`);
  console.log('');
  console.log(`  ${c.yellow('MCP disconnected / tools not loading')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} again, then fully restart your AI client (Claude / Gemini / Cursor / Windsurf / Zed)`);
  console.log(`  ${c.dim('→')} Verify the MCP entry in your AI client config file`);
  console.log(`  ${c.dim('→')} Check Node.js version: ${c.cyan('node --version')}  (need >= 22)`);
  console.log('');
  console.log(`  ${c.yellow('veto command not found')}`);
  console.log(`  ${c.dim('→')} The bare ${c.cyan('veto')} command comes from a global install: ${c.cyan('npm i -g @jigyasudham/veto')}`);
  console.log(`  ${c.dim('→')} Safe to install: MCP configs pin ${c.cyan('@latest')}, so a global copy cannot shadow the server`);
  console.log(`  ${c.dim('→')} No-install alternative: ${c.cyan('npx -y @jigyasudham/veto@latest <command>')}`);
  console.log(`  ${c.dim('→')} From source:    ${c.cyan('npm run build && npm link')}`);
  console.log('');
  console.log(`  ${c.yellow('Tools missing in Claude / Gemini after install')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} to write / regenerate the MCP config`);
  console.log(`  ${c.dim('→')} Fully quit and reopen the AI client (not just reload)`);
  console.log(`  ${c.dim('→')} Claude Desktop config: ${c.dim('~/.config/claude/claude_desktop_config.json')}`);
  console.log(`  ${c.dim('→')} Gemini / other: check the platform docs for MCP config location`);
  console.log('');
  console.log(`  ${c.yellow('Old version still showing after update')}`);
  console.log(`  ${c.dim('→')} The MCP config is pinned to ${c.cyan('@latest')} — fully restart the AI client to fetch it`);
  console.log(`  ${c.dim('→')} If the config predates 2.7.1 (no ${c.cyan('@latest')} pin), re-run ${c.cyan('veto init')} to rewrite it`);
  console.log(`  ${c.dim('→')} The global CLI updates separately: ${c.cyan('npm i -g @jigyasudham/veto@latest')}`);
  console.log(`  ${c.dim('→')} Confirm: ${c.cyan('veto doctor')} (compares both against the registry's latest)`);
  console.log('');
  console.log(`  ${c.yellow('Database / SQLite errors on startup')}`);
  console.log(`  ${c.dim('→')} Requires Node.js >= 22 (uses built-in node:sqlite)`);
  console.log(`  ${c.dim('→')} Check ${c.dim('~/.veto')} directory exists and is writable`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} to see the active DB path`);
  console.log('');
  console.log(`  ${c.yellow('Memory or sessions not persisting between chats')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} — verify DB path and memory count`);
  console.log(`  ${c.dim('→')} Ensure ${c.dim('~/.veto')} is not on a read-only or temp volume`);
  console.log('');
  console.log(`  ${c.yellow('Permission denied on Windows (PowerShell)')}`);
  console.log(`  ${c.dim('→')} ${c.cyan('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned')}`);
  console.log(`  ${c.dim('→')} Or run terminal as Administrator and retry`);
  console.log('');
  console.log(`  ${c.yellow('Rate limit / too many requests errors')}`);
  console.log(`  ${c.dim('→')} Use ${c.cyan('veto_rate_status')} tool to check current usage`);
  console.log(`  ${c.dim('→')} Wait a moment, then retry — limits reset per minute`);
  console.log('');
  console.log(`  ${c.yellow('veto init fails on first run')}`);
  console.log(`  ${c.dim('→')} Veto does not require an API key — it uses your existing AI subscriptions via MCP`);
  console.log(`  ${c.dim('→')} Ensure Node.js >= 22 and run ${c.cyan('veto init')} from your project directory`);
  console.log(`  ${c.dim('→')} Check that your AI client (Claude Code / Gemini / Codex / Antigravity) is installed`);
  console.log('');
  console.log(`  ${c.yellow('veto_health shows degraded / components failing')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} for a summary of all components`);
  console.log(`  ${c.dim('→')} Check ${c.cyan('veto_audit_log')} for recent error events`);
  console.log(`  ${c.dim('→')} Re-run ${c.cyan('veto init')} to repair config and rescan project`);
  console.log('');
  console.log(`  ${c.yellow('Installed via npx but MCP disconnects after restart')}`);
  console.log(`  ${c.dim('→')} npx runs temporarily — it does NOT add veto-server to PATH permanently`);
  console.log(`  ${c.dim('→')} Fix: run ${c.cyan('npx veto init')} again so the config is rewritten with the correct npx command`);
  console.log(`  ${c.dim('→')} The rewritten config pins ${c.cyan('@latest')}, so each restart fetches the newest version — no global install needed`);
  console.log('');
  console.log(`  ${c.yellow('Installed on a new machine but MCP not working')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('npx @jigyasudham/veto init')} on the new machine — config is not transferred`);
  console.log(`  ${c.dim('→')} Each machine needs its own init run to register the MCP server`);
  console.log(`  ${c.dim('→')} Then restart the AI client on that machine`);
  console.log('');
}

// ─── Routing Command ────────────────────────────────────────────────────────────

async function routingCommand() {
  const { getRoutingFeedbackStats, resetRoutingFeedback, listRoutingFeedback, isFeedbackEnabled, setFeedbackEnabled } = await import('./router/learning-updater.js');
  const sub = process.argv[3];

  if (sub === 'enable') {
    setFeedbackEnabled(true);
    console.log('');
    console.log(c.green('  ✓ Routing feedback enabled.'));
    console.log(c.dim('  Every veto_route_task call now records a routing signal (30-day TTL).'));
    console.log(c.dim('  Disable with: veto routing disable  |  Clear with: veto routing reset'));
    console.log('');
    return;
  }

  if (sub === 'disable') {
    setFeedbackEnabled(false);
    console.log('');
    console.log(c.yellow('  ✓ Routing feedback disabled.'));
    console.log(c.dim('  No new signals will be recorded. Existing data is retained.'));
    console.log(c.dim('  Re-enable with: veto routing enable'));
    console.log('');
    return;
  }

  if (sub === 'reset') {
    const result = resetRoutingFeedback();
    console.log('');
    console.log(c.green('  ✓ Routing feedback reset.'));
    console.log(`  ${c.dim('Deleted:')} ${c.cyan(String(result.deleted_feedback))} feedback signal${result.deleted_feedback !== 1 ? 's' : ''}`);
    if (result.reset_thresholds) {
      console.log(`  ${c.dim('Thresholds:')} reset to defaults (30/70)`);
    }
    console.log('');
    return;
  }

  if (sub === 'log') {
    const limit = parseInt(process.argv[4] ?? '20', 10);
    const entries = listRoutingFeedback(isNaN(limit) ? 20 : limit);
    console.log('');
    console.log(c.bold('  Routing Feedback Log') + c.dim(` (${entries.length})`));
    console.log(c.dim('  ─────────────────────────────────────────────────────────────'));
    if (entries.length === 0) {
      console.log(c.dim('  No feedback signals yet. Enable feedback: veto routing enable'));
    } else {
      for (const e of entries) {
        const outcomeColor = e.outcome === 'accepted' ? c.green : e.outcome === 'overridden' ? c.yellow : c.dim;
        const exp = new Date(e.expires_at).toLocaleDateString();
        console.log(`  ${c.dim(e.recorded_at.slice(0, 10))}  T${e.model_tier}  ${outcomeColor(e.outcome.padEnd(10))}  ${c.dim(`q:${e.quality ?? '-'}`)}  ${e.task_snippet.slice(0, 55)}`);
        console.log(`  ${c.dim(`  expires: ${exp}  agent: ${e.agent ?? 'dynamic'}`)}`);
        console.log('');
      }
    }
    return;
  }

  // Default: status
  const stats = getRoutingFeedbackStats();
  const enabled = isFeedbackEnabled();
  const statusStr = enabled ? c.green('enabled') : c.dim('disabled');

  console.log('');
  console.log(c.bold('  Routing Feedback') + c.dim(' — loop status'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  Status      ${statusStr}`);
  console.log(`  TTL         ${c.cyan(String(stats.ttl_days))} days`);
  console.log(`  Signals     ${c.cyan(String(stats.active))} active · ${c.dim(String(stats.expired))} expired · ${String(stats.total)} total`);
  if (Object.keys(stats.by_outcome).length > 0) {
    const parts = Object.entries(stats.by_outcome).map(([k, v]) => `${k}: ${v}`).join(' · ');
    console.log(`  Outcomes    ${c.dim(parts)}`);
  }
  if (Object.keys(stats.by_tier).length > 0) {
    const parts = Object.entries(stats.by_tier).map(([tier, s]) => `T${tier}: ${s.count} (q${s.avg_quality ?? '-'})`).join(' · ');
    console.log(`  By tier     ${c.dim(parts)}`);
  }
  if (stats.next_expiry) {
    console.log(`  Next expiry ${c.dim(new Date(stats.next_expiry).toLocaleDateString())}`);
  }
  console.log('');
  console.log(c.dim(`  Commands: veto routing enable · veto routing disable · veto routing reset · veto routing log`));
  console.log('');
}

// ─── Hook installer ────────────────────────────────────────────────────────────

async function hookCommand() {
  const sub = process.argv[3];
  if (sub !== 'install' && sub !== 'remove') {
    console.error(c.red(`  Usage: veto hook install  |  veto hook remove`));
    process.exit(1);
  }

  // Walk up to find .git directory
  let gitDir: string | null = null;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.git'))) { gitDir = join(dir, '.git'); break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!gitDir) {
    console.error(c.red('  Not a git repository (or any parent up to 10 levels).'));
    process.exit(1);
  }

  const hookPath = join(gitDir, 'hooks', 'pre-commit');

  if (sub === 'remove') {
    if (!existsSync(hookPath)) {
      console.log(c.dim('  No pre-commit hook found.'));
      return;
    }
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes('veto check')) {
      console.log(c.yellow('  ⚠ Hook exists but was not created by veto. Not removed.'));
      console.log(c.dim(`    Path: ${hookPath}`));
      return;
    }
    unlinkSync(hookPath);
    console.log(c.green('  ✓ Veto pre-commit hook removed.'));
    return;
  }

  // install
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes('veto check')) {
      console.log(c.yellow('  ⚠ A pre-commit hook already exists and was not created by veto.'));
      console.log(c.dim(`    Inspect it before overwriting: ${hookPath}`));
      process.exit(1);
    }
    console.log(c.green('  ✓ Veto pre-commit hook already installed.'));
    return;
  }

  const script = [
    '#!/bin/sh',
    '# Veto pre-commit hook — secrets scan on staged changes',
    '# Generated by: veto hook install  |  Remove with: veto hook remove',
    'if command -v veto >/dev/null 2>&1; then',
    '  exec veto check',
    'else',
    '  exec npx -y @jigyasudham/veto check',
    'fi',
  ].join('\n') + '\n';

  writeFileSync(hookPath, script, { mode: 0o755 });
  console.log('');
  console.log(c.green('  ✓') + ` Pre-commit hook installed at ${c.dim(hookPath)}`);
  console.log(c.dim('  Scans staged changes for secrets before every commit.'));
  console.log(c.dim('  Remove with: veto hook remove'));
  console.log('');
}

// ─── Secrets check (for pre-commit hook) ───────────────────────────────────────

async function checkCommand() {
  const { scan } = await import('./agents/security/secrets.js');

  let diff = '';
  try {
    diff = execSync('git diff --cached', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { /* not a git repo or git not available */ }

  if (!diff.trim()) {
    console.log(c.green('  ✓ Veto: no staged changes to scan.'));
    process.exit(0);
  }

  // Only scan added lines; skip diff headers
  const added = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');

  const findings = scan(added);
  const blocking = findings.filter(f => f.severity === 'critical' || f.severity === 'high');

  if (findings.length === 0) {
    console.log(c.green('  ✓ Veto secrets scan: clean'));
    process.exit(0);
  }

  console.log('');
  console.log(c.bold('  Veto Secrets Scan'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  for (const f of findings) {
    const sev = f.severity === 'critical' ? c.red(f.severity)
              : f.severity === 'high'     ? c.yellow(f.severity)
              : c.dim(f.severity);
    console.log(`  ${sev}  ${c.bold(f.type)}  ${c.dim(`line ${f.line}`)}  ${c.dim(f.value)}`);
    console.log(`         ${c.dim(f.fix)}`);
    console.log('');
  }

  if (blocking.length > 0) {
    console.log(c.red(`  ✗ Blocked: ${blocking.length} critical/high secret${blocking.length !== 1 ? 's' : ''} in staged changes.`));
    console.log(c.dim('  Fix the issues above, re-stage, and commit again.'));
    console.log('');
    process.exit(1);
  }

  console.log(c.yellow(`  ⚠ ${findings.length} medium/low finding${findings.length !== 1 ? 's' : ''} — commit allowed. Review above.`));
  console.log('');
  process.exit(0);
}

// ─── Tools / Agents listings ────────────────────────────────────────────────────

// The 7 Council personas debated by veto_council_debate. They live as separate
// modules under src/council/ (no shared manifest), so the roster is mirrored here
// for the listing. Keep in sync with src/council/decision-engine.ts.
const COUNCIL_AGENTS = [
  { id: 'Lead Developer',     role: 'Implementation feasibility and code-level risk (can block).' },
  { id: 'Product Manager',    role: 'User value, scope, and priority trade-offs.' },
  { id: 'System Architect',   role: 'Architecture fit, scalability, and long-term design (can block).' },
  { id: 'UX Designer',        role: 'Usability, accessibility, and user-facing impact.' },
  { id: "Devil's Advocate",   role: 'Probes every failure mode — always raises concerns.' },
  { id: 'Legal & Compliance', role: 'Licensing, privacy, and regulatory exposure (can block).' },
  { id: 'Security',           role: 'Threat model and vulnerability surface (can block).' },
];

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// veto tools [filter] [--json] — lists the MCP tools straight from TOOL_DEFINITIONS
// (the same source the server registers) so the listing can never drift.
async function toolsCommand() {
  const { TOOL_DEFINITIONS } = await import('./tools/definitions.js');
  const asJson = process.argv.includes('--json');
  const filter = process.argv.slice(3).find(a => !a.startsWith('--'))?.toLowerCase();

  let tools = TOOL_DEFINITIONS.map(t => ({ name: t.name, description: t.description }));
  if (filter) tools = tools.filter(t => t.name.toLowerCase().includes(filter) || t.description.toLowerCase().includes(filter));

  if (asJson) {
    console.log(JSON.stringify({ count: tools.length, tools }, null, 2));
    return;
  }

  console.log('');
  console.log(c.bold('  Veto MCP Tools') + c.dim(` (${tools.length}${filter ? ` matching "${filter}"` : ` of ${TOOL_DEFINITIONS.length}`})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  if (tools.length === 0) {
    console.log(c.dim('  No tools match that filter.'));
  } else {
    const width = Math.max(...tools.map(t => t.name.length));
    for (const t of tools) {
      console.log(`  ${c.cyan(t.name.padEnd(width))}  ${c.dim(truncate(t.description, 64))}`);
    }
  }
  console.log('');
  console.log(c.dim('  Tip: veto tools <filter>  filters by name/description  ·  --json for machine output'));
  console.log('');
}

// veto agents [filter] [--json] — lists the 43 worker specialists from AGENT_MANIFEST
// (grouped by domain) plus the 7 Council personas.
async function agentsCommand() {
  const { AGENT_MANIFEST } = await import('./agents/manifest.js');
  const asJson = process.argv.includes('--json');
  const filter = process.argv.slice(3).find(a => !a.startsWith('--'))?.toLowerCase();

  const match = (s: string) => !filter || s.toLowerCase().includes(filter);
  const workers = AGENT_MANIFEST
    .map(a => ({ id: a.id, role: a.role, output_type: a.output_type, domain: a.domain }))
    .filter(a => match(a.id) || match(a.role) || match(a.domain));
  const council = COUNCIL_AGENTS.filter(a => match(a.id) || match(a.role));

  if (asJson) {
    console.log(JSON.stringify({
      worker_agents: { count: workers.length, agents: workers },
      council_agents: { count: council.length, agents: council },
    }, null, 2));
    return;
  }

  console.log('');
  console.log(c.bold('  Veto Agents') + c.dim(` — ${workers.length} worker specialists + ${council.length} council`));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));

  if (workers.length === 0 && council.length === 0) {
    console.log(c.dim('  No agents match that filter.'));
    console.log('');
    return;
  }

  for (const domain of [...new Set(workers.map(a => a.domain))]) {
    const inDomain = workers.filter(a => a.domain === domain);
    const width = Math.max(...inDomain.map(a => a.id.length));
    console.log('');
    console.log(`  ${c.bold(domain)} ${c.dim(`(${inDomain.length})`)}`);
    for (const a of inDomain) {
      const badge = a.output_type === 'analysis' ? c.yellow('analysis') : c.dim('plan    ');
      console.log(`    ${c.cyan(a.id.padEnd(width))}  ${badge}  ${c.dim(truncate(a.role, 58))}`);
    }
  }

  if (council.length > 0) {
    const width = Math.max(...council.map(a => a.id.length));
    console.log('');
    console.log(`  ${c.bold('council')} ${c.dim(`(${council.length})`)} ${c.dim('— 7-agent debate via veto_council_debate')}`);
    for (const a of council) {
      console.log(`    ${c.cyan(a.id.padEnd(width))}  ${c.dim(truncate(a.role, 60))}`);
    }
  }

  console.log('');
  console.log(c.dim('  Worker agents run via veto_route_task / veto_agent_plan · council via veto_council_debate'));
  console.log(c.dim('  Tip: veto agents <filter>  ·  --json for machine output'));
  console.log('');
}

// ─── Router ────────────────────────────────────────────────────────────────────

const command = process.argv[2] ?? 'init';

switch (command) {
  case 'init':
    initCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'status':
    statusCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'sessions':
    sessionsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'memory':
    memoryCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'patterns':
    patternsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'tools':
    toolsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'agents':
    agentsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'doctor':
    doctorCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'routing':
    routingCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'statusline':
    statuslineCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'transcripts':
    transcriptsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'hook':
    hookCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'check':
    checkCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'version':
  case 'v':
    statusCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  // Conventional version flags — print the concise version and exit.
  case '--version':
  case '-v':
  case '-V':
    console.log(`veto v${VERSION}`);
    break;

  case 'help':
  case '--help':
  case '-h':
    if (process.argv[3] === '--troubleshoot') {
      troubleshootCommand();
    } else {
      shortHelpCommand();
    }
    break;

  default:
    console.error(c.red(`  Unknown command: ${command}`));
    console.error(c.dim(`  Run ${c.cyan('veto help')} for usage.`));
    process.exit(1);
}
