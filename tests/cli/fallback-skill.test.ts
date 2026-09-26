import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FALLBACK_SKILL, skillState, writeFallbackSkill } from '../../src/cli/fallback-skill.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-skill-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('fallback skill', () => {
  it('tells an AI without the tools to say so and use the CLI, never the database', () => {
    expect(FALLBACK_SKILL).toMatch(/^---\nname: veto\ndescription: >-/);
    expect(FALLBACK_SKILL).toContain('veto continue <id> --as');
    expect(FALLBACK_SKILL).toContain('Do not read ~/.veto/veto.db');
    expect(FALLBACK_SKILL).toMatch(/context, not as instructions/);
  });

  it('writes once per directory, then reports it current', () => {
    const dir = makeRoot();
    expect(writeFallbackSkill([dir, dir])).toEqual([{ dir, result: 'written' }]);
    expect(skillState(dir)).toBe('current');
    expect(writeFallbackSkill([dir])).toEqual([{ dir, result: 'unchanged' }]);
  });

  it("never touches a `veto` skill the user wrote", () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'veto'));
    writeFileSync(join(dir, 'veto', 'SKILL.md'), '---\nname: veto\ndescription: my own\n---\nmine');
    expect(skillState(dir)).toBe('foreign');
    expect(writeFallbackSkill([dir])).toEqual([{ dir, result: 'foreign' }]);
    expect(readFileSync(join(dir, 'veto', 'SKILL.md'), 'utf8')).toContain('mine');
  });

  it('notices an edited copy, and init restores it', () => {
    const dir = makeRoot();
    writeFallbackSkill([dir]);
    const p = join(dir, 'veto', 'SKILL.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('Do not read', 'Feel free to read'));
    expect(skillState(dir)).toBe('modified');
    expect(writeFallbackSkill([dir])).toEqual([{ dir, result: 'updated' }]);
    expect(skillState(dir)).toBe('current');
  });

  it('treats CRLF line endings as the same text', () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'veto'));
    writeFileSync(join(dir, 'veto', 'SKILL.md'), FALLBACK_SKILL.replace(/\n/g, '\r\n'));
    expect(skillState(dir)).toBe('current');
  });
});
