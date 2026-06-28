import { describe, it, expect, beforeEach } from 'vitest';
import { callTool } from '../../src/server.js';
import { resetDb, saveSession, upsertPattern, saveCouncilOutcome, storeKnowledge } from '../../src/memory/local.js';

beforeEach(() => resetDb());

function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return callTool({ params: { name, arguments: args } });
}
function body(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('veto_snapshot', () => {
  it('returns the full aggregate shape on an empty DB (nulls, not crashes)', async () => {
    const b = body(await call('veto_snapshot'));
    expect(b.success).toBe(true);
    expect(b.session).toBeNull();
    expect(b.council).toBeNull();
    expect(b.routerTop).toEqual([]);
    expect(Array.isArray(b.rate)).toBe(true);
    expect(b.rate.map((r: any) => r.platform)).toEqual(['claude', 'gemini', 'codex', 'antigravity']);
    expect(b.memoryCount).toBe(0);
    expect(b.health.status).toBe('healthy');
  });

  it('reflects session, council, patterns and memory once populated', async () => {
    const { session_id } = saveSession({ summary: 'wiring snapshot', platform: 'claude' });
    saveCouncilOutcome({
      session_id, task: 'ship veto_snapshot', verdict: 'GREEN',
      lead_dev: 'ok', pm: 'ok', architect: 'ok', ux: 'ok', devil: 'ok', legal: 'ok', security: 'ok',
      recommended: 'proceed',
    });
    upsertPattern({ pattern_key: 'agent:reviewer', pattern_val: 'thorough', confidence: 0.9 });
    upsertPattern({ pattern_key: 'router.tier1_max', pattern_val: '3', confidence: 1.0 });
    storeKnowledge({ title: 'gotcha', content: 'x', type: 'solution' });

    const b = body(await call('veto_snapshot'));
    expect(b.session.id).toBe(session_id);
    expect(b.session.platform).toBe('claude');
    expect(b.council.verdict).toBe('GREEN');
    expect(b.council.recommended).toBe('proceed');
    expect(b.memoryCount).toBe(1);

    // router.* threshold rows are excluded from routerTop.
    const keys = b.routerTop.map((p: any) => p.pattern_key);
    expect(keys).toContain('agent:reviewer');
    expect(keys).not.toContain('router.tier1_max');
  });

  it('honors the top parameter (clamped 1..20)', async () => {
    for (let i = 0; i < 8; i++) {
      upsertPattern({ pattern_key: `agent:a${i}`, pattern_val: 'v', confidence: 0.5 + i * 0.05 });
    }
    const b = body(await call('veto_snapshot', { top: 3 }));
    expect(b.routerTop).toHaveLength(3);
  });
});
