import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { detectClones } from '../../src/agents/quality/clone-detector.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-clones-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const BODY = ['const dollars = Math.floor(cents / 100);', 'const rest = cents % 100;', "const text = String(rest).padStart(2, '0');", "return '$' + dollars + '.' + text;"];

describe('detectClones', () => {
  it('reports one copied block once, with its full extent and relative paths', async () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), ['export function formatPrice(cents: number) {', ...BODY, '}'].join('\n'));
    writeFileSync(join(dir, 'src', 'b.ts'), ['// helper', '', 'export function formatAmount(cents: number) {', ...BODY, '}'].join('\n'));
    const found = await detectClones({ project_dir: dir, min_lines: 3 });
    expect(found).toHaveLength(1);
    expect(found[0].lines).toBe(4);
    expect(found[0].occurrences).toEqual([
      { file: 'src/a.ts', start_line: 2, end_line: 5 },
      { file: 'src/b.ts', start_line: 4, end_line: 7 },
    ]);
  });

  it('never reports a block as a clone of an overlapping copy of itself', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'x.ts'), ['const app = express();', '', 'const app = express();', '', 'const app = express();', 'const app = express();'].join('\n'));
    const found = await detectClones({ project_dir: dir, min_lines: 2 });
    for (const f of found) {
      const [a, b] = f.occurrences;
      expect(a.end_line < b.start_line || b.end_line < a.start_line || a.file !== b.file).toBe(true);
    }
  });

  it('finds nothing in distinct code', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    writeFileSync(join(dir, 'b.ts'), 'const d = 4;\nconst e = 5;\nconst f = 6;\n');
    expect(await detectClones({ project_dir: dir, min_lines: 3 })).toEqual([]);
  });
});
