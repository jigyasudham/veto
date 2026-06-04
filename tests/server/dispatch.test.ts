import { describe, it, expect, beforeEach } from 'vitest';
import { callTool } from '../../src/server.js';
import { resetDb } from '../../src/memory/local.js';

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

describe('dispatch — migrated worker tools route through the registry', () => {
  it('veto_code_review returns the agentic_fallback envelope', async () => {
    const b = body(await call('veto_code_review', { task: 'review', code: 'const x = 1' }));
    expect(b.mode).toBe('agentic_fallback');
  });
});

describe('dispatch — error handling', () => {
  it('throws on an unknown tool name', async () => {
    await expect(call('veto_not_a_tool')).rejects.toThrow(/unknown tool/i);
  });
});
