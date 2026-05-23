import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

export type CloneFinding = {
  hash: string;
  lines: number;
  occurrences: Array<{ file: string; start_line: number; end_line: number }>;
  code_snippet: string;
};

export async function detectClones(options: {
  project_dir: string;
  extensions?: string[];
  min_lines?: number;
}): Promise<CloneFinding[]> {
  const { project_dir, extensions = ['.ts', '.js', '.tsx', '.jsx'], min_lines = 6 } = options;
  const files: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.includes(extname(full))) {
        files.push(full);
      }
    }
  }

  try {
    walk(project_dir);
  } catch (err) {
    return [];
  }

  const chunkMap = new Map<string, Array<{ file: string; start_line: number; end_line: number }>>();
  const snippetMap = new Map<string, string>();

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i <= lines.length - min_lines; i++) {
      const chunk = lines.slice(i, i + min_lines).map(l => l.trim()).filter(l => l.length > 0);
      if (chunk.length < min_lines / 2) continue; // too many empty lines

      const chunkStr = chunk.join('\n');
      const hash = createHash('md5').update(chunkStr).digest('hex');

      if (!chunkMap.has(hash)) {
        chunkMap.set(hash, []);
        snippetMap.set(hash, chunkStr);
      }
      chunkMap.get(hash)!.push({ file: file.replace(project_dir, ''), start_line: i + 1, end_line: i + min_lines });
    }
  }

  const findings: CloneFinding[] = [];
  for (const [hash, occurrences] of chunkMap.entries()) {
    if (occurrences.length > 1) {
      // Filter out overlapping occurrences in the same file
      const uniqueOccurrences = occurrences.filter((occ, index) => {
        return !occurrences.some((other, otherIndex) => {
          return index !== otherIndex &&
                 occ.file === other.file &&
                 occ.start_line >= other.start_line &&
                 occ.end_line <= other.end_line &&
                 (occ.end_line - occ.start_line) < (other.end_line - other.start_line);
        });
      });

      if (uniqueOccurrences.length > 1) {
        findings.push({
          hash,
          lines: min_lines,
          occurrences: uniqueOccurrences,
          code_snippet: snippetMap.get(hash)!,
        });
      }
    }
  }

  // Sort by occurrence count descending
  return findings.sort((a, b) => b.occurrences.length - a.occurrences.length).slice(0, 20);
}
