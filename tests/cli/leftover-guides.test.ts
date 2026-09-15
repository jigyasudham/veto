import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHIPPED_GUIDE_SHA256, findLeftoverGuides, leftoverGuideInstruction, moveAsideLeftoverGuides,
} from '../../src/cli/leftover-guides.js';

// The guide `veto init` 3.3.0 wrote, taken byte for byte from git (v3.3.0:src/cli.ts).
// LF-normalized: a Windows checkout may have converted the fixture to CRLF.
const GUIDE = readFileSync(join(__dirname, 'fixtures', 'veto-guide-3.3.0.md'), 'utf8').replace(/\r\n/g, '\n');

const roots: string[] = [];
function home(): { home: string; codex: string; gemini: string } {
  const h = mkdtempSync(join(tmpdir(), 'veto-leftover-'));
  roots.push(h);
  mkdirSync(join(h, '.codex'));
  mkdirSync(join(h, '.gemini'));
  return { home: h, codex: join(h, '.codex', 'AGENTS.override.md'), gemini: join(h, '.gemini', 'GEMINI.md') };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('leftover Veto guides', () => {
  it('the fixture is one of the shipped guides', () => {
    expect(SHIPPED_GUIDE_SHA256.has(createHash('sha256').update(GUIDE).digest('hex'))).toBe(true);
    expect(SHIPPED_GUIDE_SHA256.size).toBe(8);
  });

  it("renames a Veto-only AGENTS.override.md, which brings back the user's AGENTS.md", () => {
    const h = home();
    writeFileSync(h.codex, GUIDE);
    writeFileSync(join(h.home, '.codex', 'AGENTS.md'), 'My own global rules');

    const result = moveAsideLeftoverGuides(h.home);

    expect(result.moved).toEqual([expect.objectContaining({ host: 'codex', kind: 'exact', backupPath: `${h.codex}.veto-backup` })]);
    expect(existsSync(h.codex)).toBe(false);
    expect(readFileSync(`${h.codex}.veto-backup`, 'utf8')).toBe(GUIDE);
    expect(readFileSync(join(h.home, '.codex', 'AGENTS.md'), 'utf8')).toBe('My own global rules');
  });

  it('recognises a guide whose line endings or BOM were changed', () => {
    const h = home();
    writeFileSync(h.gemini, `\uFEFF${GUIDE.replace(/\n/g, '\r\n')}`);
    expect(moveAsideLeftoverGuides(h.home).moved).toHaveLength(1);
  });

  it('never moves a guide that has anything else in the file', () => {
    const h = home();
    const withMemories = `${GUIDE}\n## Gemini Added Memories\n- The user deploys on Fridays only.\n`;
    writeFileSync(h.gemini, withMemories);
    const edited = GUIDE.replace('93 tools', '93 tools, plus my notes');
    writeFileSync(h.codex, edited);

    const result = moveAsideLeftoverGuides(h.home);

    expect(result.moved).toEqual([]);
    expect(result.kept.map(g => [g.host, g.kind])).toEqual([['codex', 'embedded'], ['gemini', 'embedded']]);
    expect(readFileSync(h.gemini, 'utf8')).toBe(withMemories);
    expect(readFileSync(h.codex, 'utf8')).toBe(edited);
  });

  it("ignores the user's own files and guides anywhere else", () => {
    const h = home();
    writeFileSync(h.gemini, '## Gemini Added Memories\n- Prefers tabs.\n');
    writeFileSync(join(h.home, '.codex', 'AGENTS.md'), GUIDE);
    expect(findLeftoverGuides(h.home)).toEqual([]);
  });

  it('keeps an earlier backup and picks a new name', () => {
    const h = home();
    writeFileSync(`${h.codex}.veto-backup`, 'earlier backup');
    writeFileSync(h.codex, GUIDE);

    const [moved] = moveAsideLeftoverGuides(h.home, new Date('2026-09-15T10:20:30.000Z')).moved;

    expect(moved.backupPath).toBe(`${h.codex}.veto-backup-20260915T102030`);
    expect(readFileSync(`${h.codex}.veto-backup`, 'utf8')).toBe('earlier backup');
  });
});

describe('startup cleanup tip', () => {
  it('is absent when there is nothing to clean up', () => {
    expect(leftoverGuideInstruction(home().home)).toBeUndefined();
  });

  it('offers doctor --fix for a Veto-only copy', () => {
    const h = home();
    writeFileSync(h.codex, GUIDE);
    const tip = leftoverGuideInstruction(h.home)!;
    expect(tip).toMatch(/^CLEANUP TIP/);
    expect(tip).toContain('~/.codex/AGENTS.override.md');
    expect(tip).toContain('veto doctor --fix');
    expect(tip).toContain('Do not run it unless the user agrees');
  });

  it('only describes a guide mixed with the user\'s content, and offers no command', () => {
    const h = home();
    writeFileSync(h.gemini, `${GUIDE}\n## Gemini Added Memories\n- A fact.\n`);
    const tip = leftoverGuideInstruction(h.home)!;
    expect(tip).toContain('by hand');
    expect(tip).not.toContain('doctor --fix');
  });
});
