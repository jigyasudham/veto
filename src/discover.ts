// Shared workspace discovery logic — used by veto_discover (MCP tool) and veto init (CLI)

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readProjectContext } from './context/reader.js';

export type DiscoverDepth = 'quick' | 'standard' | 'full';

export interface DiscoverResult {
  project_dir: string;
  scanned_at: string;
  depth: DiscoverDepth;
  git: {
    branch: string | null;
    remote: string | null;
    commit: string | null;
    dirty_files: string[];
    recent_commits: string[];
  };
  ecosystems: Record<string, string>;
  tech_stack: string[];
  dependencies: string[];
  key_files: string[];
  structure: string[];
  file_counts: Record<string, number>;
  total_files: number;
  duration_ms: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', 'dist', 'build', 'target',
  '.cache', 'coverage', '.venv', 'venv', '.idea', '.vs', 'out', '.turbo',
]);

export const KEY_CONFIG_FILES = [
  'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.ts', 'next.config.js',
  'tailwind.config.ts', 'tailwind.config.js', 'drizzle.config.ts', 'prisma/schema.prisma',
  '.env.example', 'Dockerfile', 'docker-compose.yml', '.github/workflows',
  'eslint.config.js', '.eslintrc.json', 'vitest.config.ts', 'jest.config.ts',
  'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'CLAUDE.md', 'README.md',
];

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function safeRead(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function walkDir(dir: string, prefix: string, depth: number, structure: string[], fileCounts: Record<string, number>): void {
  if (depth > 3 || structure.length > 200) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries.filter(e => !SKIP_DIRS.has(e)).sort()) {
    const full = join(dir, entry);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      structure.push(`${prefix}${entry}/`);
      walkDir(full, prefix + '  ', depth + 1, structure, fileCounts);
    } else {
      structure.push(`${prefix}${entry}`);
      const ext = extname(entry) || '(none)';
      fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
    }
  }
}

export function discoverProject(projectDir: string, depth: DiscoverDepth = 'standard'): DiscoverResult {
  const dir = resolve(projectDir);
  const start = Date.now();

  // Git state
  const git_branch     = safeExec('git rev-parse --abbrev-ref HEAD', dir);
  const git_remote     = safeExec('git remote get-url origin', dir);
  const git_commit     = safeExec('git rev-parse --short HEAD', dir);
  const git_status_raw = safeExec('git status --short', dir);
  const git_log_raw    = safeExec('git log --oneline -10 --no-color', dir);
  const dirty_files    = git_status_raw.split('\n').filter(Boolean).map(l => l.trim());
  const recent_commits = git_log_raw.split('\n').filter(Boolean);

  // Package metadata & tech stack
  const ecosystems: Record<string, string> = {};
  const tech_stack: string[] = [];
  let dependencies: string[] = [];

  const pkgRaw = safeRead(join(dir, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      ecosystems['node'] = `${String(pkg.name ?? 'unknown')} v${String(pkg.version ?? '?')}`;
      const allDeps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) };
      dependencies = Object.keys(allDeps).slice(0, 30);
      tech_stack.push(...readProjectContext(dir).tech_stack);
    } catch { /* malformed */ }
  }

  const pyprojectRaw = safeRead(join(dir, 'pyproject.toml'));
  const requirementsRaw = safeRead(join(dir, 'requirements.txt'));
  if (pyprojectRaw || requirementsRaw) {
    ecosystems['python'] = pyprojectRaw ? 'pyproject.toml' : 'requirements.txt';
    if (!tech_stack.includes('Python')) tech_stack.push('Python');
  }

  const cargoRaw = safeRead(join(dir, 'Cargo.toml'));
  if (cargoRaw) {
    const nm = cargoRaw.match(/^name\s*=\s*"(.+)"/m);
    const vm = cargoRaw.match(/^version\s*=\s*"(.+)"/m);
    ecosystems['rust'] = `${nm?.[1] ?? 'crate'} v${vm?.[1] ?? '?'}`;
    if (!tech_stack.includes('Rust')) tech_stack.push('Rust');
  }

  const goModRaw = safeRead(join(dir, 'go.mod'));
  if (goModRaw) {
    const mm = goModRaw.match(/^module\s+(.+)/m);
    ecosystems['go'] = mm?.[1]?.trim() ?? 'go module';
    if (!tech_stack.includes('Go')) tech_stack.push('Go');
  }

  // File tree
  const file_counts: Record<string, number> = {};
  const structure: string[] = [];
  if (depth !== 'quick') {
    walkDir(dir, '', 0, structure, file_counts);
  }

  // Key config files
  const key_files = KEY_CONFIG_FILES.filter(f => {
    try { statSync(join(dir, f)); return true; } catch { return false; }
  });

  const total_files = Object.values(file_counts).reduce((s, c) => s + c, 0);

  return {
    project_dir: dir,
    scanned_at: new Date().toISOString(),
    depth,
    git: { branch: git_branch || null, remote: git_remote || null, commit: git_commit || null, dirty_files, recent_commits },
    ecosystems,
    tech_stack: [...new Set(tech_stack)],
    dependencies,
    key_files,
    structure: depth !== 'quick' ? structure : [],
    file_counts,
    total_files,
    duration_ms: Date.now() - start,
  };
}
