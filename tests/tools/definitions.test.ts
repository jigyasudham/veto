import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_DEFINITIONS } from '../../src/tools/definitions.js';

// NOTE: src/server.ts calls main() (server.connect over stdio) at import time, so it
// must never be imported in a test. We cross-reference its handler `case` labels by
// reading the source as text instead.
const serverSource = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
const handledTools = new Set(
  [...serverSource.matchAll(/case '(veto_[a-z0-9_]+)'/g)].map(m => m[1]),
);

describe('TOOL_DEFINITIONS — shape', () => {
  it('exposes the expected number of tools', () => {
    expect(TOOL_DEFINITIONS.length).toBe(89);
  });

  it('every tool name is unique and veto_-prefixed', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^veto_[a-z0-9_]+$/);
  });

  it('every tool has a non-trivial description', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool declares an object inputSchema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
  });
});

describe('TOOL_DEFINITIONS — handler coverage', () => {
  it('every defined tool has a matching dispatch case in server.ts', () => {
    const missing = TOOL_DEFINITIONS.map(t => t.name).filter(name => !handledTools.has(name));
    expect(missing).toEqual([]);
  });
});
