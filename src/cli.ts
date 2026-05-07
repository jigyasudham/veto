#!/usr/bin/env node
// Veto CLI — entry point for `npx veto init`

// Suppress Node experimental warnings (node:sqlite) for clean UX
process.removeAllListeners('warning');

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
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
  console.log(c.dim(`  50 agents. 44 tools. 3 AIs. Self-learning. Zero extra cost.`));
  console.log(c.dim(`  v${VERSION}`));
  console.log('');
}

// Merge veto entry into an existing JSON config file, creating it if needed.
// Supports both "mcpServers" format (Claude/Gemini/Codex/Cursor/Windsurf)
// and "servers" format (VS Code).
function writeVetoConfig(
  configPath: string,
  format: 'mcpServers' | 'servers'
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

  if (format === 'mcpServers') {
    const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
    servers['veto'] = { command: 'npx', args: ['-y', '--package', '@jigyasudham/veto', 'veto-server'] };
    existing.mcpServers = servers;
  } else {
    const servers = (existing.servers as Record<string, unknown>) ?? {};
    servers['veto'] = { type: 'stdio', command: 'npx', args: ['-y', '--package', '@jigyasudham/veto', 'veto-server'] };
    existing.servers = servers;
  }

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return wasEmpty ? 'created' : 'updated';
}

// All platforms Veto supports, with their config paths and formats.
// Claude Code is NOT in this list — it's handled separately via `claude mcp add -s user`
// because Claude Code does NOT read mcp_servers.json; it uses its own internal MCP registry.
const PLATFORMS = [
  {
    name: 'Gemini CLI',
    path: join(HOME, '.gemini', 'settings.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.gemini'),
  },
  {
    name: 'Codex CLI',
    path: join(HOME, '.codex', 'config.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.codex'),
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

  // 3. Auto-scan current project and store project map
  const cwd = resolve(process.cwd());
  const { getDb: _getDb, updateProjectMap } = await import('./memory/local.js');
  try {
    process.stdout.write('  · Scanning project directory...');
    const { structure, key_modules, tech_stack } = scanProjectDir(cwd);
    updateProjectMap({ project_dir: cwd, structure: JSON.stringify(structure), key_modules, tech_stack });
    const stackStr = tech_stack.length ? ` (${tech_stack.slice(0, 4).join(', ')})` : '';
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
    const mcpCmd = 'claude mcp add veto -s user -- npx -y --package @jigyasudham/veto veto-server';
    try {
      execSync(mcpCmd, { stdio: 'pipe', timeout: 15000 });
      console.log(c.green('  ✓ ') + 'Claude Code — registered (user scope: all windows & projects)');
      configured++;
    } catch (err: unknown) {
      const stderr = (err instanceof Error && 'stderr' in err) ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr) : '';
      // "already exists" means it was previously registered — treat as success
      if (/already|exists/i.test(stderr)) {
        console.log(c.green('  ✓ ') + 'Claude Code — already registered (user scope)');
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

  if (configured === 0 && skipped === 0) {
    console.log(c.yellow('  ⚠  No AI tools detected.'));
    console.log('  Install Claude Code, Gemini CLI, or Codex CLI and run veto init again.');
    console.log('');
  } else {
    console.log('');
    console.log(c.green(`  ✓ Veto configured for ${configured} tool${configured !== 1 ? 's' : ''}!`));
    console.log('');
    console.log('  Next steps:');
    console.log(c.dim('  1.') + ' Fully restart each configured AI client (not just reload)');
    console.log(c.dim('  2.') + ' For Claude Code: config is user-scoped — every window picks it up automatically');
    console.log(c.dim('  3.') + ' For Gemini / Cursor / Windsurf: config is written globally to your home dir');
    console.log(c.dim('  4.') + ' Verify: call veto_status in your AI client — should return { "status": "running" }');
    console.log('');
    console.log(c.dim('  Tip: run `veto init` again anytime to install newly-added AI tools.'));
    console.log('');
  }
}

// ─── Project Map Scanner ────────────────────────────────────────────────────────

function scanProjectDir(dir: string): { structure: object; key_modules: string[]; tech_stack: string[] } {
  const structure: Record<string, unknown> = {};
  const key_modules: string[] = [];
  const tech_stack: string[] = [];

  // Read package.json for stack detection
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      structure['name'] = pkg.name;
      structure['version'] = pkg.version;
      const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      structure['dep_count'] = allDeps.length;

      const stackMap: Array<[string[], string]> = [
        [['next'], 'Next.js'], [['react'], 'React'], [['vue'], 'Vue'],
        [['express'], 'Express'], [['fastify'], 'Fastify'], [['hono'], 'Hono'],
        [['prisma'], 'Prisma'], [['drizzle-orm'], 'Drizzle'], [['typeorm'], 'TypeORM'],
        [['@modelcontextprotocol/sdk'], 'MCP'], [['typescript'], 'TypeScript'],
        [['jest'], 'Jest'], [['vitest'], 'Vitest'], [['tailwindcss'], 'Tailwind'],
        [['zod'], 'Zod'], [['graphql'], 'GraphQL'],
      ];
      for (const [keywords, label] of stackMap) {
        if (keywords.some(k => allDeps.some(d => d.toLowerCase().includes(k)))) {
          tech_stack.push(label);
        }
      }
    } catch { /* malformed */ }
  }

  // Detect key config files
  const CONFIG_FILES = ['tsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.ts',
    'next.config.js', 'tailwind.config.ts', 'drizzle.config.ts', 'prisma/schema.prisma',
    'docker-compose.yml', '.env.example'];
  const foundConfigs = CONFIG_FILES.filter(f => existsSync(join(dir, f)));
  if (foundConfigs.length) structure['config_files'] = foundConfigs;

  // Scan src/ directory
  const srcDir = join(dir, 'src');
  if (existsSync(srcDir)) {
    let tsCount = 0;
    let testCount = 0;
    const topDirs: string[] = [];
    for (const entry of readdirSync(srcDir)) {
      const full = join(srcDir, entry);
      try {
        if (statSync(full).isDirectory()) {
          topDirs.push(entry);
          key_modules.push(`src/${entry}`);
        } else {
          const ext = extname(entry);
          if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) tsCount++;
          if (entry.includes('.test.') || entry.includes('.spec.')) testCount++;
        }
      } catch { /* skip */ }
    }
    structure['src_dirs'] = topDirs;
    structure['ts_files_in_src'] = tsCount;
    if (testCount > 0) structure['test_files'] = testCount;
  }

  // Entry points
  const entryPoints = ['src/index.ts', 'src/main.ts', 'src/app.ts', 'src/server.ts', 'src/cli.ts', 'index.ts'];
  const found = entryPoints.filter(f => existsSync(join(dir, f)));
  if (found.length) structure['entry_points'] = found;

  return { structure, key_modules, tech_stack };
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
  const { listSessions } = await import('./memory/local.js');
  const sessions = listSessions(20);

  console.log('');
  console.log(c.bold('  Saved Sessions') + c.dim(` (${sessions.length})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (sessions.length === 0) {
    console.log(c.dim('  No sessions saved yet. Use veto_session_save inside an AI session.'));
  } else {
    for (const s of sessions) {
      const date = new Date(s.started_at).toLocaleString();
      console.log(`  ${c.cyan(s.id.slice(0, 8))}  ${c.dim(date)}  ${c.bold(s.platform ?? 'claude')}  ${s.summary?.slice(0, 60) ?? ''}`);
    }
  }
  console.log('');
}

async function memoryCommand() {
  const args = process.argv.slice(3);
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

function helpCommand() {
  console.log('');
  console.log(c.bold(c.cyan('  veto')) + c.dim(` v${VERSION}`) + c.dim(' — 50 agents. 44 tools. 3 AIs. Self-learning. Zero extra cost.'));
  console.log('');
  console.log(c.bold('  CLI Commands'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('veto init')}                    Configure all AI tools + scan project`);
  console.log(`  ${c.cyan('veto status')}                  Version, DB path, memory/session counts`);
  console.log(`  ${c.cyan('veto sessions')}                List last 20 saved sessions`);
  console.log(`  ${c.cyan('veto memory')} ${c.dim('[query]')}         Search knowledge base`);
  console.log(`  ${c.cyan('veto patterns')} ${c.dim('[prefix]')}      List learned agent/routing patterns`);
  console.log(`  ${c.cyan('veto help')}                    Show this help`);
  console.log('');
  console.log(c.bold('  MCP Tools (44)'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('Session')}       veto_status · veto_session_save · veto_session_restore · veto_sessions_list`);
  console.log(`  ${c.dim('Router')}        veto_route_task · veto_rate_status`);
  console.log(`  ${c.dim('Council')}       veto_council_debate`);
  console.log(`  ${c.dim('Agents')}        veto_agent_plan · veto_execute_parallel · veto_explain`);
  console.log(`  ${c.dim('Review')}        veto_code_review · veto_security_scan · veto_secrets_scan · veto_diff_review`);
  console.log(`  ${c.dim('Pipeline')}      veto_workflow`);
  console.log(`  ${c.dim('Watch')}         veto_watch · veto_watch_poll · veto_watch_stop`);
  console.log(`  ${c.dim('Memory')}        veto_memory_store · veto_memory_search · veto_memory_delete`);
  console.log(`                veto_project_map_update · veto_project_map_get`);
  console.log(`                veto_pattern_store · veto_patterns_list`);
  console.log(`                veto_memory_export · veto_memory_import`);
  console.log(`  ${c.dim('Learning')}      veto_record_outcome · veto_learning_stats · veto_learning_apply`);
  console.log(`  ${c.dim('Handoff')}       veto_handoff · veto_continue · veto_platform_setup`);
  console.log(`  ${c.dim('Intelligence')}  veto_docs_fetch · veto_context_status · veto_task_parse`);
  console.log(`  ${c.dim('Observability')} veto_usage_status · veto_audit_log · veto_health`);
  console.log(`  ${c.dim('CI/CD')}         veto_ci_gate · veto_pr_review`);
  console.log(`  ${c.dim('Discover')}      veto_discover`);
  console.log(`  ${c.dim('Plugins')}       veto_plugins`);
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
  console.log('');
  console.log(c.bold('  Troubleshooting'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.yellow('Veto not available in a new VS Code window / project')}`);
  console.log(`  ${c.dim('→')} Claude Code: MCP must be registered at user scope, not project scope`);
  console.log(`  ${c.dim('→')} Run: ${c.cyan('claude mcp add veto -s user -- npx -y --package @jigyasudham/veto veto-server')}`);
  console.log(`  ${c.dim('→')} The ${c.cyan('-s user')} flag makes Veto global across ALL windows and projects`);
  console.log(`  ${c.dim('→')} Gemini / Cursor / Windsurf: run ${c.cyan('veto init')} once — config is written globally`);
  console.log('');
  console.log(`  ${c.yellow('MCP disconnected / tools not loading')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} again, then fully restart your AI client (Claude / Gemini / Cursor)`);
  console.log(`  ${c.dim('→')} Verify the MCP entry in your AI client config file`);
  console.log(`  ${c.dim('→')} Check Node.js version: ${c.cyan('node --version')}  (need >= 22)`);
  console.log('');
  console.log(`  ${c.yellow('veto command not found after install')}`);
  console.log(`  ${c.dim('→')} Global install: ${c.cyan('npm install -g @jigyasudham/veto')}`);
  console.log(`  ${c.dim('→')} From source:    ${c.cyan('npm run build && npm link')}`);
  console.log(`  ${c.dim('→')} Windows: restart terminal after install so PATH refreshes`);
  console.log('');
  console.log(`  ${c.yellow('Tools missing in Claude / Gemini after install')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} to write / regenerate the MCP config`);
  console.log(`  ${c.dim('→')} Fully quit and reopen the AI client (not just reload)`);
  console.log(`  ${c.dim('→')} Claude Desktop config: ${c.dim('~/.config/claude/claude_desktop_config.json')}`);
  console.log(`  ${c.dim('→')} Gemini / other: check the platform docs for MCP config location`);
  console.log('');
  console.log(`  ${c.yellow('Old version still showing after update')}`);
  console.log(`  ${c.dim('→')} ${c.cyan('npm install -g @jigyasudham/veto@latest')}`);
  console.log(`  ${c.dim('→')} From source: ${c.cyan('npm run build && npm link')}`);
  console.log(`  ${c.dim('→')} Confirm active binary: ${c.cyan('which veto')} / ${c.cyan('where veto')}`);
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
  console.log(`  ${c.yellow('veto init fails / API key not found')}`);
  console.log(`  ${c.dim('→')} Set key in your shell: ${c.cyan('export ANTHROPIC_API_KEY=sk-...')}`);
  console.log(`  ${c.dim('→')} Windows: ${c.cyan('$env:ANTHROPIC_API_KEY="sk-..."')}`);
  console.log(`  ${c.dim('→')} Re-run ${c.cyan('veto init')} after setting the key`);
  console.log('');
  console.log(`  ${c.yellow('veto_health shows degraded / components failing')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} for a summary of all components`);
  console.log(`  ${c.dim('→')} Check ${c.cyan('veto_audit_log')} for recent error events`);
  console.log(`  ${c.dim('→')} Re-run ${c.cyan('veto init')} to repair config and rescan project`);
  console.log('');
  console.log(`  ${c.yellow('Installed via npx but MCP disconnects after restart')}`);
  console.log(`  ${c.dim('→')} npx runs temporarily — it does NOT add veto-server to PATH permanently`);
  console.log(`  ${c.dim('→')} Fix: run ${c.cyan('npx veto init')} again so the config is rewritten with the correct npx command`);
  console.log(`  ${c.dim('→')} Or install globally for a stable binary: ${c.cyan('npm install -g @jigyasudham/veto')}`);
  console.log('');
  console.log(`  ${c.yellow('Installed on a new machine but MCP not working')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('npx @jigyasudham/veto init')} on the new machine — config is not transferred`);
  console.log(`  ${c.dim('→')} Each machine needs its own init run to register the MCP server`);
  console.log(`  ${c.dim('→')} Then restart the AI client on that machine`);
  console.log('');
  console.log(c.bold('  Docs & Support'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('GitHub:')}  https://github.com/jigyasudham/veto`);
  console.log(`  ${c.dim('Issues:')} https://github.com/jigyasudham/veto/issues`);
  console.log(`  ${c.dim('npm:')}     https://www.npmjs.com/package/@jigyasudham/veto`);
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

  case 'help':
  case '--help':
  case '-h':
    helpCommand();
    break;

  default:
    console.error(c.red(`  Unknown command: ${command}`));
    helpCommand();
    process.exit(1);
}
