import { executeOne } from '../agents/executor.js';
import type { WorkerAgentType } from '../agents/types.js';

export interface PipelineStep {
  id: string;
  agent: WorkerAgentType;
  task: string;
  code?: string;
  context?: string;
  project_dir?: string;
  gate?: number;    // 0–100: minimum confidence% required to continue
}

export type StepStatus = 'passed' | 'failed_gate' | 'skipped' | 'error';

export interface StepResult {
  id: string;
  agent: string;
  status: StepStatus;
  confidence: number;
  severity: string;
  recommendation: string;
  gate?: number;
  duration_ms: number;
  error?: string;
}

export type PipelineVerdict = 'passed' | 'partial' | 'failed';

export interface PipelineResult {
  verdict: PipelineVerdict;
  steps_total: number;
  steps_passed: number;
  steps_failed: number;
  stopped_at?: string;
  stop_reason?: string;
  results: StepResult[];
  total_duration_ms: number;
}

export async function runPipeline(
  steps: PipelineStep[],
  globalProjectDir?: string,
): Promise<PipelineResult> {
  const results: StepResult[] = [];
  const start = Date.now();
  let stoppedAt: string | undefined;
  let stopReason: string | undefined;

  for (const step of steps) {
    const result = await executeOne({
      id: step.id,
      agent: step.agent,
      task: step.task,
      code: step.code,
      context: step.context,
      project_dir: step.project_dir ?? globalProjectDir,
    });

    const confidence = result.output.confidence;
    const confidencePct = Math.round(confidence * 100);

    if (result.error) {
      results.push({
        id: step.id, agent: step.agent, status: 'error',
        confidence: 0, severity: 'critical',
        recommendation: result.error,
        gate: step.gate, duration_ms: result.duration_ms, error: result.error,
      });
      stoppedAt = step.id;
      stopReason = `Step "${step.id}" errored: ${result.error}`;
      break;
    }

    const gateFailed = step.gate !== undefined && confidencePct < step.gate;

    results.push({
      id: step.id, agent: step.agent,
      status: gateFailed ? 'failed_gate' : 'passed',
      confidence: confidencePct,
      severity: result.output.severity,
      recommendation: result.output.recommendation,
      gate: step.gate,
      duration_ms: result.duration_ms,
    });

    if (gateFailed) {
      stoppedAt = step.id;
      stopReason = `Step "${step.id}" confidence ${confidencePct}% below gate ${step.gate}%`;
      // mark remaining steps as skipped
      const remaining = steps.slice(steps.indexOf(step) + 1);
      for (const s of remaining) {
        results.push({ id: s.id, agent: s.agent, status: 'skipped', confidence: 0, severity: 'info', recommendation: 'Skipped — upstream gate failed', gate: s.gate, duration_ms: 0 });
      }
      break;
    }
  }

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed_gate' || r.status === 'error').length;
  const verdict: PipelineVerdict = failed === 0 ? 'passed' : passed > 0 ? 'partial' : 'failed';

  return {
    verdict,
    steps_total: steps.length,
    steps_passed: passed,
    steps_failed: failed,
    stopped_at: stoppedAt,
    stop_reason: stopReason,
    results,
    total_duration_ms: Date.now() - start,
  };
}
