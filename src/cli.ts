#!/usr/bin/env node
// Veto CLI — entry point for `npx veto init`

// Suppress Node experimental warnings (node:sqlite) for clean UX
process.removeAllListeners('warning');

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { homedir } from 'node:os';

const VERSION = '0.10.0';
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
  console.log(c.dim(`  50 agents. 33 tools. 3 AIs. Self-learning. Zero extra cost.`));
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
    servers['veto'] = { command: 'veto-server' };
    existing.mcpServers = servers;
  } else {
    const servers = (existing.servers as Record<string, unknown>) ?? {};
    servers['veto'] = { type: 'stdio', command: 'veto-server' };
    existing.servers = servers;
  }

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return wasEmpty ? 'created' : 'updated';
}

// All platforms Veto supports, with their config paths and formats.
const PLATFORMS = [
  {
    name: 'Claude Code',
    path: join(HOME, '.claude', 'mcp_servers.json'),
    format: 'mcpServers' as const,
    detectionDir: join(HOME, '.claude'),
  },
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
      console.log(c.green('  ✓ ') + `${platform.name} — configured`);
      configured++;
    } else {
      console.log(c.green('  ✓ ') + `${platform.name} — updated`);
      configured++;
    }
  }

  console.log('');

  if (configured === 0 && skipped === 0) {
    console.log(c.yellow('  ⚠  No AI tools detected.'));
    console.log('  Install Claude Code, Gemini CLI, or Codex CLI and run veto init again.');
    console.log('');
  } else {
    console.log(c.green(`  ✓ Veto configured for ${configured} tool${configured !== 1 ? 's' : ''}!`));
    console.log('');
    console.log('  Next steps:');
    console.log(c.dim('  1.') + ' Restart your AI CLI or IDE');
    console.log(c.dim('  2.') + ' Run: veto_status  — should return { "status": "running", "version": "' + VERSION + '" }');
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
