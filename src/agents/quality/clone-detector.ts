import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';

export type CloneFinding = {
  hash: string;
  lines: number;
  occurrences: Array<{ file: string; start_line: number; end_line: number }>;
  code_snippet: string;
};

type Occ = { file: string; start_line: number; end_line: number };

const MAX_FILE_BYTES = 400_000;

/**
 * Exact (whitespace-insensitive) duplicated blocks of at least `min_lines`
 * non-blank lines across the project.
 *
 * Fixed in 3.7.0:
 *   • A window was compared with blank lines dropped, so two OVERLAPPING windows
 *     of one file could hash the same and be reported as a clone of themselves.
 *     Occurrences now never overlap within a file.
 *   • A clone longer than the window was reported once per shifted window (a
 *     10-line copy with min_lines 6 became 5 findings). Consecutive windows of
 *     the same copy are now merged into one finding with its real extent.
 *   • Paths are relative with forward slashes (they kept a leading separator).
 */
export async function detectClones(options: {
  project_dir: string;
  extensions?: string[];
  min_lines?: number;
}): Promise<CloneFinding[]> {
  const { project_dir, extensions = ['.ts', '.js', '.tsx', '.jsx'], min_lines = 6 } = options;
  const files: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build' || entry === 'coverage') continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (extensions.includes(extname(full)) && stat.size <= MAX_FILE_BYTES) files.push(full);
    }
  }
  walk(project_dir);

  // Windows of `min_lines` NON-BLANK lines, remembering their real line numbers.
  const chunkMap = new Map<string, Occ[]>();
  const snippetMap = new Map<string, string>();
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(project_dir, file).replace(/\\/g, '/');
    const nonBlank: Array<{ text: string; line: number }> = [];
    content.split(/\r?\n/).forEach((l, i) => { const t = l.trim(); if (t && t !== '}' && t !== '{' && t !== '});' && t !== ')') nonBlank.push({ text: t, line: i + 1 }); });
    for (let i = 0; i + min_lines <= nonBlank.length; i++) {
      const win = nonBlank.slice(i, i + min_lines);
      const chunkStr = win.map(w => w.text).join('\n');
      const hash = createHash('md5').update(chunkStr).digest('hex');
      const list = chunkMap.get(hash) ?? [];
      const occ = { file: rel, start_line: win[0].line, end_line: win[win.length - 1].line };
      // Never an occurrence that overlaps one already recorded in the same file.
      if (!list.some(o => o.file === occ.file && occ.start_line <= o.end_line && o.start_line <= occ.end_line)) list.push(occ);
      chunkMap.set(hash, list);
      if (!snippetMap.has(hash)) snippetMap.set(hash, chunkStr);
    }
  }

  const raw: CloneFinding[] = [];
  for (const [hash, occurrences] of chunkMap) {
    if (occurrences.length > 1) raw.push({ hash, lines: min_lines, occurrences, code_snippet: snippetMap.get(hash)! });
  }

  // Merge runs of shifted windows that describe one longer copy.
  const key = (f: CloneFinding) => f.occurrences.map(o => o.file).join('|');
  raw.sort((a, b) => key(a).localeCompare(key(b)) || a.occurrences[0].start_line - b.occurrences[0].start_line);
  const merged: CloneFinding[] = [];
  for (const f of raw) {
    const last = merged[merged.length - 1];
    const extends_ = last && key(last) === key(f) && last.occurrences.length === f.occurrences.length &&
      f.occurrences.every((o, i) => o.start_line > last.occurrences[i].start_line && o.start_line <= last.occurrences[i].end_line + 1);
    if (extends_) {
      last.occurrences = last.occurrences.map((o, i) => ({ ...o, end_line: Math.max(o.end_line, f.occurrences[i].end_line) }));
      last.lines += 1;
      const tail = f.code_snippet.split('\n').pop();
      if (tail !== undefined) last.code_snippet += `\n${tail}`;
    } else {
      merged.push({ ...f, occurrences: f.occurrences.map(o => ({ ...o })) });
    }
  }

  return merged.sort((a, b) => b.occurrences.length - a.occurrences.length || b.lines - a.lines).slice(0, 20);
}
