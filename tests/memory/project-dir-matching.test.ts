// Hosts spell one folder differently (Gemini: d:\veto; a save: d:\Veto; a
// terminal: D:\Veto). Every project-scoped lookup has to treat them as one.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, getProjectMap, searchKnowledge, storeKnowledge, updateProjectMap } from '../../src/memory/local.js';
import { exportMemoryMarkdown } from '../../src/memory/sync.js';

beforeEach(() => {
  getDb().exec('DELETE FROM knowledge_base; DELETE FROM project_map;');
});

describe('project-scoped lookups', () => {
  it('memory export for the folder you are in finds knowledge stored with a lower-case drive letter', () => {
    // `veto memory export --format=markdown` passes the raw cwd (D:\...); stored rows are d:\...
    storeKnowledge({ title: 'A decision', content: 'we chose X', project_dir: 'D:\\Proj' });
    const dir = mkdtempSync(join(tmpdir(), 'veto-export-'));
    try {
      const out = join(dir, 'VETO_MEMORY.md');
      const r = exportMemoryMarkdown('D:\\Proj', out);
      expect(r.success).toBe(true);
      expect(readFileSync(out, 'utf8')).toContain('A decision');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('project map updates one row per folder whatever the drive-letter case', () => {
    updateProjectMap({ project_dir: 'D:\\Proj', structure: { a: 1 } });
    updateProjectMap({ project_dir: 'd:\\Proj', structure: { a: 2 } });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM project_map').get() as { n: number }).n).toBe(1);
    expect(JSON.parse(getProjectMap('D:\\Proj')!.structure)).toEqual({ a: 2 });
  });

  it.runIf(process.platform === 'win32')('on Windows, a differently-cased path is the same project', () => {
    storeKnowledge({ title: 'Casing', content: 'c', project_dir: 'd:\\Veto' });
    expect(searchKnowledge({ project_dir: 'd:\\veto' }).map(k => k.title)).toEqual(['Casing']);
    updateProjectMap({ project_dir: 'd:\\veto', structure: {} });
    updateProjectMap({ project_dir: 'D:\\Veto', structure: {} });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM project_map').get() as { n: number }).n).toBe(1);
  });

  it.runIf(process.platform !== 'win32')('elsewhere, paths stay case-sensitive', () => {
    storeKnowledge({ title: 'Casing', content: 'c', project_dir: '/home/u/Veto' });
    expect(searchKnowledge({ project_dir: '/home/u/veto' })).toEqual([]);
  });
});
