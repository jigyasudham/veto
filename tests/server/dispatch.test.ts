import { describe, it, expect, beforeEach } from 'vitest';
import { callTool } from '../../src/server.js';
import { resetDb } from '../../src/memory/local.js';
import scanFixtures from './fixtures/scan-agent-outputs.json';

const SAMPLE_DIFF = 'diff --git a/src/handlers/admin.ts b/src/handlers/admin.ts\n+const x = 1';

// Behavioral safety net for the server.ts handler migration. callTool is the real
// dispatch (registry + switch); importing server.ts no longer connects stdio.
beforeEach(() => resetDb());

function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return callTool({ params: { name, arguments: args } });
}
function body(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('dispatch — read-only status handlers return parseable JSON', () => {
  for (const name of ['veto_status', 'veto_health', 'veto_rate_status', 'veto_learning_stats', 'veto_patterns_list', 'veto_usage_status']) {
    it(`${name} returns a JSON text payload`, async () => {
      const res = await call(name);
      expect(res.content?.[0]?.type).toBe('text');
      expect(() => body(res)).not.toThrow();
    });
  }

  it('veto_status reports running + a version', async () => {
    const b = body(await call('veto_status'));
    expect(b.status).toBe('running');
    expect(typeof b.version).toBe('string');
  });
});

describe('dispatch — router', () => {
  it('veto_route_task scores complexity and selects a model', async () => {
    const b = body(await call('veto_route_task', { task: 'Add a JWT login endpoint with refresh tokens and rate limiting' }));
    expect(b.complexity).toBeDefined();
    expect(b.model).toBeDefined();
  });
});

describe('dispatch — memory round-trip', () => {
  it('stores then finds a knowledge entry', async () => {
    await call('veto_memory_store', { type: 'solution', title: 'Fix flaky test', content: 'await the promise', tags: ['testing'] });
    const b = body(await call('veto_memory_search', { query: 'flaky' }));
    const text = JSON.stringify(b);
    expect(text).toContain('Fix flaky test');
  });
});

describe('dispatch — learning', () => {
  it('records an outcome and reflects it in stats', async () => {
    const rec = body(await call('veto_record_outcome', { task_type: 'fix-bug', complexity: 30, model_tier: 1, agent: 'debugger', output_quality: 85 }));
    expect(rec.success).toBe(true);
    const stats = body(await call('veto_learning_stats'));
    expect(stats.total_outcomes).toBe(1);
  });
});

describe('dispatch — session round-trip', () => {
  it('saves then restores a session by id', async () => {
    const saved = body(await call('veto_session_save', { summary: 'mid-migration', context: 'registry work', platform: 'claude' }));
    expect(saved.success).toBe(true);
    expect(typeof saved.session_id).toBe('string');
    const restored = body(await call('veto_session_restore', { session_id: saved.session_id }));
    expect(restored.success).toBe(true);
    expect(restored.summary).toBe('mid-migration');
  });

  it('veto_continue restores the most recent session', async () => {
    await call('veto_session_save', { summary: 'latest one', context: 'ctx', platform: 'claude' });
    // veto_continue prefixes a human message before the JSON payload, so parse the JSON tail.
    const res = await call('veto_continue', {});
    const cont = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf('{')));
    expect(cont.summary).toBe('latest one');
  });

  it('veto_sessions_list returns saved sessions', async () => {
    await call('veto_session_save', { summary: 'listed', context: 'ctx' });
    const list = body(await call('veto_sessions_list', {}));
    expect(list.count).toBeGreaterThanOrEqual(1);
  });
});

describe('dispatch — migrated worker tools route through the registry', () => {
  it('veto_code_review returns the agentic_fallback envelope', async () => {
    const b = body(await call('veto_code_review', { task: 'review', code: 'const x = 1' }));
    expect(b.mode).toBe('agentic_fallback');
  });
});

// Some handlers prefix a human-readable message before their JSON payload.
function tailJson(res: any): any {
  const text = res.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf('{')));
}

describe('dispatch — council', () => {
  it('veto_council_debate returns a deterministic verdict + llm_upgrade path', async () => {
    // No MCP sampling transport in tests, so the 7-agent debate falls back to deterministic.
    const b = tailJson(await call('veto_council_debate', { task: 'Add a caching layer in front of the user service' }));
    expect(b.llm_backed).toBe(false);
    expect(['GREEN', 'YELLOW', 'RED', 'DEADLOCK']).toContain(b.final_verdict);
    expect(b.llm_upgrade?.available).toBe(true);
    // Keyword rules only (no sampling): labelled as such and NOT recorded — no
    // council_outcomes row for the status line/HUD, no memory "decision".
    expect(b.outcome_id).toBeNull();
    expect(b.verdict_basis).toMatch(/keyword rules only/);
  });

  it('a rules-only verdict leaves no council row and no stored decision behind', async () => {
    const { getDb } = await import('../../src/memory/local.js');
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM council_outcomes').get() as { n: number }).n;
    const kbBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_base WHERE type = 'decision'").get() as { n: number }).n;
    const text = (await call('veto_council_debate', { task: 'Store user passwords with md5 and expose admin auth over http' })).content[0].text as string;
    expect(text.startsWith('⚠  PRELIMINARY')).toBe(true);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM council_outcomes').get() as { n: number }).n).toBe(before);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_base WHERE type = 'decision'").get() as { n: number }).n).toBe(kbBefore);
  });

  it('veto_council_debate requires a task', async () => {
    const b = body(await call('veto_council_debate', {}));
    expect(b.success).toBe(false);
  });

  // The schema asks for an object, but a model told to "generate the JSON"
  // often sends the JSON as text. That used to fall through to phase 1, so the
  // caller's seven analyses disappeared and a deterministic verdict came back
  // looking like the answer.
  it('veto_council_debate accepts agent_responses sent as a JSON string', async () => {
    const V = { verdict: 'approve', reason: 'fine' };
    const votes = { lead_dev: V, pm: V, architect: V, ux: V, devil: { verdict: 'warn', reason: 'careful' }, legal: V, security: V };
    const b = tailJson(await call('veto_council_debate', { task: 'Add a caching layer', agent_responses: JSON.stringify(votes) }));
    expect(b.llm_backed).toBe(true);
    expect(b.votes.devil.reason).toBe('careful');
  });

  it('veto_council_debate still accepts agent_responses as an object', async () => {
    const V = { verdict: 'approve', reason: 'fine' };
    const votes = { lead_dev: V, pm: V, architect: V, ux: V, devil: { verdict: 'warn', reason: 'careful' }, legal: V, security: V };
    const b = tailJson(await call('veto_council_debate', { task: 'Add a caching layer', agent_responses: votes }));
    expect(b.llm_backed).toBe(true);
  });

  it('veto_council_debate reports unusable agent_responses instead of silently redoing phase 1', async () => {
    const res: any = await call('veto_council_debate', { task: 'Add a caching layer', agent_responses: 'I could not produce the JSON' });
    expect(res.isError).toBe(true);
    const b = tailJson(res);
    expect(b.error).toContain('could not be read');
    expect(b.received).toContain('string');
    expect(b.llm_backed).toBeUndefined();
  });
});

describe('dispatch — review pipelines', () => {
  it('veto_ci_gate short-circuits to pass when there are no changes', async () => {
    const b = body(await call('veto_ci_gate', { project_dir: process.cwd(), diff: '   ' }));
    expect(b.verdict).toBe('pass');
    expect(b.exit_code).toBe(0);
  });

  it('veto_ci_gate runs the triple scan over a provided diff', async () => {
    // Without sampling the scan returns the agentic-loop envelope rather than a verdict.
    const b = body(await call('veto_ci_gate', { project_dir: process.cwd(), diff: 'diff --git a/x.ts b/x.ts\n+const x = 1' }));
    expect(b.mode).toBe('agentic_loop');
    expect(Array.isArray(b.prompts)).toBe(true);
  });

  it('veto_diff_review reads a provided diff and dispatches the scan', async () => {
    const b = body(await call('veto_diff_review', { diff: 'diff --git a/y.ts b/y.ts\n+const y = 2' }));
    expect(b.mode).toBe('agentic_loop');
  });

  it('veto_diff_review errors when no diff is available', async () => {
    const b = body(await call('veto_diff_review', {}));
    expect(b.success).toBe(false);
  });
});

// Pre-baked Phase-2 agent_outputs short-circuit the agentic loop and let the
// review pipelines resolve to real pass/warn/fail verdicts without MCP sampling.
describe('dispatch — review pipelines driven by pre-baked agent_outputs', () => {
  const PROJECT_DIR = process.cwd();

  describe('veto_diff_review', () => {
    it('reaches a pass verdict on the clean fixture', async () => {
      const b = body(await call('veto_diff_review', { diff: SAMPLE_DIFF, agent_outputs: scanFixtures.clean }));
      expect(b.verdict).toBe('pass');
    });

    it('reaches a fail verdict on the failing fixture', async () => {
      const b = body(await call('veto_diff_review', { diff: SAMPLE_DIFF, agent_outputs: scanFixtures.failing }));
      expect(b.verdict).toBe('fail');
      expect(b.security.critical).toBe(1);
      expect(b.secrets.findings.length).toBeGreaterThan(0);
    });

    it('reaches a warn verdict when there are high-severity findings only', async () => {
      const b = body(await call('veto_diff_review', { diff: SAMPLE_DIFF, agent_outputs: scanFixtures.warn }));
      expect(b.verdict).toBe('warn');
    });
  });

  describe('veto_ci_gate', () => {
    it('passes with exit_code 0 on the clean fixture', async () => {
      const b = body(await call('veto_ci_gate', { project_dir: PROJECT_DIR, diff: SAMPLE_DIFF, agent_outputs: scanFixtures.clean }));
      expect(b.verdict).toBe('pass');
      expect(b.exit_code).toBe(0);
    });

    it('fails with exit_code 1 and blocking issues on the failing fixture', async () => {
      const b = body(await call('veto_ci_gate', { project_dir: PROJECT_DIR, diff: SAMPLE_DIFF, agent_outputs: scanFixtures.failing }));
      expect(b.verdict).toBe('fail');
      expect(b.exit_code).toBe(1);
      expect(b.blocking_issues.length).toBeGreaterThan(0);
      expect(b.checks.secrets.clean).toBe(false);
    });
  });

  describe('veto_full_review', () => {
    it('does not block (pass/warn) on the clean fixture', async () => {
      const b = body(await call('veto_full_review', { diff: SAMPLE_DIFF, agent_outputs: scanFixtures.clean }));
      expect(['pass', 'warn']).toContain(b.verdict);
    });

    it('reaches a fail verdict on the failing fixture', async () => {
      const b = body(await call('veto_full_review', { diff: SAMPLE_DIFF, agent_outputs: scanFixtures.failing }));
      expect(b.verdict).toBe('fail');
      expect(b.scans.security.critical).toBe(1);
    });
  });

  describe('veto_pre_commit', () => {
    it('passes and is not blocked on the clean fixture', async () => {
      const b = body(await call('veto_pre_commit', { project_dir: PROJECT_DIR, agent_outputs: scanFixtures.clean }));
      expect(b.verdict).toBe('pass');
      expect(b.blocked).toBe(false);
    });

    it('blocks the commit when the fixture exposes secrets', async () => {
      const b = body(await call('veto_pre_commit', { project_dir: PROJECT_DIR, agent_outputs: scanFixtures.failing }));
      expect(b.verdict).toBe('fail');
      expect(b.blocked).toBe(true);
      expect(b.secrets.found).toBe(true);
    });
  });
});

describe('dispatch — error handling', () => {
  it('throws on an unknown tool name', async () => {
    await expect(call('veto_not_a_tool')).rejects.toThrow(/unknown tool/i);
  });
});
