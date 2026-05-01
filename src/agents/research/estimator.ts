import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isFeature = t.includes('feature') || t.includes('implement') || t.includes('build') || t.includes('add');
  const isProject = t.includes('project') || t.includes('entire') || t.includes('full') || t.includes('phase');
  const isRefactor = t.includes('refactor') || t.includes('migrat') || t.includes('rewrite') || t.includes('restructur');

  const approach = isProject
    ? 'Estimate the full project using bottom-up decomposition: break into phases, phases into milestones, milestones into tasks. Estimate each task independently, then add a calibration factor based on team history. Never estimate a project in one number — give P50 (likely), P80 (likely with normal friction), and P95 (likely with major unexpected issue).'
    : isRefactor
    ? 'Refactors and migrations consistently take 2–3x the original estimate because hidden coupling is discovered mid-work. Use a base estimate of "how long to implement from scratch" × 2, plus a separate estimate for integration testing and rollback preparation. Do not use the refactor estimate as a deadline — use it as a budget check.'
    : isFeature
    ? 'Estimate the feature in four parts: core implementation, edge cases and error handling, tests, and integration. Core implementation is what engineers quote; the other three are what makes estimates wrong. A realistic feature estimate is roughly: core × 2.5.'
    : 'Break the work into tasks of 1–4 hours each. Anything larger than 4 hours contains hidden complexity that will surface mid-execution. Estimate each small task, sum them, add 30% for integration and unexpected issues.';

  return {
    agent: 'estimator' as WorkerAgentType,
    task,
    tier: 2,
    approach,
    steps: [
      'Decompose the work into tasks of 1–4 hours each — nothing larger',
      'Estimate each task independently (avoid anchoring on the total)',
      'For each estimate: document the main assumption that could make it wrong',
      'Identify which tasks have the highest uncertainty — these drive the range',
      'Sum the task estimates to get the P50 (50% chance of hitting)',
      'Add 30% to get P80 (accounting for normal integration friction)',
      'Add another 30% to P80 to get P95 (accounting for one major unexpected issue)',
      'Identify the critical path: which tasks block all other work?',
      'Identify tasks that can be parallelised if more people are added',
      'Check against historical estimates: what was the last similar task\'s actual vs. estimate ratio?',
      'Store the estimate in veto_memory_store (type="reference") with actual time tracked when complete',
    ],
    checklist: [
      '[ ] Work decomposed into tasks ≤ 4 hours each',
      '[ ] Each task estimated independently',
      '[ ] Main assumption per task documented',
      '[ ] P50, P80, P95 range calculated',
      '[ ] Critical path identified',
      '[ ] Historical ratio checked (if prior estimates exist)',
      '[ ] Estimate stored for calibration tracking',
    ],
    pitfalls: [
      'Estimating top-down from a desired deadline — the estimate becomes a negotiation, not a forecast',
      'Not separating core implementation from edge cases, tests, and integration — this is where estimates consistently fail',
      'Giving a single number instead of a range — single-number estimates communicate false precision',
      'Not documenting the assumptions behind the estimate — when reality diverges, nobody knows why',
      'Forgetting that refactors and migrations have a 2–3x hidden complexity multiplier',
      'Not tracking actuals — without actuals, estimates never improve',
    ],
    patterns: [
      'Bottom-up decomposition: sum of small estimates beats one large estimate every time',
      'P50/P80/P95 range: communicates uncertainty honestly rather than false precision',
      'Assumption documentation: the assumption is the estimate — when it is wrong, the estimate is wrong',
      'Estimate-to-actual tracking: store both estimate and actual in veto_memory_store to calibrate future estimates',
    ],
    duration_estimate: '30-60 minutes',
  };
}
