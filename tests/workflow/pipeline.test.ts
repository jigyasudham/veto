import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentResult } from '../../src/agents/types.js';

vi.mock('../../src/agents/executor.js', () => ({
  executeOne: vi.fn(),
  executeParallel: vi.fn(),
}));

// Import after mock registration
const { runPipeline } = await import('../../src/workflow/pipeline.js');
const { executeOne } = await import('../../src/agents/executor.js');
const mockExecuteOne = vi.mocked(executeOne);

function makeResult(id: string, confidence: number): AgentResult {
  return {
    id,
    agent: 'coder',
    output: {
      confidence,
      severity: 'info',
      recommendation: `result for ${id}`,
      affected_files: [],
      line_refs: [],
    },
    duration_ms: 10,
  };
}

beforeEach(() => {
  mockExecuteOne.mockReset();
});

describe('runPipeline', () => {
  it('returns verdict:passed when all steps pass their gates', async () => {
    mockExecuteOne
      .mockResolvedValueOnce(makeResult('step1', 0.9))
      .mockResolvedValueOnce(makeResult('step2', 0.85));

    const result = await runPipeline([
      { id: 'step1', agent: 'coder', task: 'write code', gate: 70 },
      { id: 'step2', agent: 'coder', task: 'review code', gate: 70 },
    ]);

    expect(result.verdict).toBe('passed');
    expect(result.steps_passed).toBe(2);
    expect(result.steps_failed).toBe(0);
    expect(result.stopped_at).toBeUndefined();
  });

  it('returns verdict:failed when the first step fails its gate', async () => {
    mockExecuteOne.mockResolvedValueOnce(makeResult('step1', 0.4));

    const result = await runPipeline([
      { id: 'step1', agent: 'coder', task: 'write code', gate: 70 },
      { id: 'step2', agent: 'coder', task: 'review code', gate: 70 },
    ]);

    expect(result.verdict).toBe('failed');
    expect(result.steps_failed).toBe(1);
    expect(result.stopped_at).toBe('step1');
    expect(result.results.find(r => r.id === 'step2')?.status).toBe('skipped');
  });

  it('returns verdict:partial when some steps pass and one fails', async () => {
    mockExecuteOne
      .mockResolvedValueOnce(makeResult('step1', 0.9))
      .mockResolvedValueOnce(makeResult('step2', 0.3));

    const result = await runPipeline([
      { id: 'step1', agent: 'coder', task: 'write code', gate: 70 },
      { id: 'step2', agent: 'coder', task: 'review code', gate: 70 },
      { id: 'step3', agent: 'coder', task: 'test code', gate: 70 },
    ]);

    expect(result.verdict).toBe('partial');
    expect(result.steps_passed).toBe(1);
    expect(result.steps_failed).toBe(1);
    expect(result.results.find(r => r.id === 'step3')?.status).toBe('skipped');
  });

  it('marks a step as passed when confidence is exactly at the gate', async () => {
    mockExecuteOne.mockResolvedValueOnce(makeResult('step1', 0.70));

    const result = await runPipeline([
      { id: 'step1', agent: 'coder', task: 'write code', gate: 70 },
    ]);

    expect(result.results[0].status).toBe('passed');
  });

  it('runs all steps when no gates are specified', async () => {
    mockExecuteOne
      .mockResolvedValueOnce(makeResult('a', 0.1))
      .mockResolvedValueOnce(makeResult('b', 0.1));

    const result = await runPipeline([
      { id: 'a', agent: 'coder', task: 'step a' },
      { id: 'b', agent: 'coder', task: 'step b' },
    ]);

    expect(result.verdict).toBe('passed');
    expect(result.steps_total).toBe(2);
    expect(result.steps_passed).toBe(2);
  });

  it('stops and marks remaining as skipped when a step errors', async () => {
    mockExecuteOne.mockResolvedValueOnce({
      id: 'step1',
      agent: 'coder',
      output: { confidence: 0, severity: 'info', recommendation: '', affected_files: [], line_refs: [] },
      duration_ms: 5,
      error: 'something went wrong',
    });

    const result = await runPipeline([
      { id: 'step1', agent: 'coder', task: 'failing step' },
      { id: 'step2', agent: 'coder', task: 'would be skipped' },
    ]);

    expect(result.stopped_at).toBe('step1');
    expect(result.results[0].status).toBe('error');
  });

  it('uses globalProjectDir when step has no project_dir', async () => {
    mockExecuteOne.mockResolvedValueOnce(makeResult('step1', 0.9));

    await runPipeline(
      [{ id: 'step1', agent: 'coder', task: 'write' }],
      '/global/project'
    );

    expect(mockExecuteOne).toHaveBeenCalledWith(
      expect.objectContaining({ project_dir: '/global/project' })
    );
  });

  it('total_duration_ms is a non-negative number', async () => {
    mockExecuteOne.mockResolvedValueOnce(makeResult('step1', 0.9));
    const result = await runPipeline([{ id: 'step1', agent: 'coder', task: 'write' }]);
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
  });
});
