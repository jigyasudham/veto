import { describe, it, expect, beforeEach } from 'vitest';
import { mineImplicitOutcomes } from '../../src/router/implicit-outcomes.js';
import { resetDb, getDb, recordToolCall } from '../../src/memory/local.js';

beforeEach(() => resetDb());

function trace(tool_name: string, result_status: 'success' | 'error', session_id?: string) {
  recordToolCall({ session_id, tool_name, args: {}, result_status, duration_ms: 10 });
}

function learningRows(): Array<{ task_type: string; agent: string; output_quality: number }> {
  return getDb().prepare('SELECT task_type, agent, output_quality FROM learning_data').all() as any;
}

describe('mineImplicitOutcomes', () => {
  it('returns zeros on an empty trace log', () => {
    expect(mineImplicitOutcomes()).toEqual({ mined: 0, errors: 0, retries: 0 });
  });

  it('records a low-quality outcome for an errored agent-backed call', () => {
    trace('veto_security_scan', 'error', 's1');
    const result = mineImplicitOutcomes();
    expect(result.errors).toBe(1);
    const rows = learningRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('security-scanner');
    expect(rows[0].output_quality).toBe(30);
  });

  it('marks down rapid re-runs of the same tool in the same session', () => {
    trace('veto_code_review', 'success', 's1');
    trace('veto_code_review', 'success', 's1');
    const result = mineImplicitOutcomes();
    expect(result.retries).toBe(1);
    const rows = learningRows();
    expect(rows[0].agent).toBe('reviewer');
    expect(rows[0].output_quality).toBe(55);
  });

  it('re-runs in different sessions are not retries', () => {
    trace('veto_code_review', 'success', 's1');
    trace('veto_code_review', 'success', 's2');
    expect(mineImplicitOutcomes().retries).toBe(0);
  });

  it('ignores tools that are not agent-backed', () => {
    trace('veto_status', 'error', 's1');
    trace('veto_memory_search', 'success', 's1');
    trace('veto_memory_search', 'success', 's1');
    expect(mineImplicitOutcomes()).toEqual({ mined: 0, errors: 0, retries: 0 });
  });

  it('is idempotent — the watermark prevents double-counting', () => {
    trace('veto_security_scan', 'error', 's1');
    expect(mineImplicitOutcomes().mined).toBe(1);
    expect(mineImplicitOutcomes().mined).toBe(0);
    expect(learningRows()).toHaveLength(1);
  });

  it('counts mixed signals in one pass', () => {
    trace('veto_security_scan', 'error', 's1');
    trace('veto_council_debate', 'success', 's1');
    trace('veto_council_debate', 'success', 's1');
    const result = mineImplicitOutcomes();
    expect(result.errors).toBe(1);
    expect(result.retries).toBe(1);
    expect(result.mined).toBe(2);
  });
});
