import { describe, it, expect } from 'vitest';
import { selectModel } from '../../src/router/model-selector.js';

describe('selectModel — locked agents', () => {
  const TIER3_LOCKED = ['lead-developer', 'system-architect', 'security-scanner', 'devil-advocate', 'decision-engine', 'risk-assessor'] as const;
  const TIER2_LOCKED = ['coder', 'tester', 'reviewer', 'database', 'documentation'] as const;
  const TIER1_LOCKED = ['file-manager', 'git-agent', 'search-agent', 'secrets', 'reporter'] as const;

  for (const agent of TIER3_LOCKED) {
    it(`${agent} is always Tier 3 regardless of score`, () => {
      expect(selectModel(5, agent).tier).toBe(3);
      expect(selectModel(5, agent).agent_locked).toBe(true);
    });
  }

  for (const agent of TIER2_LOCKED) {
    it(`${agent} is always Tier 2 regardless of score`, () => {
      expect(selectModel(90, agent).tier).toBe(2);
      expect(selectModel(90, agent).agent_locked).toBe(true);
    });
  }

  for (const agent of TIER1_LOCKED) {
    it(`${agent} is always Tier 1 regardless of score`, () => {
      expect(selectModel(90, agent).tier).toBe(1);
      expect(selectModel(90, agent).agent_locked).toBe(true);
    });
  }
});

describe('selectModel — dynamic routing', () => {
  it('routes score ≤ 30 to Tier 1', () => {
    const result = selectModel(15, 'dynamic');
    expect(result.tier).toBe(1);
    expect(result.agent_locked).toBe(false);
  });

  it('routes score 31–70 to Tier 2', () => {
    expect(selectModel(31, 'dynamic').tier).toBe(2);
    expect(selectModel(50, 'dynamic').tier).toBe(2);
    expect(selectModel(70, 'dynamic').tier).toBe(2);
  });

  it('routes score > 70 to Tier 3', () => {
    expect(selectModel(71, 'dynamic').tier).toBe(3);
    expect(selectModel(100, 'dynamic').tier).toBe(3);
  });

  it('defaults to dynamic when agent omitted', () => {
    const result = selectModel(50);
    expect(result.agent_locked).toBe(false);
    expect(result.tier).toBe(2);
  });
});

describe('selectModel — model names', () => {
  it('Tier 1 uses fast/cheap models', () => {
    const m = selectModel(10, 'dynamic').models;
    expect(m.claude).toContain('haiku');
    expect(m.gemini).toContain('flash');
    expect(m.codex).toContain('mini');
  });

  it('Tier 2 uses balanced models', () => {
    const m = selectModel(50, 'dynamic').models;
    expect(m.claude).toContain('sonnet');
    expect(m.gemini).toContain('pro');
    expect(m.codex).toBe('gpt-4o');
  });

  it('Tier 3 uses best available models', () => {
    const m = selectModel(90, 'dynamic').models;
    expect(m.claude).toContain('sonnet');
    expect(m.gemini).toContain('advanced');
  });

  it('always returns a non-empty reason string', () => {
    expect(selectModel(10, 'dynamic').reason.length).toBeGreaterThan(0);
    expect(selectModel(50, 'coder').reason.length).toBeGreaterThan(0);
    expect(selectModel(90, 'lead-developer').reason.length).toBeGreaterThan(0);
  });
});
