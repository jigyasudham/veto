// Structural repo-map: symbol extraction + dependency graph + PageRank scoring.
// Pure Node.js, zero native deps. Replaces manually-maintained project maps.
// Output budget: ~1,000 tokens (top 25 modules + compact dep graph).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { loadIgnoreRules, shouldSkipDir } from './ignore.js';

export interface SymbolEntry {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'other';
  exported: boolean;
}

export interface ModuleEntry {
  file: string;            // path relative to project root
  symbols: SymbolEntry[];  // exported + important internal symbols
  imports: string[];       // resolved relative paths this file imports from
  ref_count: number;       // how many other files import this file
  rank: number;            // 0.0–1.0 PageRank-style score
}

export interface RepoMap {
  generated_at: string;
  project_dir: string;
  total_files: number;
  symbol_count: number;
  top_modules: ModuleEntry[];                      // top 25 by rank
  dep_graph: Record<string, string[]>;             // file → files it imports (top modules only)
  ignored_patterns: string[];
}

// ─── Language detection ───────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
]);

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

const EXPORT_PATTERNS: Array<{ re: RegExp; kind: SymbolEntry['kind']; langs: string[] }> = [
  { re: /export\s+(?:abstract\s+)?class\s+(\w+)/g,       kind: 'class', langs: ['ts', 'js'] },
  { re: /export\s+(?:async\s+)?function\s+(\w+)/g,       kind: 'function', langs: ['ts', 'js'] },
  { re: /export\s+interface\s+(\w+)/g,                    kind: 'interface', langs: ['ts', 'js'] },
  { re: /export\s+type\s+(\w+)\s*[=<{]/g,                kind: 'type', langs: ['ts', 'js'] },
  { re: /export\s+enum\s+(\w+)/g,                        kind: 'enum', langs: ['ts', 'js'] },
  { re: /export\s+const\s+(\w+)/g,                       kind: 'const', langs: ['ts', 'js'] },
  // Python
  { re: /^class\s+(\w+)/gm,                              kind: 'class', langs: ['py'] },
  { re: /^def\s+(\w+)/gm,                                kind: 'function', langs: ['py'] },
  // Rust
  { re: /^pub\s+(?:async\s+)?fn\s+(\w+)/gm,              kind: 'function', langs: ['rs'] },
  { re: /^pub\s+struct\s+(\w+)/gm,                        kind: 'class', langs: ['rs'] },
  { re: /^pub\s+enum\s+(\w+)/gm,                          kind: 'enum', langs: ['rs'] },
  { re: /^pub\s+trait\s+(\w+)/gm,                         kind: 'interface', langs: ['rs'] },
  // Go
  { re: /^func\s+(\w+)/gm,                               kind: 'function', langs: ['go'] },
  { re: /^type\s+(\w+)\s+struct/gm,                      kind: 'class', langs: ['go'] },
  { re: /^type\s+(\w+)\s+interface/gm,                   kind: 'interface', langs: ['go'] },
];

function extractSymbols(content: string, ext: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const seen = new Set<string>();
  const lang = ext.slice(1);

  for (const { re, kind, langs } of EXPORT_PATTERNS) {
    if (!langs.includes(lang) && !(lang === 'tsx' && langs.includes('ts'))) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (name && !seen.has(name)) {
        // Simple structural check: is it top-level?
        const index = m.index;
        const before = content.slice(0, index);
        const openBraces = (before.match(/{/g) || []).length;
        const closeBraces = (before.match(/}/g) || []).length;
        const isTopLevel = openBraces === closeBraces;

        if (isTopLevel || lang === 'py' || lang === 'go') {
          seen.add(name);
          symbols.push({ name, kind, exported: true });
        }
      }
    }
  }

  return symbols.slice(0, 30);
}

// ─── Import extraction ────────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  // ES import: import ... from '...'
  /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  // require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: from . import / import .
  /from\s+['"]?([./][^'"\s]+)['"]?/g,
];

function extractImports(content: string, fileDir: string, projectDir: string): string[] {
  const imports = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(content)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      // Only process relative imports (starts with . or ..)
      if (!raw.startsWith('.')) continue;
      // Resolve relative to project root
      try {
        const resolved = join(fileDir, raw)
          .replace(/\\/g, '/')
          .replace(/\.js$/, '.ts')   // .js → .ts (TS projects)
          .replace(/\.jsx$/, '.tsx');
        const rel = relative(projectDir, resolved).replace(/\\/g, '/');
        if (!rel.startsWith('..')) {
          imports.add(rel);
        }
      } catch { /* ignore */ }
    }
  }

  return Array.from(imports);
}

// ─── Directory walker ─────────────────────────────────────────────────────────

function walkDir(
  dir: string,
  projectDir: string,
  ignore: ReturnType<typeof loadIgnoreRules>,
  files: string[],
  depth = 0,
): void {
  if (depth > 8) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.github') continue;
    if (shouldSkipDir(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(projectDir, full).replace(/\\/g, '/');
    if (ignore.shouldIgnore(rel)) continue;

    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      walkDir(full, projectDir, ignore, files, depth + 1);
    } else if (st.isFile() && isSourceFile(entry)) {
      files.push(full);
      if (files.length > 2000) return; // safety cap
    }
  }
}

// ─── PageRank (simplified: in-degree score + depth penalty) ──────────────────

function computeRanks(modules: Map<string, Omit<ModuleEntry, 'rank'>>): Map<string, number> {
  // Start with in-degree (ref_count) as the primary signal
  const maxRefs = Math.max(1, ...Array.from(modules.values()).map(m => m.ref_count));

  const ranks = new Map<string, number>();
  for (const [file, m] of modules) {
    const refScore = m.ref_count / maxRefs;
    // Bonus for files with many exported symbols (important API surface)
    const symbolBonus = Math.min(0.2, m.symbols.length * 0.02);
    // Depth penalty: deeper files are less central
    const depth = file.split('/').length;
    const depthPenalty = Math.max(0, 0.05 * (depth - 2));
    ranks.set(file, Math.max(0, refScore + symbolBonus - depthPenalty));
  }
  return ranks;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RepoMapOptions {
  projectDir: string;
  maxTopModules?: number;   // default 25
  maxTokenBudget?: number;  // default 1000 (approximate, not exact)
}

export function buildRepoMap(opts: RepoMapOptions): RepoMap {
  const { projectDir, maxTopModules = 25 } = opts;
  const start = Date.now();

  const ignore = loadIgnoreRules(projectDir);
  const allFiles: string[] = [];
  walkDir(projectDir, projectDir, ignore, allFiles);

  // Build module data: symbols + imports
  const moduleData = new Map<string, Omit<ModuleEntry, 'rank'>>();

  for (const absPath of allFiles) {
    const rel = relative(projectDir, absPath).replace(/\\/g, '/');
    const ext = extname(absPath).toLowerCase();
    let content = '';
    try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }

    const symbols = extractSymbols(content, ext);
    const imports = extractImports(content, join(absPath, '..'), projectDir);

    moduleData.set(rel, { file: rel, symbols, imports, ref_count: 0 });
  }

  // Count references (in-degree)
  for (const m of moduleData.values()) {
    for (const imp of m.imports) {
      // Try exact + with/without extension
      for (const key of [imp, `${imp}.ts`, `${imp}.tsx`, `${imp}/index.ts`]) {
        if (moduleData.has(key)) {
          const target = moduleData.get(key)!;
          target.ref_count++;
          break;
        }
      }
    }
  }

  // Compute ranks
  const ranks = computeRanks(moduleData);

  // Sort by rank, take top N
  const sorted = Array.from(moduleData.entries())
    .map(([file, m]) => ({ ...m, rank: Math.round((ranks.get(file) ?? 0) * 100) / 100 }))
    .sort((a, b) => b.rank - a.rank);

  const topModules = sorted.slice(0, maxTopModules);

  // Build compact dep graph (only between top modules)
  const topFiles = new Set(topModules.map(m => m.file));
  const depGraph: Record<string, string[]> = {};
  for (const m of topModules) {
    const deps = m.imports.filter(imp =>
      topFiles.has(imp) || topFiles.has(`${imp}.ts`) || topFiles.has(`${imp}.tsx`)
    );
    if (deps.length > 0) depGraph[m.file] = deps.slice(0, 8);
  }

  const symbolCount = Array.from(moduleData.values()).reduce((s, m) => s + m.symbols.length, 0);

  return {
    generated_at: new Date().toISOString(),
    project_dir: projectDir,
    total_files: allFiles.length,
    symbol_count: symbolCount,
    top_modules: topModules.map(m => ({
      ...m,
      // Trim symbol list for token budget
      symbols: m.symbols.slice(0, 6),
      // Trim imports for budget
      imports: m.imports.slice(0, 6),
    })),
    dep_graph: depGraph,
    ignored_patterns: ignore.patterns.slice(0, 20),
  };
}

export function repoMapToCompact(map: RepoMap): string {
  const lines: string[] = [
    `# Repo Map — ${map.project_dir}`,
    `Generated: ${map.generated_at} | Files: ${map.total_files} | Symbols: ${map.symbol_count}`,
    '',
    '## Top Modules (by reference rank)',
  ];

  for (const m of map.top_modules) {
    const syms = m.symbols.map(s => s.name).join(', ');
    lines.push(`- **${m.file}** (refs:${m.ref_count}, rank:${m.rank}) — ${syms || 'no exports'}`);
  }

  if (Object.keys(map.dep_graph).length > 0) {
    lines.push('', '## Key Dependencies');
    for (const [file, deps] of Object.entries(map.dep_graph)) {
      lines.push(`- ${file} → ${deps.join(', ')}`);
    }
  }

  return lines.join('\n');
}
