#!/usr/bin/env node
// Veto CLI — entry point for `npx veto init`

// Suppress Node experimental warnings (node:sqlite) for clean UX
process.removeAllListeners('warning');

import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const VERSION = '0.8.0';
const VETO_DIR = join(homedir(), '.veto');

// Simple inline colors (no chalk needed for the init wizard to avoid ESM issues)
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
  console.log(c.dim(`  50 agents. 28 skills. 3 AIs. Self-learning. Zero extra cost.`));
  console.log(c.dim(`  v${VERSION}`));
  console.log('');
}

async function initCommand() {
  printBanner();

  // 1. Create ~/.veto directory
  if (!existsSync(VETO_DIR)) {
    mkdirSync(VETO_DIR, { recursive: true });
    console.log(c.green('  ✓') + ` Created ${VETO_DIR}`);
  } else {
    console.log(c.dim('  · ') + `Found existing ${VETO_DIR}`);
  }

  // 2. Initialize SQLite database (imports local.ts which auto-creates tables)
  process.stdout.write('  · Initializing SQLite database...');
  const { getDb, getDbPath, saveSession } = await import('./memory/local.js');

  try {
    const db = getDb();
    const dbPath = getDbPath();
    // Smoke test: save + retrieve a test session
    const { session_id } = saveSession({
      platform: 'claude',
      summary: 'Veto initialized',
      context: 'Initial setup via npx veto init',
    });
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id);
    if (!row) throw new Error('DB smoke test failed');
    // Clean up test row
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session_id);
    console.log(c.green(' ✓'));
    console.log(c.green('  ✓') + ` Database ready at ${dbPath}`);
  } catch (err: unknown) {
    console.log(c.red(' ✗'));
    const msg = err instanceof Error ? err.message : String(err);
    console.error(c.red(`  Error initializing database: ${msg}`));
    process.exit(1);
  }

  // 3. Print Claude Code config snippet
  // Point to server.js (the MCP server), not cli.js (the init wizard)
  const cliFile = fileURLToPath(import.meta.url);
  const distDir = dirname(cliFile);
  const serverPath = join(distDir, 'server.js').replace(/\\/g, '/');

  console.log('');
  console.log(c.bold('  ┌─ Add Veto to your AI CLI or IDE ───────────────────────────────┐'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + '  Config file locations:                                        ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + c.dim('  Claude Code  →  ~/.claude/mcp_servers.json') + '                   ' + c.bold('│'));
  console.log(c.bold('  │') + c.dim('  Gemini CLI   →  ~/.gemini/settings.json') + '                      ' + c.bold('│'));
  console.log(c.bold('  │') + c.dim('  Codex CLI    →  ~/.codex/config.json') + '                         ' + c.bold('│'));
  console.log(c.bold('  │') + c.dim('  Cursor       →  ~/.cursor/mcp.json') + '                           ' + c.bold('│'));
  console.log(c.bold('  │') + c.dim('  Windsurf     →  ~/.codeium/windsurf/mcp_config.json') + '           ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + '  Claude / Gemini / Codex / Cursor / Windsurf:                  ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('  {') + '                                                           ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('    "mcpServers": {') + '                                            ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('      "veto": {') + '                                               ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('        "command": "node",') + '                                    ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan(`        "args": ["${serverPath}"]`) + '              ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('      }') + '                                                       ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('    }') + '                                                         ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('  }') + '                                                           ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + '  VS Code → .vscode/mcp.json:                                   ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('  {') + '                                                           ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('    "servers": {') + '                                              ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('      "veto": {') + '                                               ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('        "type": "stdio",') + '                                      ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('        "command": "node",') + '                                    ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan(`        "args": ["${serverPath}"]`) + '              ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('      }') + '                                                       ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('    }') + '                                                         ' + c.bold('│'));
  console.log(c.bold('  │') + c.cyan('  }') + '                                                           ' + c.bold('│'));
  console.log(c.bold('  │') + '                                                                ' + c.bold('│'));
  console.log(c.bold('  └────────────────────────────────────────────────────────────────┘'));
  console.log('');
  console.log(c.green('  ✓ Veto is ready!'));
  console.log('');
  console.log('  Next steps:');
  console.log(c.dim('  1.') + ' Add the config above to your AI CLI or IDE config file');
  console.log(c.dim('  2.') + ' Restart the CLI or IDE');
  console.log(c.dim('  3.') + ' Run: veto_status  — should return { "status": "running", "version": "0.8.0" }');
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

  default:
    console.error(`Unknown command: ${command}`);
    console.log('Usage: veto init');
    process.exit(1);
}
