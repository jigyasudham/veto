import { describe, it, expect } from 'vitest';
import { runHandlerAgent, handlerAgentResponse } from '../../src/server/scan-core.js';
import type { AgentTask } from '../../src/agents/types.js';

// Note: no MCP server is registered in the test process, so executeOne cannot
// use Sampling. runHandlerAgent must therefore return the deterministic result
// AND attach an llm_upgrade offer — exactly the "sampling unavailable" path.

describe('runHandlerAgent — Phase 1 (no agent_response, sampling unavailable)', () => {
  it('returns a deterministic plan and offers an upgrade for a plan-type agent', async () => {
    const task: AgentTask = { id: 'g1', agent: 'devops', task: 'set up CI/CD' };
    const run = await runHandlerAgent('veto_env_setup', task);
    expect(run.result.plan).toBeDefined();
    expect(run.text).toBe(run.result.plan!.approach);
    expect(run.llm_upgrade?.available).toBe(true);
    expect(run.llm_upgrade?.prompt.agent).toBe('devops');
  });

  it('returns a deterministic analysis for an analysis-type agent given code', async () => {
    const task: AgentTask = { id: 'g2', agent: 'code-quality', task: 'audit', code: 'var x=1' };
    const run = await runHandlerAgent('veto_debt_register', task);
    expect(run.result.analysis).toBeDefined();
    expect(run.text).toBe(run.result.analysis!.summary);
    expect(run.llm_upgrade?.available).toBe(true);
  });
});

describe('runHandlerAgent — Phase 2 (agent_response supplied)', () => {
  it('parses a host-supplied plan and does NOT offer an upgrade', async () => {
    const task: AgentTask = { id: 'g3', agent: 'documentation', task: 'write release notes' };
    const agentResponse = {
      agent: 'documentation',
      task: 'write release notes',
      tier: 2,
      approach: 'Group commits by type and rewrite for users.',
      steps: ['Read the log', 'Group by type'],
      checklist: ['[ ] grouped'],
      pitfalls: ['jargon'],
      patterns: ['benefit-focused'],
      duration_estimate: '1 hour',
    };
    const run = await runHandlerAgent('veto_release_notes', task, agentResponse);
    expect(run.result.plan?.approach).toContain('Group commits');
    expect(run.text).toContain('Group commits');
    expect(run.llm_upgrade).toBeUndefined();
    expect(run.result.llm_backed).toBe(true);
  });

  it('parses a host-supplied analysis for an analysis-type agent', async () => {
    const task: AgentTask = { id: 'g4', agent: 'code-quality', task: 'audit', code: 'var x=1' };
    const agentResponse = {
      agent: 'code-quality',
      subject: 'src/foo.ts',
      findings: [{ severity: 'high', category: 'complexity', description: 'too complex', fix: 'split' }],
      score: 62,
      verdict: 'needs_revision',
      summary: 'One high finding.',
      critical_count: 0,
      high_count: 1,
    };
    const run = await runHandlerAgent('veto_debt_register', task, agentResponse);
    expect(run.result.analysis?.score).toBe(62);
    expect(run.text).toBe('One high finding.');
    expect(run.llm_upgrade).toBeUndefined();
  });
});

describe('handlerAgentResponse', () => {
  it('attaches llm_upgrade to the payload when present', () => {
    const run = { result: {} as any, text: '', llm_upgrade: { available: true as const, instruction: 'x', prompt: {} as any } };
    const resp = handlerAgentResponse({ foo: 1 }, run);
    const parsed = JSON.parse(resp.content[0].text);
    expect(parsed.foo).toBe(1);
    expect(parsed.llm_upgrade.available).toBe(true);
  });

  it('omits llm_upgrade when not present', () => {
    const resp = handlerAgentResponse({ foo: 1 }, { result: {} as any, text: '' });
    const parsed = JSON.parse(resp.content[0].text);
    expect(parsed.llm_upgrade).toBeUndefined();
  });
});
