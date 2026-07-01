import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeadNodePathEntry } from '../../src/cli/claude-repair.js';

describe('isDeadNodePathEntry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'veto-repair-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a node entry whose script no longer exists', () => {
    const entry = { command: 'node', args: [join(dir, 'gone', 'server.js')] };
    expect(isDeadNodePathEntry(entry)).toBe(true);
  });

  it('does NOT flag a node entry whose script still exists', () => {
    const script = join(dir, 'server.js');
    writeFileSync(script, '// present');
    expect(isDeadNodePathEntry({ command: 'node', args: [script] })).toBe(false);
  });

  it('does NOT flag an npx-based entry (the canonical form)', () => {
    const entry = { command: 'npx.cmd', args: ['-y', '--package', '@jigyasudham/veto@latest', 'veto-server'] };
    expect(isDeadNodePathEntry(entry)).toBe(false);
  });

  it('does NOT flag a node entry with no .js argument', () => {
    expect(isDeadNodePathEntry({ command: 'node', args: ['--version'] })).toBe(false);
  });

  it('handles undefined / empty entries safely', () => {
    expect(isDeadNodePathEntry(undefined)).toBe(false);
    expect(isDeadNodePathEntry({})).toBe(false);
    expect(isDeadNodePathEntry({ command: 'node' })).toBe(false);
  });
});
