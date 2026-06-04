import { describe, it, expect } from 'vitest';
import { executeOne, executeParallel } from '../../src/agents/executor.js';
import { AGENT_MANIFEST } from '../../src/agents/manifest.js';
import type { AgentTask, WorkerAgentType } from '../../src/agents/types.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const ANALYSIS_AGENTS = AGENT_MANIFEST.filter(a => a.output_type === 'analysis');

function expectValidOutput(output: { confidence: number; severity: string }) {
  expect(typeof output.confidence).toBe('number');
  expect(output.confidence).toBeGreaterThanOrEqual(0);
  expect(output.confidence).toBeLessThanOrEqual(1);
  expect(SEVERITIES).toContain(output.severity);
}

describe('executeOne — deterministic plan path (every manifest agent)', () => {
  for (const entry of AGENT_MANIFEST) {
    it(`${entry.id} returns a schema-valid plan with no error`, async () => {
      const task: AgentTask = {
        id: `${entry.id}-plan`,
        agent: entry.id,
        task: 'Implement user authentication with JWT access and refresh tokens',
      };
      const r = await executeOne(task);

      expect(r.error).toBeUndefined();
      expect(r.id).toBe(task.id);
      expect(r.agent).toBe(entry.id);
      expect(r.llm_backed).toBe(false);
      expectValidOutput(r.output);

      // No code + no LLM => executor always takes the plan() path
      expect(r.plan).toBeDefined();
      expect(r.plan!.agent).toBe(entry.id);
      expect([1, 2, 3]).toContain(r.plan!.tier);
      expect(Array.isArray(r.plan!.steps)).toBe(true);
      expect(Array.isArray(r.plan!.checklist)).toBe(true);
      expect(typeof r.plan!.approach).toBe('string');
    });
  }
});

describe('executeOne — deterministic analyze path (analysis-type agents)', () => {
  for (const entry of ANALYSIS_AGENTS) {
    it(`${entry.id} returns a schema-valid analysis when given code`, async () => {
      const task: AgentTask = {
        id: `${entry.id}-analyze`,
        agent: entry.id,
        task: 'review this',
        code: 'function add(a, b) {\n  var x = a + b\n  return x\n}\n',
      };
      const r = await executeOne(task);

      expect(r.error).toBeUndefined();
      expect(r.agent).toBe(entry.id);
      expect(r.llm_backed).toBe(false);
      expectValidOutput(r.output);

      expect(r.analysis).toBeDefined();
      expect(r.analysis!.agent).toBe(entry.id);
      expect(r.analysis!.score).toBeGreaterThanOrEqual(0);
      expect(r.analysis!.score).toBeLessThanOrEqual(100);
      expect(['approved', 'approved_with_warnings', 'needs_revision', 'rejected']).toContain(r.analysis!.verdict);
      expect(Array.isArray(r.analysis!.findings)).toBe(true);
      expect(typeof r.analysis!.critical_count).toBe('number');
      expect(typeof r.analysis!.high_count).toBe('number');
    });
  }
});

describe('executeParallel', () => {
  it('returns one result per task, preserving ids and agents', async () => {
    const tasks: AgentTask[] = [
      { id: 't1', agent: 'coder', task: 'add a REST endpoint' },
      { id: 't2', agent: 'tester', task: 'write unit tests' },
      { id: 't3', agent: 'reviewer', task: 'review', code: 'const x=1' },
    ];
    const results = await executeParallel(tasks);
    expect(results).toHaveLength(3);
    expect(results.map(r => r.id)).toEqual(['t1', 't2', 't3']);
    expect(results.map(r => r.agent)).toEqual(['coder', 'tester', 'reviewer']);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.output).toBeDefined();
    }
  });

  it('returns an empty array for no tasks', async () => {
    expect(await executeParallel([])).toEqual([]);
  });
});

describe('executeOne — error handling', () => {
  it('returns an error result (does not throw) for an unknown agent', async () => {
    const task: AgentTask = { id: 'bad', agent: 'not-a-real-agent' as WorkerAgentType, task: 'x' };
    const r = await executeOne(task);
    expect(r.error).toBeDefined();
    expect(r.id).toBe('bad');
    expect(r.output).toBeDefined();
    expect(r.output.confidence).toBe(0);
  });
});
