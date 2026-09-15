import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeContextGuidance } from '../../src/cli/context-guidance.js';

const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'veto-context-guidance-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writeContextGuidance', () => {
  it('never creates or replaces native Gemini and Codex memory files', () => {
    const root = makeRoot();
    const geminiDir = join(root, '.gemini');
    const codexDir = join(root, '.codex');
    const project = join(root, 'project');
    mkdirSync(geminiDir);
    mkdirSync(codexDir);
    mkdirSync(project);
    const geminiMemory = join(geminiDir, 'GEMINI.md');
    const codexOverride = join(codexDir, 'AGENTS.override.md');
    writeFileSync(geminiMemory, 'Gemini memory');
    writeFileSync(codexOverride, 'Codex memory');

    const result = writeContextGuidance({ cwd: project, geminiDir, codexDir, guide: 'Veto guide' });

    expect(readFileSync(geminiMemory, 'utf8')).toBe('Gemini memory');
    expect(readFileSync(codexOverride, 'utf8')).toBe('Codex memory');
    expect(result).toMatchObject({ geminiMemorySkipped: true, codexOverrideSkipped: true, projectAgents: 'created' });
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('Veto guide');
  });

  it('does not create native memory files when they do not exist', () => {
    const root = makeRoot();
    const geminiDir = join(root, '.gemini');
    const codexDir = join(root, '.codex');
    const project = join(root, 'project');
    mkdirSync(geminiDir);
    mkdirSync(codexDir);
    mkdirSync(project);

    writeContextGuidance({ cwd: project, geminiDir, codexDir, guide: 'Veto guide' });

    expect(existsSync(join(geminiDir, 'GEMINI.md'))).toBe(false);
    expect(existsSync(join(codexDir, 'AGENTS.override.md'))).toBe(false);
  });
});
