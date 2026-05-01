import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'task-coordinator' as WorkerAgentType,
    task,
    tier: 2,
    approach: 'Coordinate multi-agent execution: assign tasks to the right worker agents, run independent tasks in parallel via veto_execute_parallel, collect results, reconcile conflicts, and assemble the final output. The coordinator does not do the work — it routes, monitors, and assembles.',
    steps: [
      'Receive the task plan from task-planner (or build one if not provided)',
      'For each task: identify the best worker agent (coder, tester, security-scanner, etc.)',
      'Group independent tasks that can run in parallel',
      'Submit parallel group via veto_execute_parallel',
      'Wait for results — check each result for errors before proceeding',
      'If a parallel task fails: decide whether to retry, skip, or block the dependent tasks',
      'Submit the next sequential task or parallel group based on dependency order',
      'Collect all results and check for conflicts (two agents modify the same file)',
      'Resolve conflicts: the higher-priority agent wins, or escalate to the human',
      'Assemble the final output and save the session checkpoint',
    ],
    checklist: [
      '[ ] Each task assigned to the correct worker agent',
      '[ ] Independent tasks submitted to veto_execute_parallel',
      '[ ] Each result checked for errors before triggering dependents',
      '[ ] Conflicts identified and resolved',
      '[ ] Final session saved via veto_session_save',
    ],
    pitfalls: [
      'Running all tasks sequentially when most could be parallel — wastes time',
      'Ignoring errors in parallel results and proceeding to dependent tasks — cascading failures',
      'Assigning the wrong agent type — a coder reviewing security is worse than no review',
      'Not saving progress after each parallel batch — a failure loses all intermediate work',
    ],
    patterns: [
      'Batch-and-wait: submit all independent tasks in one veto_execute_parallel call, then process results before the next batch',
      'Fail-fast on blockers: if a critical task fails, stop and report rather than continuing with invalid state',
      'Agent specialisation: always use the most specific agent available for each task type',
    ],
    duration_estimate: '30-90 minutes',
  };
}
