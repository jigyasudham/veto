import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isGreenfield = t.includes('new project') || t.includes('start') || t.includes('greenfield') || t.includes('choose');
  const isMigration = t.includes('migrat') || t.includes('replac') || t.includes('switch from') || t.includes('move from');

  const approach = isGreenfield
    ? 'Evaluate the full stack for a greenfield project. Prioritise developer velocity, operational simplicity, and escape hatches. Recommend a stack with a 2-year horizon, not a 10-year one.'
    : isMigration
    ? 'Evaluate the migration path. A technology switch is only worth it if the current choice is actively blocking progress. Quantify: what does the current stack cost in monthly developer friction? What is the migration cost in weeks? Recommend migrate only if ROI is positive within 6 months.'
    : 'The best technology is usually the one the team already knows, unless there is a specific capability gap. Document the gap first, then evaluate if a technology switch is the minimal solution.';

  return {
    agent: 'tech-advisor' as WorkerAgentType,
    task,
    tier: 3,
    approach,
    steps: [
      'Identify the actual problem: what specific capability is missing or causing friction?',
      'Check if the current stack solves it with a library/plugin before considering a switch',
      'If a new technology is needed: define evaluation criteria for this project specifically',
      'List the top 3 candidates that meet the baseline criteria',
      'Evaluate each: team learning curve, operational complexity, ecosystem maturity, licensing',
      'Identify hidden costs: CI/CD changes, deployment changes, team training, tooling updates',
      'Run a time-boxed spike (2–4 hours) with the top candidate to validate the fit',
      'Document the decision as an ADR with alternatives and rejection reasons',
      'Identify the first sign the chosen technology was wrong — what triggers re-evaluation?',
      'Store in veto_memory_store (type="decision", tags=["tech-stack"])',
    ],
    checklist: [
      '[ ] Problem statement defined before evaluating solutions',
      '[ ] Current stack\'s ability to solve the problem checked first',
      '[ ] Top 3 candidates evaluated against project-specific criteria',
      '[ ] Hidden migration costs estimated',
      '[ ] Time-boxed spike completed for top candidate',
      '[ ] ADR written with alternatives and rejection reasons',
      '[ ] Re-evaluation trigger defined',
    ],
    pitfalls: [
      'Choosing a technology because it is popular industry-wide — the industry\'s context is not yours',
      'Underestimating hidden migration costs (CI/CD, docs, engineer onboarding)',
      'Skipping the spike — looks good in docs often fails on real requirements',
      'Not defining a re-evaluation trigger — you end up committed to a wrong choice indefinitely',
      'Recommending a full rewrite when an adapter would solve the problem',
    ],
    patterns: [
      'Capability-gap-first: identify the gap before evaluating technologies',
      'Time-boxed spike: validate with real code before committing',
      'ADR on adoption: document the decision the day it is made',
      'Re-evaluation trigger: define upfront what would make you revisit this decision',
    ],
    duration_estimate: '2-4 hours',
  };
}
