import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export interface ProjectContext {
  summary: string;        // compact string to prepend to any agent prompt
  package_name?: string;
  package_version?: string;
  tech_stack: string[];
  git_diff: string;
  key_files: string[];
  error?: string;
}

const STACK_INDICATORS: Array<[string[], string]> = [
  [['next', 'next.js'], 'Next.js'],
  [['react', 'react-dom'], 'React'],
  [['vue'], 'Vue'],
  [['svelte'], 'Svelte'],
  [['express'], 'Express'],
  [['fastify'], 'Fastify'],
  [['hono'], 'Hono'],
  [['prisma'], 'Prisma'],
  [['drizzle-orm'], 'Drizzle'],
  [['typeorm'], 'TypeORM'],
  [['mongoose'], 'Mongoose'],
  [['@modelcontextprotocol/sdk'], 'MCP'],
  [['typescript', 'ts-node', 'tsx'], 'TypeScript'],
  [['jest', 'vitest'], 'Testing'],
  [['tailwindcss'], 'Tailwind'],
  [['zod'], 'Zod'],
  [['trpc', '@trpc/server'], 'tRPC'],
  [['graphql'], 'GraphQL'],
];

function detectStack(deps: Record<string, string>): string[] {
  const names = Object.keys(deps).map(k => k.toLowerCase());
  const stack: string[] = [];
  for (const [keywords, label] of STACK_INDICATORS) {
    if (keywords.some(k => names.some(n => n.includes(k)))) {
      stack.push(label);
    }
  }
  return stack;
}

function safeRead(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return '';
  }
}

export function readProjectContext(projectDir: string): ProjectContext {
  const dir = resolve(projectDir);

  if (!existsSync(dir)) {
    return { summary: '', tech_stack: [], git_diff: '', key_files: [], error: `Directory not found: ${dir}` };
  }
  if (!statSync(dir).isDirectory()) {
    return { summary: '', tech_stack: [], git_diff: '', key_files: [], error: `Not a directory: ${dir}` };
  }

  // package.json
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  let techStack: string[] = [];
  const pkgRaw = safeRead(join(dir, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      packageName = pkg.name;
      packageVersion = pkg.version;
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      techStack = detectStack(allDeps);
    } catch { /* malformed package.json */ }
  }

  // git diff — last 60 lines of unstaged + staged changes
  const gitDiff = safeExec('git diff HEAD --stat --no-color', dir);

  // git recent commits (last 5 one-liners for context)
  const gitLog = safeExec('git log --oneline -5 --no-color', dir);

  // key config files present
  const CONFIG_FILES = [
    'tsconfig.json', 'vite.config.ts', 'vite.config.js',
    'next.config.ts', 'next.config.js', 'tailwind.config.ts',
    'drizzle.config.ts', 'prisma/schema.prisma', '.env.example',
  ];
  const keyFiles = CONFIG_FILES.filter(f => existsSync(join(dir, f)));

  // build compact summary string
  const lines: string[] = ['[CODEBASE CONTEXT]'];
  if (packageName) lines.push(`Project: ${packageName}${packageVersion ? ` v${packageVersion}` : ''}`);
  if (techStack.length) lines.push(`Stack: ${techStack.join(', ')}`);
  if (keyFiles.length) lines.push(`Config files: ${keyFiles.join(', ')}`);
  if (gitDiff) lines.push(`Recent changes:\n${gitDiff}`);
  if (gitLog) lines.push(`Recent commits:\n${gitLog}`);

  return {
    summary: lines.join('\n'),
    package_name: packageName,
    package_version: packageVersion,
    tech_stack: techStack,
    git_diff: gitDiff,
    key_files: keyFiles,
  };
}

export function buildContextString(projectDir?: string, existingContext?: string): string {
  if (!projectDir) return existingContext ?? '';
  const ctx = readProjectContext(projectDir);
  if (ctx.error) return existingContext ?? '';
  const parts = [ctx.summary];
  if (existingContext) parts.push(existingContext);
  return parts.join('\n\n');
}
