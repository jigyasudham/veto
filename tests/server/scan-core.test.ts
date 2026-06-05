import { describe, it, expect, beforeEach } from 'vitest';
import { readGitDiff, finalizeTripleScan, handleAgenticWorker, runTripleScan } from '../../src/server/scan-core.js';
import { resetDb } from '../../src/memory/local.js';
import type { AgentResult, AgentAnalysis, WorkerAgentType } from '../../src/agents/types.js';

beforeEach(() => resetDb()); // finalizeTripleScan/runTripleScan record outcomes to SQLite

function analysis(partial: Partial<AgentAnalysis>): AgentAnalysis {
  return {
    agent: 'reviewer', subject: 's', findings: [], score: 90,
    verdict: 'approved', summary: 'ok', critical_count: 0, high_count: 0, ...partial,
  };
}
function result(agent: WorkerAgentType, a: AgentAnalysis): AgentResult {
  return { id: agent, agent, analysis: a, output: { confidence: a.score / 100, severity: 'info', recommendation: '', affected_files: [], line_refs: [] }, duration_ms: 1 };
}

describe('finalizeTripleScan verdict', () => {
  it('passes when all scans are clean', () => {
    const r = finalizeTripleScan(
      result('reviewer', analysis({})),
      result('security-scanner', analysis({})),
      result('secrets', analysis({})),
    );
    expect(r.verdict).toBe('pass');
  });

  it('warns when there are high-severity findings but nothing critical', () => {
    const r = finalizeTripleScan(
      result('reviewer', analysis({ high_count: 2 })),
      result('security-scanner', analysis({})),
      result('secrets', analysis({})),
    );
    expect(r.verdict).toBe('warn');
  });

  it('fails when any scan has a critical finding', () => {
    const r = finalizeTripleScan(
      result('reviewer', analysis({})),
      result('security-scanner', analysis({ critical_count: 1 })),
      result('secrets', analysis({})),
    );
    expect(r.verdict).toBe('fail');
  });
});

describe('handleAgenticWorker (no MCP Sampling available in tests)', () => {
  it('returns an agentic_fallback envelope with an llm_upgrade prompt', async () => {
    const res = await handleAgenticWorker('veto_code_review', { task: 'review x' }, 'reviewer', 'Review.');
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe('agentic_fallback');
    expect(body.llm_backed).toBe(false);
    expect(body.llm_upgrade.available).toBe(true);
    expect(body.llm_upgrade.prompt.agent).toBe('reviewer');
  });

  it('parses a host-supplied agent_response and marks it llm_backed', async () => {
    const agent_response = { agent: 'coder', task: 'x', tier: 1, approach: 'a', steps: [], checklist: [], pitfalls: [], patterns: [], duration_estimate: '1h' };
    const res = await handleAgenticWorker('veto_agent_plan', { task: 'x', agent_response }, 'coder', 'Plan.');
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe('agentic_fallback');
    expect(body.llm_backed).toBe(true);
    expect(body.approach).toBe('a'); // payload merged at top level
  });
});

describe('runTripleScan', () => {
  it('returns an agentic_loop prompt set when sampling is unavailable', async () => {
    const out = await runTripleScan('diff --git a/x b/x\n+code', 'ctx');
    expect('mode' in out && out.mode).toBe('agentic_loop');
    expect('prompts' in out && out.prompts.length).toBe(3);
  });

  it('finalizes a verdict when agent_outputs are supplied', async () => {
    const agent_outputs = {
      'scan-review':  { score: 95, verdict: 'approved', findings: [], summary: 'ok', critical_count: 0, high_count: 0 },
      'scan-sec':     { score: 95, verdict: 'approved', findings: [], summary: 'ok', critical_count: 0, high_count: 0 },
      'scan-secrets': { score: 100, verdict: 'approved', findings: [], summary: 'ok', critical_count: 0, high_count: 0 },
    };
    const out = await runTripleScan('diff', 'ctx', true, agent_outputs);
    expect('verdict' in out && out.verdict).toBe('pass');
  });
});

describe('readGitDiff', () => {
  it('returns empty string when no project dir is given', () => {
    expect(readGitDiff(undefined)).toBe('');
  });
});
