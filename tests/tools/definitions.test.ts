import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../src/tools/definitions.js';
import { workerHandlers } from '../../src/server/handlers/workers.js';
import { memoryHandlers } from '../../src/server/handlers/memory.js';
import { observabilityHandlers } from '../../src/server/handlers/observability.js';
import { sessionHandlers } from '../../src/server/handlers/session.js';
import { learningHandlers } from '../../src/server/handlers/learning.js';
import { watchHandlers } from '../../src/server/handlers/watch.js';
import { devtoolsHandlers } from '../../src/server/handlers/devtools.js';
import { advisorHandlers } from '../../src/server/handlers/advisors.js';
import { generatorHandlers } from '../../src/server/handlers/generators.js';
import { gitHandlers } from '../../src/server/handlers/git.js';
import { reviewHandlers } from '../../src/server/handlers/review.js';
import { coreHandlers } from '../../src/server/handlers/core.js';
import { agentHandlers } from '../../src/server/handlers/agents.js';
import { councilHandlers } from '../../src/server/handlers/council.js';

// NOTE: src/server.ts calls main() (server.connect over stdio) at import time, so it
// must never be imported in a test. Every tool is now dispatched through the handler
// registry (the server.ts switch is gone), so coverage is the union of the per-domain
// handler maps — each new domain module MUST be added here.
const handledTools = new Set([
  ...Object.keys(workerHandlers),
  ...Object.keys(memoryHandlers),
  ...Object.keys(observabilityHandlers),
  ...Object.keys(sessionHandlers),
  ...Object.keys(learningHandlers),
  ...Object.keys(watchHandlers),
  ...Object.keys(devtoolsHandlers),
  ...Object.keys(advisorHandlers),
  ...Object.keys(generatorHandlers),
  ...Object.keys(gitHandlers),
  ...Object.keys(reviewHandlers),
  ...Object.keys(coreHandlers),
  ...Object.keys(agentHandlers),
  ...Object.keys(councilHandlers),
]);

describe('TOOL_DEFINITIONS — shape', () => {
  it('exposes the expected number of tools', () => {
    expect(TOOL_DEFINITIONS.length).toBe(93);
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
