import { executeOne } from '../agents/executor.js';
import type { WorkerAgentType } from '../agents/types.js';

export interface PipelineStep {
  id: string;
  agent: WorkerAgentType;
  task: string;
  code?: string;
  context?: string;
  project_dir?: string;
  gate?: number;           // 0–100: minimum confidence% required to continue
  retry_on_fail?: boolean; // if true, retry this step on gate failure (default false)
  max_retries?: number;    // max retry attempts (default 3, capped at 5)
  condition?: string;      // expression evaluated against prior step outputs; step skipped if false
  dependencies?: string[];
  llm_backed?: boolean;
  agent_outputs?: Record<string, unknown>;  // IDs of steps that must pass before this step runs (DAG mode only)
}

export type StepStatus = 'passed' | 'failed_gate' | 'skipped' | 'error' | 'retried' | 'agentic_loop';

// ── Condition evaluator ───────────────────────────────────────────────────────
// Supported: ==, !=, >=, <=, >, <, &&, ||, !, parens, string/number/bool literals, dotted paths
// Fail-open: returns true on any parse/eval error so steps are not accidentally skipped.

type Token =
  | { type: 'op'; value: string }
  | { type: 'lit'; value: string | number | boolean }
  | { type: 'path'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (i + 1 < expr.length && ['==','!=','>=','<=','&&','||'].includes(expr.slice(i, i + 2))) {
      tokens.push({ type: 'op', value: expr.slice(i, i + 2) }); i += 2; continue;
    }
    if ('><!'.includes(expr[i])) { tokens.push({ type: 'op', value: expr[i] }); i++; continue; }
    if (expr[i] === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (expr[i] === '"' || expr[i] === "'") {
      const q = expr[i]; let s = ''; i++;
      while (i < expr.length && expr[i] !== q) { s += expr[i++]; }
      i++;
      tokens.push({ type: 'lit', value: s }); continue;
    }
    if (/[\d.]/.test(expr[i])) {
      let n = ''; while (i < expr.length && /[\d.]/.test(expr[i])) { n += expr[i++]; }
      tokens.push({ type: 'lit', value: parseFloat(n) }); continue;
    }
    if (/[a-zA-Z_]/.test(expr[i])) {
      let id = ''; while (i < expr.length && /[\w.]/.test(expr[i])) { id += expr[i++]; }
      if (id === 'true')  { tokens.push({ type: 'lit', value: true }); continue; }
      if (id === 'false') { tokens.push({ type: 'lit', value: false }); continue; }
      tokens.push({ type: 'path', value: id }); continue;
    }
    i++;
  }
  return tokens;
}

function resolvePath(path: string, context: Record<string, StepResult>): unknown {
  const parts = path.split('.');
  if (parts.length < 2) return undefined;
  const [stepId, ...rest] = parts;
  const step = context[stepId];
  if (!step) return undefined;
  let val: unknown = step;
  for (const key of rest) { val = (val as Record<string, unknown>)?.[key]; }
  return val;
}

function cmp(a: unknown, op: string, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq
  if (op === '==') return a == b;
  // eslint-disable-next-line eqeqeq
  if (op === '!=') return a != b;
  if (op === '>=') return (a as number) >= (b as number);
  if (op === '<=') return (a as number) <= (b as number);
  if (op === '>' ) return (a as number) >  (b as number);
  if (op === '<' ) return (a as number) <  (b as number);
  return false;
}

export function evaluateCondition(condition: string, context: Record<string, StepResult>): boolean {
  if (!condition || !condition.trim()) return true;
  try {
    const tokens = tokenize(condition);
    let pos = 0;
    const peek = (): Token | undefined => tokens[pos];
    const consume = (): Token => tokens[pos++];

    function parseExpr(): boolean { return parseOr(); }
    function parseOr(): boolean {
      let left = parseAnd();
      while (peek()?.type === 'op' && (peek() as { value: string }).value === '||') { consume(); left = left || parseAnd(); }
      return left;
    }
    function parseAnd(): boolean {
      let left = parseNot();
      while (peek()?.type === 'op' && (peek() as { value: string }).value === '&&') { consume(); left = left && parseNot(); }
      return left;
    }
    function parseNot(): boolean {
      if (peek()?.type === 'op' && (peek() as { value: string }).value === '!') { consume(); return !parseNot(); }
      return parseCompare();
    }
    function parseCompare(): boolean {
      const left = parsePrimary();
      const opTok = peek();
      if (opTok?.type === 'op' && ['==','!=','>=','<=','>','<'].includes((opTok as { value: string }).value)) {
        consume();
        const right = parsePrimary();
        return cmp(left, (opTok as { value: string }).value, right);
      }
      return Boolean(left);
    }
    function parsePrimary(): unknown {
      const tok = peek();
      if (!tok) return undefined;
      if (tok.type === 'lparen') { consume(); const v = parseExpr(); consume(); return v; }
      if (tok.type === 'lit')    { consume(); return (tok as { value: string | number | boolean }).value; }
      if (tok.type === 'path')   { consume(); return resolvePath((tok as { value: string }).value, context); }
      return undefined;
    }

    return parseExpr();
  } catch {
    return true; // fail-open
  }
}

export interface StepResult {
  id: string;
  agent: string;
  status: StepStatus;
  confidence: number;
  severity: string;
  recommendation: string;
  gate?: number;
  duration_ms: number;
  llm_upgrade?: any;
  error?: string;
  attempts?: number; // how many times this step ran (1 = no retries, 2+ = retried)
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
  mode?: 'linear' | 'dag';  // which execution mode was used
}

/** Execute a single step and return a StepResult (no retry — used by DAG helper). */
async function executeStep(step: PipelineStep, globalProjectDir?: string, elicitor?: (q: string) => Promise<string>): Promise<StepResult> {
  const task = {
    id: step.id,
    agent: step.agent,
    task: step.task,
    code: step.code,
    context: step.context,
    project_dir: step.project_dir ?? globalProjectDir,
    llm_backed: step.llm_backed ?? true,
  };

  if (step.agent_outputs && step.agent_outputs[step.id]) {
     // logic handled in runPipeline or externally usually, but for completeness:
  }

  const result = await executeOne(task);

  if (result.llm_upgrade) {
    return {
      id: step.id, agent: step.agent, status: 'agentic_loop',
      confidence: 0, severity: 'info', recommendation: 'Upgrade to LLM needed',
      gate: step.gate, duration_ms: result.duration_ms, llm_upgrade: result.llm_upgrade,
      attempts: 1,
    };
  }

  if (result.error) {
    return {
      id: step.id, agent: step.agent, status: 'error',
      confidence: 0, severity: 'critical',
      recommendation: result.error,
      gate: step.gate, duration_ms: result.duration_ms, error: result.error,
      attempts: 1,
    };
  }

  let confidencePct = Math.round(result.output.confidence * 100);
  let gateFailed = step.gate !== undefined && confidencePct < step.gate;

  // Phase 4.7: requestElicitation override
  if (gateFailed && elicitor) {
    const override = await elicitor(`Step "${step.id}" failed gate (${confidencePct}% < ${step.gate}%). Reason: ${result.output.recommendation}\n\nType "override" to proceed anyway, or provide extra context to retry.`);
    if (override?.toLowerCase() === 'override') {
      gateFailed = false;
      confidencePct = step.gate!; // force pass
    }
  }

  return {
    id: step.id, agent: step.agent,
    status: gateFailed ? 'failed_gate' : 'passed',
    confidence: confidencePct,
    severity: result.output.severity,
    recommendation: result.output.recommendation,
    gate: step.gate,
    duration_ms: result.duration_ms,
    attempts: 1,
  };
}

/** DAG execution: topological sort via Kahn's algorithm + parallel waves. */
async function runPipelineDag(
  steps: PipelineStep[],
  globalProjectDir?: string,
  elicitor?: (q: string) => Promise<string>,
): Promise<PipelineResult> {
  const start = Date.now();
  const stepMap = new Map<string, PipelineStep>(steps.map(s => [s.id, s]));

  // Build in-degree map and reverse-adjacency (who depends on me)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // id -> list of steps that depend on id
  for (const step of steps) {
    if (!inDegree.has(step.id)) inDegree.set(step.id, 0);
    if (!dependents.has(step.id)) dependents.set(step.id, []);
    for (const dep of (step.dependencies ?? [])) {
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(step.id);
    }
  }

  // Collect completed results keyed by step id
  const resultMap = new Map<string, StepResult>();
  // Track which steps are blocked because a dependency failed/errored
  const skippedIds = new Set<string>();

  // Kahn's algorithm: process waves of zero-in-degree steps
  const remaining = new Map(inDegree); // mutable working copy
  let wave = steps.filter(s => (remaining.get(s.id) ?? 0) === 0).map(s => s.id);

  while (wave.length > 0) {
    // Partition wave into runnable vs pre-skipped (dependency failed)
    const toRun = wave.filter(id => !skippedIds.has(id));
    const toSkip = wave.filter(id => skippedIds.has(id));

    // Immediately record skipped steps without executing them
    for (const id of toSkip) {
      const step = stepMap.get(id)!;
      // Find which dependency caused the skip
      const failedDep = (step.dependencies ?? []).find(dep => {
        const r = resultMap.get(dep);
        return r && (r.status === 'failed_gate' || r.status === 'error' || r.status === 'skipped');
      }) ?? '(unknown)';
      const sr: StepResult = {
        id, agent: step.agent, status: 'skipped',
        confidence: 0, severity: 'info',
        recommendation: `Skipped — dependency '${failedDep}' failed`,
        gate: step.gate, duration_ms: 0,
      };
      resultMap.set(id, sr);
      // Propagate skip to this step's own dependents
      for (const child of (dependents.get(id) ?? [])) {
        skippedIds.add(child);
      }
    }

    // Run independent steps in parallel
    if (toRun.length > 0) {
      const stepResults = await Promise.all(
        toRun.map(id => executeStep(stepMap.get(id)!, globalProjectDir, elicitor))
      );
      for (const sr of stepResults) {
        resultMap.set(sr.id, sr);
        const failed = sr.status === 'failed_gate' || sr.status === 'error';
        if (failed) {
          // Mark all downstream dependents as skipped
          for (const child of (dependents.get(sr.id) ?? [])) {
            skippedIds.add(child);
          }
        }
      }
    }

    // Reduce in-degree for dependents of every step we just processed
    const nextWave: string[] = [];
    for (const id of wave) {
      for (const child of (dependents.get(id) ?? [])) {
        const newDeg = (remaining.get(child) ?? 0) - 1;
        remaining.set(child, newDeg);
        if (newDeg === 0) {
          nextWave.push(child);
        }
      }
    }
    wave = nextWave;
  }

  // Preserve original step order in results array
  const results: StepResult[] = steps.map(s => resultMap.get(s.id)!).filter(Boolean);

  const passed = results.filter(r => r.status === 'passed' || r.status === 'retried').length;
  const failed = results.filter(r => r.status === 'failed_gate' || r.status === 'error').length;
  const verdict: PipelineVerdict = failed === 0 ? 'passed' : passed > 0 ? 'partial' : 'failed';

  return {
    verdict,
    steps_total: steps.length,
    steps_passed: passed,
    steps_failed: failed,
    results,
    total_duration_ms: Date.now() - start,
    mode: 'dag',
  };
}

export async function runPipeline(
  steps: PipelineStep[],
  globalProjectDir?: string,
  mode: 'linear' | 'dag' = 'linear',
  elicitor?: (q: string) => Promise<string>,
): Promise<PipelineResult> {
  if (mode === 'dag') {
    return runPipelineDag(steps, globalProjectDir);
  }

  const results: StepResult[] = [];
  const start = Date.now();
  let stoppedAt: string | undefined;
  let stopReason: string | undefined;

  for (const step of steps) {
    // Conditional routing: skip step if condition evaluates to false
    if (step.condition) {
      const contextMap = Object.fromEntries(results.map(r => [r.id, r]));
      if (!evaluateCondition(step.condition, contextMap)) {
        results.push({
          id: step.id, agent: step.agent, status: 'skipped',
          confidence: 0, severity: 'info',
          recommendation: `Skipped — condition "${step.condition}" evaluated to false`,
          gate: step.gate, duration_ms: 0,
        });
        continue;
      }
    }

    const maxRetries = step.retry_on_fail ? Math.min(step.max_retries ?? 3, 5) : 0;
    let currentContext = step.context;
    let lastResult = await executeOne({
      id: step.id,
      agent: step.agent,
      task: step.task,
      code: step.code,
      context: currentContext,
      project_dir: step.project_dir ?? globalProjectDir,
    });
    let attempts = 1;

    if (lastResult.error) {
      results.push({
        id: step.id, agent: step.agent, status: 'error',
        confidence: 0, severity: 'critical',
        recommendation: lastResult.error,
        gate: step.gate, duration_ms: lastResult.duration_ms, error: lastResult.error,
        attempts,
      });
      stoppedAt = step.id;
      stopReason = `Step "${step.id}" errored: ${lastResult.error}`;
      break;
    }

    let confidencePct = Math.round(lastResult.output.confidence * 100);
    let gateFailed = step.gate !== undefined && confidencePct < step.gate;

    // Phase 4.7: requestElicitation override
    if (gateFailed && elicitor && maxRetries === 0) {
      const override = await elicitor(`Step "${step.id}" failed gate (${confidencePct}% < ${step.gate}%). Reason: ${lastResult.output.recommendation}\n\nType "override" to proceed anyway, or provide extra context to retry.`);
      if (override?.toLowerCase() === 'override') {
        gateFailed = false;
        confidencePct = step.gate!;
      } else if (override) {
        const retryResult = await executeOne({ id: step.id, agent: step.agent, task: step.task, context: override, project_dir: step.project_dir ?? globalProjectDir });
        lastResult = retryResult;
        confidencePct = Math.round(lastResult.output.confidence * 100);
        gateFailed = step.gate !== undefined && confidencePct < step.gate;
      }
    }

    // Retry loop
    while (gateFailed && attempts <= maxRetries) {
      const retryMsg = `Previous attempt ${attempts} failed with confidence ${confidencePct}%. Output: ${lastResult.output.recommendation}. Revise your approach.`;
      currentContext = currentContext ? `${currentContext}\n\n${retryMsg}` : retryMsg;
      lastResult = await executeOne({
        id: step.id,
        agent: step.agent,
        task: step.task,
        code: step.code,
        context: currentContext,
        project_dir: step.project_dir ?? globalProjectDir,
      });
      attempts++;

      if (lastResult.error) {
        results.push({
          id: step.id, agent: step.agent, status: 'error',
          confidence: 0, severity: 'critical',
          recommendation: lastResult.error,
          gate: step.gate, duration_ms: lastResult.duration_ms, error: lastResult.error,
          attempts,
        });
        stoppedAt = step.id;
        stopReason = `Step "${step.id}" errored on retry ${attempts}: ${lastResult.error}`;
        break;
      }

      confidencePct = Math.round(lastResult.output.confidence * 100);
      gateFailed = step.gate !== undefined && confidencePct < step.gate;
    }

    // If the step errored during a retry, it was already pushed; move to next step handling
    if (lastResult.error) {
      break;
    }

    const retriedAndPassed = !gateFailed && attempts > 1;

    results.push({
      id: step.id, agent: step.agent,
      status: gateFailed ? 'failed_gate' : (retriedAndPassed ? 'retried' : 'passed'),
      confidence: confidencePct,
      severity: lastResult.output.severity,
      recommendation: lastResult.output.recommendation,
      gate: step.gate,
      duration_ms: lastResult.duration_ms,
      attempts,
    });

    if (gateFailed) {
      stoppedAt = step.id;
      stopReason = `Step "${step.id}" confidence ${confidencePct}% below gate ${step.gate}% after ${attempts} attempt(s)`;
      // mark remaining steps as skipped
      const remaining = steps.slice(steps.indexOf(step) + 1);
      for (const s of remaining) {
        results.push({ id: s.id, agent: s.agent, status: 'skipped', confidence: 0, severity: 'info', recommendation: 'Skipped — upstream gate failed', gate: s.gate, duration_ms: 0 });
      }
      break;
    }
  }

  const passed = results.filter(r => r.status === 'passed' || r.status === 'retried').length;
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
    mode: 'linear',
  };
}
