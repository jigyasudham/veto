import { describe, it, expect, beforeEach } from 'vitest';
import { recordOutcome, getLearningStats, applyLearnedThresholds, getLearnedThresholds, getRecommendedAgent, isFeedbackEnabled, setFeedbackEnabled, recordRoutingFeedback, getRoutingFeedbackStats, resetRoutingFeedback, listRoutingFeedback } from '../../src/router/learning-updater.js';
import { resetDb } from '../../src/memory/local.js';

beforeEach(() => {
  resetDb();
});

describe('recordOutcome', () => {
  it('does not throw when recording an outcome', () => {
    expect(() => recordOutcome('fix-bug', 25, 1, 'debugger', 85)).not.toThrow();
  });

  it('increments total_tasks in getLearningStats', () => {
    recordOutcome('fix-bug', 25, 1, 'debugger', 85);
    recordOutcome('add-feature', 55, 2, 'coder', 90);
    const stats = getLearningStats();
    expect(stats.total_tasks).toBe(2);
  });

  it('populates tier_breakdown by model tier', () => {
    recordOutcome('task-a', 25, 1, 'debugger', 80);
    recordOutcome('task-b', 50, 2, 'coder', 90);
    recordOutcome('task-c', 80, 3, 'lead-developer', 95);
    const stats = getLearningStats();
    expect(stats.tier_breakdown[1]).toBeDefined();
    expect(stats.tier_breakdown[2]).toBeDefined();
    expect(stats.tier_breakdown[3]).toBeDefined();
  });

  it('returns suggested_thresholds with default values on sparse data', () => {
    recordOutcome('task', 40, 2, 'coder', 70);
    const stats = getLearningStats();
    expect(stats.suggested_thresholds.tier1_max).toBeGreaterThan(0);
    expect(stats.suggested_thresholds.tier2_max).toBeGreaterThan(stats.suggested_thresholds.tier1_max);
  });
});

describe('applyLearnedThresholds', () => {
  it('returns applied:false when fewer than 20 outcomes recorded', () => {
    recordOutcome('task', 30, 1, 'coder', 80);
    const result = applyLearnedThresholds();
    expect(result.applied).toBe(false);
    expect(result.data_points).toBeLessThan(20);
    expect(result.reason).toContain('20');
  });

  it('returns applied:true with 20+ outcomes and persists thresholds', () => {
    for (let i = 0; i < 20; i++) {
      recordOutcome(`task-${i}`, 50, 2, 'coder', 88);
    }
    const result = applyLearnedThresholds();
    expect(result.applied).toBe(true);
    expect(result.data_points).toBeGreaterThanOrEqual(20);
    expect(result.thresholds.tier1_max).toBeGreaterThan(0);
    expect(result.thresholds.tier2_max).toBeGreaterThan(result.thresholds.tier1_max);
  });
});

describe('getLearnedThresholds', () => {
  it('returns source:default when no thresholds have been applied', () => {
    const result = getLearnedThresholds();
    expect(result.source).toBe('default');
    expect(result.tier1_max).toBe(30);
    expect(result.tier2_max).toBe(70);
  });

  it('returns source:learned after applyLearnedThresholds with enough data', () => {
    for (let i = 0; i < 20; i++) {
      recordOutcome(`task-${i}`, 50, 2, 'coder', 88);
    }
    applyLearnedThresholds();
    const result = getLearnedThresholds();
    expect(result.source).toBe('learned');
  });
});

describe('auto-apply learned thresholds (3.4b)', () => {
  it('recordOutcome returns the running total and an auto_applied flag', () => {
    const r = recordOutcome('task', 40, 2, 'coder', 80);
    expect(r.total).toBe(1);
    expect(r.auto_applied).toBe(false);
  });

  it('does not auto-apply before 20 outcomes (thresholds stay default)', () => {
    for (let i = 0; i < 19; i++) recordOutcome(`task-${i}`, 50, 2, 'coder', 88);
    expect(getLearnedThresholds().source).toBe('default');
  });

  it('auto-applies learned thresholds when the 20th outcome is recorded', () => {
    let last = { auto_applied: false, total: 0 };
    for (let i = 0; i < 20; i++) last = recordOutcome(`task-${i}`, 50, 2, 'coder', 88);
    expect(last.total).toBe(20);
    expect(last.auto_applied).toBe(true);
    expect(getLearnedThresholds().source).toBe('learned');
  });
});

describe('getRecommendedAgent', () => {
  it('returns null when no patterns exist', () => {
    const result = getRecommendedAgent('fix-bug', '.ts');
    expect(result).toBeNull();
  });

  it('returns null when seen_count < 3', () => {
    recordOutcome('fix-bug', 30, 1, 'debugger', 90, 0, '.ts');
    recordOutcome('fix-bug', 30, 1, 'debugger', 90, 0, '.ts');
    const result = getRecommendedAgent('fix-bug', '.ts');
    expect(result).toBeNull();
  });

  it('returns an agent recommendation after sufficient high-quality outcomes', () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome('fix-bug', 30, 1, 'debugger', 90, 0, '.ts');
    }
    const result = getRecommendedAgent('fix-bug', '.ts');
    expect(result).toBe('debugger');
  });
});

describe('routing feedback loop', () => {
  it('is disabled by default', () => {
    expect(isFeedbackEnabled()).toBe(false);
  });

  it('can be enabled and disabled', () => {
    setFeedbackEnabled(true);
    expect(isFeedbackEnabled()).toBe(true);
    setFeedbackEnabled(false);
    expect(isFeedbackEnabled()).toBe(false);
  });

  it('recordRoutingFeedback stores a signal when enabled', () => {
    setFeedbackEnabled(true);
    const id = recordRoutingFeedback({ task: 'add login feature', complexity: 55, model_tier: 2 });
    expect(id).toBeTruthy();
    const stats = getRoutingFeedbackStats();
    expect(stats.active).toBe(1);
    expect(stats.by_tier[2]).toBeDefined();
    expect(stats.by_tier[2].count).toBe(1);
    expect(stats.by_tier[2].avg_quality).toBeNull();
  });

  it('listRoutingFeedback returns entries with pending outcome', () => {
    setFeedbackEnabled(true);
    recordRoutingFeedback({ task: 'refactor auth module', complexity: 70, model_tier: 3, agent: 'coder' });
    const log = listRoutingFeedback(10);
    expect(log.length).toBe(1);
    expect(log[0].outcome).toBe('pending');
    expect(log[0].task_snippet).toBe('refactor auth module');
    expect(log[0].model_tier).toBe(3);
  });

  it('resetRoutingFeedback clears all signals', () => {
    setFeedbackEnabled(true);
    recordRoutingFeedback({ task: 'task-a', complexity: 30, model_tier: 1 });
    recordRoutingFeedback({ task: 'task-b', complexity: 60, model_tier: 2 });
    expect(getRoutingFeedbackStats().active).toBe(2);
    const result = resetRoutingFeedback();
    expect(result.deleted_feedback).toBe(2);
    expect(getRoutingFeedbackStats().total).toBe(0);
  });

  it('stats show correct expired count', () => {
    const stats = getRoutingFeedbackStats();
    expect(stats.ttl_days).toBe(30);
    expect(stats.expired).toBe(0);
  });
});
