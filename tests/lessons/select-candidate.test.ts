import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, getConfig, setConfig } from '../../src/memory/config.js';
import { getDb, resetDb } from '../../src/memory/local.js';
import { resolveProjectIdentity } from '../../src/lessons/identity.js';
import { disableLessonSource, excludeProject, syncLessons } from '../../src/lessons/store.js';
import { selectLessonsForShadow } from '../../src/lessons/select.js';
import { selectLessonsCandidate } from '../../src/lessons/select-candidate.js';
import { runLessonsCommand } from '../../src/cli/lessons.js';

let home: string;
let project: string;
beforeEach(() => {
  resetDb();
  home = mkdtempSync(join(tmpdir(), 'veto-candidate-'));
  process.env.VETO_CONFIG_PATH = join(home, 'config.json');
  project = resolveProjectIdentity(home);
  enableLessonsSharing();
});
afterEach(() => {
  resetDb();
  delete process.env.VETO_CONFIG_PATH;
  rmSync(home, { recursive: true, force: true });
});
function seed(text = 'PowerShell encoding requires explicit UTF-8 output.', overrides: {
  name?: string; project?: string; quarantine?: string; scope?: 'project' | 'machine';
  mtime?: string; host?: 'claude' | 'codex';
} = {}) {
  syncLessons({ sourceCli: overrides.host ?? 'claude', sourcePath: join(home, overrides.name ?? 'note.md'),
    projectIdentity: overrides.project ?? project, projectLabel: 'synthetic',
    sourceMtime: overrides.mtime ?? new Date().toISOString(), sections: [{ anchor: 'body', textMasked: text,
      scope: overrides.scope ?? 'project', scopeReason: 'project-default', kind: 'lesson',
      quarantineReason: overrides.quarantine ?? null }] });
}
const candidate = (query: string, asOf?: number) => selectLessonsCandidate({ query, targetProjectDir: home, targetHost: 'codex', asOf });

describe('candidate versus actual frozen selector, synthetic development corpus', () => {
  it('recovers aliases with no extra selections on six deliberate negatives', () => {
    seed();
    const positives = ['PowerShell encoding', 'pwsh encoding', 'powershell.exe encoding', 'powershell utf8'];
    const negatives = ['postgres migration', 'pwsh deployment', 'pwsh powershell deployment',
      'encoding postgres', 'git-bash deployment', 'constructor prototype'];
    const baseline = (query: string) => selectLessonsForShadow({ query, targetProjectDir: home, targetHost: 'codex' });
    expect(positives.filter(q => baseline(q).lessonIds.length)).toHaveLength(1);
    expect(positives.filter(q => candidate(q).lessonIds.length)).toHaveLength(4);
    expect(negatives.filter(q => baseline(q).lessonIds.length)).toHaveLength(0);
    expect(negatives.filter(q => candidate(q).lessonIds.length)).toHaveLength(0);
  });
  it('preserves whole-word evidence and arbitrary identifiers', () => {
    seed('git-bash quoting constructor prototype');
    expect(candidate('git-bash deployment').lessonIds).toHaveLength(0);
    expect(candidate('constructor prototype').lessonIds).toHaveLength(1);
  });
  it('gives no access without consent, for excluded projects, or during trial 2', () => {
    seed();
    setConfig({ lessons: { ...getConfig().lessons, enabled: false } });
    expect(candidate('pwsh encoding').reason).toBe('consent_off');
    enableLessonsSharing();
    setConfig({ lessons: { ...getConfig().lessons, trial: { id: 2, consent_version: 1,
      started_at: new Date().toISOString(), use: [], ignore: [] } } });
    expect(candidate('pwsh encoding').reason).toBe('trial_running');
    setConfig({ lessons: { ...getConfig().lessons, trial: null } });
    excludeProject(project, 'synthetic');
    expect(candidate('pwsh encoding').reason).toBe('project_excluded');
  });
  it('reports scope, quarantine, staleness, native context and source rejection', () => {
    seed(undefined, { name: 'foreign.md', project: 'path:other' });
    seed(undefined, { name: 'held.md', project: 'path:other', scope: 'machine', quarantine: 'command' });
    seed('Status\nPowerShell encoding', { name: 'status.md', mtime: '2000-01-01T00:00:00Z' });
    seed(undefined, { name: 'native.md', host: 'codex' });
    expect(candidate('pwsh encoding').diagnostics).toMatchObject({ outsideScope: 2, staleStatus: 1, nativeContext: 1, eligible: 0 });
    disableLessonSource('claude', 'synthetic');
    expect(candidate('pwsh encoding').diagnostics.disabledSource).toBe(3);
  });
  it('reports temporal changes and oversized indivisible notes without changing the store', () => {
    seed('PowerShell encoding '.repeat(150));
    expect(candidate('pwsh encoding').diagnostics.overBudget).toBe(1);
    getDb().prepare("UPDATE lessons SET created_at = '2020-01-01T00:00:00Z', updated_at = '2030-01-01T00:00:00Z'").run();
    const before = getDb().prepare('SELECT * FROM lessons').all();
    expect(candidate('pwsh encoding', Date.parse('2025-01-01')).diagnostics.changedSinceStart).toBe(1);
    expect(candidate('pwsh encoding', Date.parse('2010-01-01')).diagnostics.notYetAvailable).toBe(1);
    expect(getDb().prepare('SELECT * FROM lessons').all()).toEqual(before);
  });
  it('accounts for every candidate once and enforces the aggregate budget', () => {
    seed('PowerShell encoding ' + 'x '.repeat(600), { name: 'first.md' });
    seed('PowerShell encoding ' + 'y '.repeat(600), { name: 'second.md' });
    seed('PowerShell encoding ' + 'x '.repeat(600), { name: 'duplicate.md' });
    seed('postgres migration', { name: 'unrelated.md' });
    const result = candidate('pwsh encoding');
    expect(result.estimatedTokens).toBeLessThanOrEqual(500);
    const d = result.diagnostics;
    expect(d.selected + d.overBudget + d.duplicate + d.superseded + d.insufficientTerms).toBe(d.eligible);
    expect(d.selected).toBe(1);
    expect(d.overBudget).toBeGreaterThan(0);
  });
  it('preview prints counts only, with no note IDs, text, paths, or query', () => {
    seed();
    const lines: string[] = [];
    const code = runLessonsCommand(['preview', 'pwsh encoding'], { cwd: home, out: line => lines.push(line ?? '') });
    expect(code).toBe(0);
    const payload = JSON.parse(lines.join(''));
    expect(Object.keys(payload).sort()).toEqual(['counts', 'estimated_tokens', 'reason', 'selector']);
    expect(payload.counts.selected).toBe(1);
    expect(lines.join('')).not.toContain('PowerShell');
    expect(lines.join('')).not.toContain(home);
  });
});
