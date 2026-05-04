import { describe, it, expect, beforeEach } from 'vitest';
import { recordOutcome, getLearningStats, applyLearnedThresholds, getLearnedThresholds, getRecommendedAgent } from '../../src/router/learning-updater.js';
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
