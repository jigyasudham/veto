import { describe, it, expect } from 'vitest';
import {
  parsePlanResponse,
  parseAnalysisResponse,
  buildAgenticAgentPrompt,
  parseAgenticAgentResponses,
} from '../../src/agents/llm-runner.js';
import type { AgentTask, WorkerAgentType } from '../../src/agents/types.js';

describe('parsePlanResponse', () => {
  const validPlan = JSON.stringify({
    agent: 'coder',
    task: 'build login',
    tier: 2,
    approach: 'Use middleware-based auth with a clear separation of concerns.',
    steps: ['define routes', 'add handler'],
    checklist: ['[ ] tokens expire'],
    pitfalls: ['no refresh rotation'],
    patterns: ['middleware'],
    duration_estimate: '2-4 hours',
  });

  it('parses a clean JSON plan and forces the agent id', () => {
    const plan = parsePlanResponse(validPlan, 'coder', 'build login');
    expect(plan).not.toBeNull();
    expect(plan!.agent).toBe('coder');
    expect(plan!.tier).toBe(2);
    expect(plan!.steps).toContain('define routes');
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const wrapped = `Here is the plan you asked for:\n${validPlan}\nHope that helps!`;
    const plan = parsePlanResponse(wrapped, 'coder', 'build login');
    expect(plan).not.toBeNull();
    expect(plan!.approach.length).toBeGreaterThan(0);
  });

  it('defaults an out-of-range tier to 2', () => {
    const plan = parsePlanResponse(JSON.stringify({ tier: 9, approach: 'x' }), 'coder', 't');
    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe(2);
  });

  it('returns null for non-JSON garbage', () => {
    expect(parsePlanResponse('the model refused to answer', 'coder', 't')).toBeNull();
  });

  // Every field in planSchema has a default and a .catch(), so Zod accepts
  // even `{}`. Without a substance check these become a confident plan made
  // entirely of defaults.
  it('returns null for valid JSON that is not a plan', () => {
    const wrongShape = JSON.stringify({ agent: 'reviewer', status: 'complete', findings: ['x'], risk: 'low', verdict: 'sound' });
    expect(parsePlanResponse(wrongShape, 'reviewer', 't')).toBeNull();
  });

  it('returns null for an empty object rather than inventing a plan', () => {
    expect(parsePlanResponse('{}', 'coder', 't')).toBeNull();
  });

  it('returns null when every field is present but empty', () => {
    const hollow = JSON.stringify({ agent: 'coder', task: 't', tier: 2, approach: '   ', steps: [], checklist: [], pitfalls: [], patterns: [] });
    expect(parsePlanResponse(hollow, 'coder', 't')).toBeNull();
  });

  it('still accepts a plan carrying only steps', () => {
    const plan = parsePlanResponse(JSON.stringify({ steps: ['do the thing'] }), 'coder', 't');
    expect(plan).not.toBeNull();
    expect(plan!.steps).toEqual(['do the thing']);
  });

  it('returns null for an empty string', () => {
    expect(parsePlanResponse('', 'coder', 't')).toBeNull();
  });
});

describe('parseAnalysisResponse', () => {
  const validAnalysis = JSON.stringify({
    agent: 'reviewer',
    subject: 'auth.ts',
    findings: [
      { severity: 'high', category: 'security', description: 'missing input validation', fix: 'validate input' },
    ],
    score: 72,
    verdict: 'approved_with_warnings',
    summary: 'mostly fine',
    critical_count: 0,
    high_count: 1,
  });

  it('parses a clean JSON analysis and forces the agent id', () => {
    const a = parseAnalysisResponse(validAnalysis, 'reviewer');
    expect(a).not.toBeNull();
    expect(a!.agent).toBe('reviewer');
    expect(a!.findings).toHaveLength(1);
    expect(a!.score).toBe(72);
  });

  it('clamps an out-of-range score into [0, 100]', () => {
    const a = parseAnalysisResponse(JSON.stringify({ score: 150, verdict: 'approved' }), 'reviewer');
    expect(a).not.toBeNull();
    expect(a!.score).toBeGreaterThanOrEqual(0);
    expect(a!.score).toBeLessThanOrEqual(100);
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseAnalysisResponse('no analysis available', 'reviewer')).toBeNull();
  });

  // The invented defaults here are score 70 and verdict
  // approved_with_warnings, so an unparseable security scan would otherwise
  // report as broadly passing with nothing found.
  it('refuses to invent a passing verdict from a response of the wrong shape', () => {
    const wrongShape = JSON.stringify({ agent: 'security-scanner', approach: 'I looked at it', steps: ['read the file'] });
    expect(parseAnalysisResponse(wrongShape, 'security-scanner')).toBeNull();
  });

  it('treats an empty findings array as a real result, because clean code has none', () => {
    const clean = parseAnalysisResponse(JSON.stringify({ findings: [] }), 'reviewer');
    expect(clean).not.toBeNull();
    expect(clean!.findings).toEqual([]);
  });
});

describe('buildAgenticAgentPrompt', () => {
  it('builds an agentic prompt for a known plan agent', () => {
    const task: AgentTask = { id: 'p1', agent: 'coder', task: 'build a parser' };
    const prompt = buildAgenticAgentPrompt(task);
    expect(prompt).not.toBeNull();
    expect(prompt!.mode).toBe('agentic');
    expect(prompt!.agent).toBe('coder');
    expect(prompt!.instruction.length).toBeGreaterThan(0);
    expect(prompt!.output_prompt).toContain('build a parser');
    expect(prompt!.schema.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown agent', () => {
    const task: AgentTask = { id: 'p2', agent: 'ghost-agent' as WorkerAgentType, task: 'x' };
    expect(buildAgenticAgentPrompt(task)).toBeNull();
  });
});

describe('parseAgenticAgentResponses', () => {
  it('parses a host-supplied plan keyed by task id and marks it llm_backed', () => {
    const tasks: AgentTask[] = [{ id: 'a1', agent: 'coder', task: 'build login' }];
    const responses = {
      a1: { agent: 'coder', task: 'build login', tier: 1, approach: 'simple', steps: ['s1'], checklist: [], pitfalls: [], patterns: [], duration_estimate: '1h' },
    };
    const results = parseAgenticAgentResponses(tasks, responses);
    expect(results).toHaveLength(1);
    expect(results[0].llm_backed).toBe(true);
    expect(results[0].plan).toBeDefined();
    expect(results[0].error).toBeUndefined();
  });

  it('reports a shape mismatch as a visible error, never as an empty result', () => {
    const tasks: AgentTask[] = [{ id: 'r1', agent: 'reviewer', task: 'review the diff' }];
    // The shape a reviewer naturally produces when asked to review rather than plan.
    const responses = { r1: { agent: 'reviewer', status: 'complete', findings: ['a real finding'], risk: 'low' } };

    const results = parseAgenticAgentResponses(tasks, responses);

    expect(results[0].plan).toBeUndefined();
    expect(results[0].error).toContain('not a plan');
    // The error names what arrived, so the mismatch is diagnosable from it alone.
    expect(results[0].error).toContain('findings');
  });

  it('produces an error result when a task has no response', () => {
    const tasks: AgentTask[] = [{ id: 'missing', agent: 'coder', task: 'x' }];
    const results = parseAgenticAgentResponses(tasks, {});
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeDefined();
    expect(results[0].output).toBeDefined();
  });
});
