// Deterministic evidence the worker tools gather before any LLM runs.
//
// Several tools used to hand the host AI a one-line task ("Perform semantic
// search.", "Analyze TypeScript type coverage.") and nothing else: no query, no
// files, no numbers. Whatever came back could only be generic. These helpers do
// the part a program can do exactly — find the files, count the `any`s, match
// sources to tests, locate the conflict blocks — and return it as facts, which
// both reach the user as they are and ground the LLM step.
//
// Mechanical: filesystem reads only, bounded, no network, no writes.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache']);
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 400_000;

export const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.vue', '.svelte', '.html', '.css', '.scss', '.md', '.json', '.yaml', '.yml', '.sql'];

/** Project files, relative paths with forward slashes, skipping vendored and build output. */
export function listProjectFiles(root: string, exts: string[] = CODE_EXTS, max = MAX_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || out.length >= max) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && exts.includes(extname(e.name).toLowerCase())) {
        out.push(relative(root, join(dir, e.name)).replace(/\\/g, '/'));
      }
    }
  };
  walk(root, 0);
  return out;
}

function readText(root: string, rel: string): string | null {
  try {
    const p = join(root, rel);
    if (statSync(p).size > MAX_FILE_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

// ─── Code search ─────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'where', 'what', 'how', 'which', 'who', 'does', 'do', 'in', 'of', 'to', 'for', 'and', 'or', 'on', 'with', 'this', 'that', 'it', 'be', 'by', 'from', 'code', 'file', 'files', 'handled', 'defined', 'located', 'find', 'show', 'me']);

export type SearchHit = { file: string; line: number; text: string; score: number };

/**
 * Keyword search ranked by how many query terms a line and its file contain.
 * Terms also match as prefixes and inside identifiers (price → formatPrice).
 * This is lexical, not semantic: the calling AI reads the hits to answer.
 */
export function searchCode(root: string, query: string, limit = 25): { terms: string[]; files_scanned: number; hits: SearchHit[] } {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2 && !STOP.has(t)))]
    .map(t => t.replace(/(ies|es|s|ing|ed)$/, '') || t);
  const files = listProjectFiles(root);
  if (!terms.length) return { terms, files_scanned: files.length, hits: [] };
  const hits: SearchHit[] = [];
  for (const rel of files) {
    const text = readText(root, rel);
    if (text === null) continue;
    const lower = text.toLowerCase();
    const fileTerms = terms.filter(t => lower.includes(t) || rel.toLowerCase().includes(t)).length;
    if (!fileTerms) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      const lineTerms = terms.filter(t => l.includes(t)).length;
      if (!lineTerms) continue;
      hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200), score: lineTerms * 3 + fileTerms });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return { terms, files_scanned: files.length, hits: hits.slice(0, limit) };
}

// ─── TypeScript `any` usage ──────────────────────────────────────────────────

export type AnyUse = { file: string; line: number; kind: 'explicit any' | 'as any' | 'ts-ignore' | 'ts-expect-error'; text: string };

export function typeCoverage(root: string, maxFiles = 30) {
  const files = listProjectFiles(root, ['.ts', '.tsx', '.mts', '.cts']).filter(f => !f.endsWith('.d.ts'));
  const uses: AnyUse[] = [];
  const perFile: Record<string, number> = {};
  for (const rel of files) {
    const text = readText(root, rel);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/\/\/(?!\s*@ts-).*$/, '');
      const add = (kind: AnyUse['kind']) => { uses.push({ file: rel, line: i + 1, kind, text: raw.trim().slice(0, 160) }); perFile[rel] = (perFile[rel] ?? 0) + 1; };
      if (/\bas\s+any\b/.test(line)) add('as any');
      else if (/:\s*any\b|<any>|\bany\[\]|Array<any>|Record<[^>]*\bany\b/.test(line)) add('explicit any');
      if (/@ts-ignore/.test(raw)) add('ts-ignore');
      if (/@ts-expect-error/.test(raw)) add('ts-expect-error');
    });
  }
  let strict: boolean | null = null;
  let noImplicitAny: boolean | null = null;
  const tsconfig = readText(root, 'tsconfig.json');
  if (tsconfig) {
    strict = /"strict"\s*:\s*true/.test(tsconfig) ? true : /"strict"\s*:\s*false/.test(tsconfig) ? false : null;
    noImplicitAny = /"noImplicitAny"\s*:\s*true/.test(tsconfig) ? true : /"noImplicitAny"\s*:\s*false/.test(tsconfig) ? false : null;
  }
  const worst = Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, maxFiles).map(([file, count]) => ({ file, count }));
  return {
    ts_files: files.length,
    total: uses.length,
    by_kind: uses.reduce<Record<string, number>>((m, u) => { m[u.kind] = (m[u.kind] ?? 0) + 1; return m; }, {}),
    tsconfig: { found: tsconfig !== null, strict, noImplicitAny },
    worst_files: worst,
    // Security-sensitive paths get looked at first.
    sensitive: uses.filter(u => /auth|secur|crypt|token|session|password|login|permission/i.test(u.file)).slice(0, 30),
    sample: uses.slice(0, 60),
  };
}

// ─── Source files without tests ──────────────────────────────────────────────

export function testGaps(root: string) {
  const all = listProjectFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rb', '.java', '.kt']);
  const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i.test(f);
  const tests = all.filter(isTest);
  const sources = all.filter(f => !isTest(f) && !/\.d\.ts$|(^|\/)(scripts|examples?|fixtures?)\//.test(f) && !/config\.[a-z]+$/.test(f));
  const stem = (f: string) => basename(f).replace(/\.(test|spec)(?=\.)/, '').replace(/^test_/, '').replace(/_test(?=\.)/, '').replace(/\.[^.]+$/, '').toLowerCase();
  const testStems = new Set(tests.map(stem));
  const untested = sources.filter(f => !testStems.has(stem(f)));
  return { source_files: sources.length, test_files: tests.length, untested: untested.slice(0, 60), untested_count: untested.length };
}

/**
 * Per-file line coverage from an lcov file or an Istanbul coverage-summary
 * JSON, lowest first. Null when the file cannot be read or is neither format.
 */
export function readCoverage(path: string): Array<{ file: string; lines_pct: number; lines_hit: number; lines_total: number }> | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const out: Array<{ file: string; lines_pct: number; lines_hit: number; lines_total: number }> = [];
  if (/^SF:/m.test(text)) {
    for (const rec of text.split(/^end_of_record\s*$/m)) {
      const sf = rec.match(/^SF:(.+)$/m)?.[1]?.trim();
      const lf = Number(rec.match(/^LF:(\d+)$/m)?.[1] ?? NaN);
      const lh = Number(rec.match(/^LH:(\d+)$/m)?.[1] ?? NaN);
      if (sf && Number.isFinite(lf) && Number.isFinite(lh)) out.push({ file: sf, lines_hit: lh, lines_total: lf, lines_pct: lf ? Math.round((lh / lf) * 1000) / 10 : 100 });
    }
  } else {
    try {
      const json = JSON.parse(text) as Record<string, { lines?: { total?: number; covered?: number; pct?: number } }>;
      for (const [file, v] of Object.entries(json)) {
        if (file === 'total' || !v?.lines) continue;
        const total = v.lines.total ?? 0;
        const covered = v.lines.covered ?? 0;
        out.push({ file, lines_hit: covered, lines_total: total, lines_pct: typeof v.lines.pct === 'number' ? v.lines.pct : total ? Math.round((covered / total) * 1000) / 10 : 100 });
      }
    } catch { return null; }
  }
  return out.length ? out.sort((a, b) => a.lines_pct - b.lines_pct) : null;
}

// ─── Existing lint/format configuration ──────────────────────────────────────

const LINT_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.prettierrc', '.prettierrc.json', 'prettier.config.js', 'biome.json', 'ruff.toml', '.ruff.toml', 'pyproject.toml', '.editorconfig', 'tsconfig.json'];

export function lintConfigs(root: string) {
  const found: Array<{ file: string; content: string }> = [];
  for (const f of LINT_FILES) {
    if (!existsSync(join(root, f))) continue;
    const text = readText(root, f);
    if (text !== null) found.push({ file: f, content: text.slice(0, 3000) });
  }
  const pkg = readText(root, 'package.json');
  if (pkg) {
    try {
      const p = JSON.parse(pkg) as Record<string, unknown>;
      if (p.eslintConfig) found.push({ file: 'package.json#eslintConfig', content: JSON.stringify(p.eslintConfig).slice(0, 3000) });
      if (p.prettier) found.push({ file: 'package.json#prettier', content: JSON.stringify(p.prettier).slice(0, 3000) });
    } catch { /* not JSON */ }
  }
  return found;
}

// ─── Merge conflicts ─────────────────────────────────────────────────────────

export function conflictHunks(text: string): Array<{ start_line: number; end_line: number; ours: string; theirs: string }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ start_line: number; end_line: number; ours: string; theirs: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) continue;
    const start = i;
    const ours: string[] = [];
    const theirs: string[] = [];
    let side: 'ours' | 'base' | 'theirs' = 'ours';
    for (i = i + 1; i < lines.length && !lines[i].startsWith('>>>>>>>'); i++) {
      if (lines[i].startsWith('|||||||')) { side = 'base'; continue; }
      if (lines[i].startsWith('=======')) { side = 'theirs'; continue; }
      if (side === 'ours') ours.push(lines[i]); else if (side === 'theirs') theirs.push(lines[i]);
    }
    out.push({ start_line: start + 1, end_line: i + 1, ours: ours.join('\n').slice(0, 2000), theirs: theirs.join('\n').slice(0, 2000) });
  }
  return out;
}

// ─── Exports nothing else uses ───────────────────────────────────────────────

export type UnusedExport = { symbol: string; file: string; line: number; used_in_own_file: boolean };

/**
 * Exported symbols that no other project file mentions. Every file's
 * identifiers are counted once, so this is one pass over the project, not one
 * per symbol. Exports from the package's entry points are public API and are
 * reported separately, not as dead.
 */
export function unusedExports(root: string, exts: string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
  const files = listProjectFiles(root, [...new Set([...exts, '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'])]);
  const texts = new Map<string, string>();
  const counts = new Map<string, Map<string, number>>();
  for (const rel of files) {
    const text = readText(root, rel);
    if (text === null) continue;
    texts.set(rel, text);
    const m = new Map<string, number>();
    for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) m.set(id, (m.get(id) ?? 0) + 1);
    counts.set(rel, m);
  }
  // Entry points: package.json main/module/types/bin/exports, and top-level index files.
  const entries = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const collect = (v: unknown): void => {
      if (typeof v === 'string') entries.add(v.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, ''));
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(pkg.main); collect(pkg.module); collect(pkg.types); collect(pkg.bin); collect(pkg.exports);
  } catch { /* not a node package */ }
  const isEntry = (rel: string) => entries.has(rel.replace(/\.[^.]+$/, '')) || /^(src\/)?index\.[a-z]+$/.test(rel);

  const unused: UnusedExport[] = [];
  const publicApi: Array<{ symbol: string; file: string }> = [];
  let exportsFound = 0;
  for (const [rel, text] of texts) {
    if (!exts.includes(extname(rel).toLowerCase())) continue;
    const lines = text.split(/\r?\n/);
    const declared: Array<{ symbol: string; line: number }> = [];
    lines.forEach((l, i) => {
      const d = l.match(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/);
      if (d) declared.push({ symbol: d[1], line: i + 1 });
      const list = l.match(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/);
      if (list) for (const part of list[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.push({ symbol: name, line: i + 1 });
      }
    });
    exportsFound += declared.length;
    for (const { symbol, line } of declared) {
      if (isEntry(rel)) { publicApi.push({ symbol, file: rel }); continue; }
      let elsewhere = 0;
      for (const [other, m] of counts) if (other !== rel) elsewhere += m.get(symbol) ?? 0;
      if (elsewhere === 0) unused.push({ symbol, file: rel, line, used_in_own_file: (counts.get(rel)?.get(symbol) ?? 0) > 1 });
    }
  }
  return { files_scanned: texts.size, exports_found: exportsFound, unused, public_api: publicApi.slice(0, 50) };
}

/** TODO/FIXME/HACK markers and runs of commented-out code. */
export function codeMarkers(root: string, exts: string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']) {
  const todos: Array<{ file: string; line: number; text: string }> = [];
  const commentedCode: Array<{ file: string; line: number; lines: number }> = [];
  for (const rel of listProjectFiles(root, exts)) {
    const text = readText(root, rel);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    let run = 0;
    lines.forEach((l, i) => {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(l) && /\/\/|#|\/\*|\*/.test(l)) todos.push({ file: rel, line: i + 1, text: l.trim().slice(0, 160) });
      const isCodeComment = /^\s*(\/\/|#)\s*[\w$.]+\s*(\(|=|\{|;|\.\w+\()|^\s*(\/\/|#)\s*(if|for|while|return|const|let|var|def|import|await)\b/.test(l);
      if (isCodeComment) run++;
      if (!isCodeComment || i === lines.length - 1) {
        if (run >= 3) commentedCode.push({ file: rel, line: i + 1 - run + (isCodeComment ? 1 : 0), lines: run });
        run = 0;
      }
    });
  }
  return { todos: todos.slice(0, 100), todo_count: todos.length, commented_code_blocks: commentedCode.slice(0, 50) };
}

// ─── Feature flags ───────────────────────────────────────────────────────────

const FLAG_PATTERNS: Array<{ sdk: string; re: RegExp }> = [
  { sdk: 'env', re: /process\.env\.((?:FEATURE|ENABLE|FF|FLAG)_[A-Z0-9_]+)/g },
  { sdk: 'env', re: /os\.environ(?:\.get)?\(?\[?['"]((?:FEATURE|ENABLE|FF|FLAG)_[A-Z0-9_]+)['"]/g },
  { sdk: 'launchdarkly', re: /(?:variation|boolVariation|stringVariation|variationDetail)\(\s*['"]([\w.-]+)['"]/g },
  { sdk: 'unleash', re: /(?:isEnabled|getVariant)\(\s*['"]([\w.-]+)['"]/g },
  { sdk: 'custom', re: /\b(?:flags?|features?|featureFlags)\.([a-zA-Z_]\w*)\b/g },
  { sdk: 'custom', re: /\b(?:flags?|features?|featureFlags)\[['"]([\w.-]+)['"]\]/g },
];

export function featureFlags(root: string) {
  const flags = new Map<string, { name: string; sdk: string; locations: string[] }>();
  for (const rel of listProjectFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb'])) {
    const text = readText(root, rel);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((l, i) => {
      for (const { sdk, re } of FLAG_PATTERNS) {
        for (const m of l.matchAll(re)) {
          const key = `${sdk}:${m[1]}`;
          const f = flags.get(key) ?? { name: m[1], sdk, locations: [] };
          if (f.locations.length < 20) f.locations.push(`${rel}:${i + 1}`);
          flags.set(key, f);
        }
      }
    });
  }
  const list = [...flags.values()].sort((a, b) => b.locations.length - a.locations.length);
  return { flags: list.slice(0, 100), flags_found: list.length, occurrences: list.reduce((n, f) => n + f.locations.length, 0) };
}

/** A compact project digest for tools that reason about a whole project. */
export function projectDigest(root: string, maxFiles = 150): string {
  const files = listProjectFiles(root);
  const readme = ['README.md', 'readme.md', 'README'].map(f => readText(root, f)).find(Boolean) ?? '';
  const parts = [`Files (${files.length}${files.length > maxFiles ? `, first ${maxFiles}` : ''}):\n${files.slice(0, maxFiles).join('\n')}`];
  if (readme) parts.push(`README (start):\n${readme.slice(0, 2500)}`);
  return parts.join('\n\n');
}
