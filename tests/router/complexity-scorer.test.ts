import { describe, it, expect } from 'vitest';
import { scoreComplexity } from '../../src/router/complexity-scorer.js';

describe('scoreComplexity', () => {
  it('returns Tier 1 for a simple short task', () => {
    const result = scoreComplexity('fix typo');
    expect(result.tier).toBe(1);
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.council_required).toBe(false);
  });

  it('returns Tier 2 for a moderate task with technical keywords', () => {
    // 18 words, 10 keyword hits = 6+20+5 = 31 — just into Tier 2
    const result = scoreComplexity('build multiple service components with docker configuration and module endpoint integration and test coverage for the deployment pipeline');
    expect(result.tier).toBe(2);
    expect(result.score).toBeGreaterThan(30);
    expect(result.score).toBeLessThanOrEqual(70);
  });

  it('returns Tier 3 for a complex task', () => {
    const result = scoreComplexity('design distributed microservices architecture with performance and scalability');
    expect(result.tier).toBe(3);
    expect(result.score).toBeGreaterThan(70);
  });

  it('sets council_required for tasks containing council triggers', () => {
    const result = scoreComplexity('migrate the database schema to a new structure');
    expect(result.council_required).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(71);
    expect(result.tier).toBe(3);
  });

  it('sets council_required for security-related tasks', () => {
    const result = scoreComplexity('fix authentication flow');
    expect(result.council_required).toBe(true);
    expect(result.tier).toBe(3);
  });

  it('forceCouncil overrides to council_required=true and Tier 3', () => {
    const result = scoreComplexity('add a button', 1, true);
    expect(result.council_required).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.score).toBeGreaterThanOrEqual(71);
  });

  it('more files affected increases the score', () => {
    const base = scoreComplexity('implement feature', 1);
    const many = scoreComplexity('implement feature', 8);
    expect(many.score).toBeGreaterThan(base.score);
    expect(many.factors.files_score).toBeGreaterThan(base.factors.files_score);
  });

  it('score is capped at 100', () => {
    const result = scoreComplexity(
      'design secure distributed authentication architecture with encryption rbac jwt oauth compliance performance infrastructure migration',
      20,
      true
    );
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('respects custom tier thresholds', () => {
    // 'implement a service module' scores 7 — Tier 1 with defaults (≤30), Tier 2 with tier1_max=5
    const defaultResult = scoreComplexity('implement a service module');
    expect(defaultResult.tier).toBe(1);
    const tightResult = scoreComplexity('implement a service module', 1, false, { tier1_max: 5, tier2_max: 50 });
    expect(tightResult.tier).toBe(2);
  });

  it('returns all factor keys', () => {
    const result = scoreComplexity('implement auth');
    expect(result.factors).toHaveProperty('word_count_score');
    expect(result.factors).toHaveProperty('keyword_score');
    expect(result.factors).toHaveProperty('depth_score');
    expect(result.factors).toHaveProperty('files_score');
    expect(result.factors).toHaveProperty('council_bonus');
  });

  it('depth_score increases with conjunctions', () => {
    const simple = scoreComplexity('fix the bug');
    const compound = scoreComplexity('fix the bug and add logging with error handling');
    expect(compound.factors.depth_score).toBeGreaterThan(simple.factors.depth_score);
  });

  it('council_bonus is 10 when council is required, 0 otherwise', () => {
    const plain = scoreComplexity('add a button');
    const council = scoreComplexity('add a button', 1, true);
    expect(plain.factors.council_bonus).toBe(0);
    expect(council.factors.council_bonus).toBe(10);
  });

  it('word_count_score caps at 25 with >60 word bonus', () => {
    const long = scoreComplexity(Array(200).fill('word').join(' '));
    expect(long.factors.word_count_score).toBe(25);
    const short = scoreComplexity(Array(30).fill('word').join(' '));
    expect(short.factors.word_count_score).toBe(10); // 30/3 = 10, no bonus
  });

  it('keyword_score caps at 30', () => {
    const heavy = scoreComplexity('architecture security authentication authorization jwt oauth rbac encryption cryptography penetration vulnerability infrastructure compliance performance distributed scalable concurrent');
    expect(heavy.factors.keyword_score).toBeLessThanOrEqual(30);
  });
});
