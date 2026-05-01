import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isCron = t.includes('cron') || t.includes('schedule') || t.includes('recurring') || t.includes('daily') || t.includes('weekly');
  const isPipeline = t.includes('pipeline') || t.includes('ci') || t.includes('workflow') || t.includes('trigger') || t.includes('webhook');
  const isScript = t.includes('script') || t.includes('automat') || t.includes('batch') || t.includes('bulk');

  const approach = isCron
    ? 'Design the cron job with three safety properties: idempotency (running it twice should be safe), observability (every run logs start/end/result), and alerting (failed runs must page someone). The most common cron bug is silent failure — the job stops running and nobody notices for weeks.'
    : isPipeline
    ? 'Design the pipeline with exactly-once execution semantics where possible. Each stage should be independently retryable. Every stage logs its input and output. The pipeline must have a dead-letter mechanism for events that fail after max retries.'
    : isScript
    ? 'Write the automation script as a dry-run first: add a --dry-run flag that shows what would happen without doing it. Test the dry-run output before removing the flag. Automation that cannot be previewed should not exist.'
    : 'Design the automation with four properties: idempotent (safe to re-run), observable (logs start/end/result), alertable (failures surface immediately), and reversible (can undo if wrong).';

  return {
    agent: 'automation' as WorkerAgentType,
    task,
    tier: 2,
    approach,
    steps: [
      'Define the trigger: what starts this automation? (schedule, event, webhook, manual)',
      'Define the idempotency strategy: what prevents duplicate execution from causing harm?',
      'Define the happy path: what are the exact steps in order?',
      'Define the failure modes: what can go wrong at each step?',
      'Design retry logic: how many retries, with what backoff, before giving up?',
      'Design the dead-letter path: what happens to items that fail after max retries?',
      'Add structured logging: every run logs start (with input), each step result, and end (with outcome)',
      'Add alerting: failed runs must produce an alert, not just a log entry',
      'Add a dry-run mode for scripts that modify data',
      'Test the failure path explicitly — do not assume the happy path covers everything',
    ],
    checklist: [
      '[ ] Trigger defined and documented',
      '[ ] Idempotency strategy implemented',
      '[ ] Retry logic with bounded backoff',
      '[ ] Dead-letter mechanism for permanent failures',
      '[ ] Structured logging on every run',
      '[ ] Alert on failure (not just log)',
      '[ ] Dry-run mode for destructive operations',
      '[ ] Failure path tested explicitly',
    ],
    pitfalls: [
      'Silent failure — cron jobs that fail without alerting are the most dangerous automation',
      'No idempotency — running the job twice sends duplicate emails, charges customers twice',
      'Unbounded retries — a failing job retries forever and blocks the queue',
      'No dry-run — automation that modifies data cannot be safely previewed before running',
      'Logging only on failure — you cannot diagnose why it failed without knowing what it was doing',
    ],
    patterns: [
      'IDOA framework: Idempotent → Observable → Alertable → Dry-run-capable',
      'Dead-letter queue: every event that fails max retries goes here, never silently dropped',
      'Structured run log: { job, run_id, started_at, input_count, success_count, error_count, ended_at }',
      'Failure-first testing: write the test for the failure path before the happy path',
    ],
    duration_estimate: '2-6 hours',
  };
}
