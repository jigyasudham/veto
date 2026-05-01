import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'task-planner' as WorkerAgentType,
    task,
    tier: 2,
    approach: 'Decompose the goal into a concrete, ordered task list where each task is independently completable in 1–4 hours. The output is not a project plan — it is the immediate next N tasks in execution order, each with a clear acceptance criterion. Identify which tasks can run in parallel and which are sequential dependencies.',
    steps: [
      'State the goal in one sentence — if you cannot, the goal needs clarifying first',
      'Identify all constraints: blocked by X, requires Y to exist first, cannot touch Z',
      'List all deliverables: what files, APIs, tests, or docs must exist when done?',
      'Break deliverables into tasks of 1–4 hours each — nothing larger',
      'For each task: write one acceptance criterion ("done when X passes" or "done when Y returns Z")',
      'Identify dependencies: which tasks must complete before others can start?',
      'Group independent tasks — these can run in parallel via veto_execute_parallel',
      'Order the dependent tasks: what is the critical path?',
      'Identify the single highest-risk task and put it first — fail fast',
      'Save the task plan via veto_session_save so it survives context switches',
    ],
    checklist: [
      '[ ] Goal stated in one sentence',
      '[ ] All constraints identified',
      '[ ] Tasks are 1–4 hours each',
      '[ ] Every task has an acceptance criterion',
      '[ ] Dependencies mapped — no implicit ordering',
      '[ ] Parallel tasks identified',
      '[ ] Critical path identified',
      '[ ] Highest-risk task is first',
      '[ ] Plan saved via veto_session_save',
    ],
    pitfalls: [
      'Tasks too large ("implement auth") — cannot track progress or parallelize',
      'Tasks too small ("add semicolon") — overhead exceeds value',
      'Missing acceptance criteria — "done" is subjective without them',
      'Not identifying blockers upfront — a hidden blocker discovered mid-task stops everything',
      'Putting the risky unknown task last — you should fail fast, not late',
    ],
    patterns: [
      'Risk-first ordering: the most uncertain task goes first so you discover problems early',
      'Acceptance-criteria-first: write the criterion before the task to clarify what done means',
      'Parallel identification: tasks with no shared outputs can always run concurrently',
      'Four-hour rule: if a task cannot be completed in 4 hours, it contains hidden complexity — split it',
    ],
    duration_estimate: '30-60 minutes',
  };
}
