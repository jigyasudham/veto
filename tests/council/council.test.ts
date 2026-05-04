import { describe, it, expect } from 'vitest';
import { runDebate } from '../../src/council/index.js';

const VALID_VERDICTS = new Set(['GREEN', 'YELLOW', 'RED', 'DEADLOCK']);

describe('runDebate', () => {
  it('returns the expected top-level shape', async () => {
    const result = await runDebate({ task: 'add a login button to the homepage' });
    expect(typeof result.task).toBe('string');
    expect(typeof result.final_verdict).toBe('string');
    expect(typeof result.debated_at).toBe('string');
    expect(typeof result.formatted_output).toBe('string');
    expect(Array.isArray(result.block_reasons)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('final_verdict is one of the four valid values', async () => {
    const result = await runDebate({ task: 'add a login button to the homepage' });
    expect(VALID_VERDICTS.has(result.final_verdict)).toBe(true);
  });

  it('all 7 agent votes are present', async () => {
    const result = await runDebate({ task: 'refactor the auth module' });
    expect(result.votes).toHaveProperty('lead_dev');
    expect(result.votes).toHaveProperty('pm');
    expect(result.votes).toHaveProperty('architect');
    expect(result.votes).toHaveProperty('ux');
    expect(result.votes).toHaveProperty('devil');
    expect(result.votes).toHaveProperty('legal');
    expect(result.votes).toHaveProperty('security');
  });

  it('each vote has a verdict field', async () => {
    const result = await runDebate({ task: 'add error handling to the API' });
    for (const vote of Object.values(result.votes)) {
      expect(vote).toHaveProperty('verdict');
    }
  });

  it('formatted_output is a non-empty string', async () => {
    const result = await runDebate({ task: 'deploy to production' });
    expect(result.formatted_output.length).toBeGreaterThan(0);
  });

  it('does not throw when task is a long description', async () => {
    const longTask = 'Implement a complete user authentication system with JWT tokens, refresh token rotation, rate limiting, brute force protection, session management, and audit logging for compliance purposes';
    await expect(runDebate({ task: longTask })).resolves.toBeDefined();
  });

  it('debated_at is an ISO date string', async () => {
    const result = await runDebate({ task: 'add a feature flag' });
    expect(() => new Date(result.debated_at)).not.toThrow();
    expect(new Date(result.debated_at).toISOString()).toBe(result.debated_at);
  });

  it('works without project_dir', async () => {
    const result = await runDebate({ task: 'update the README' });
    expect(result.final_verdict).toBeDefined();
  });
});
