import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isSession = t.includes('session') || t.includes('summary') || t.includes('what was done');
  const isStatus = t.includes('status') || t.includes('progress') || t.includes('where are we');

  const approach = isSession
    ? 'Produce a session summary: what was accomplished, what decisions were made, what is next. Structure: one-sentence headline, bullet list of completed work, bullet list of open items, single next action. Optimised for someone picking up this work cold — they should need to read nothing else.'
    : isStatus
    ? 'Produce a status report: current phase, percent complete, what is blocking progress, and the next milestone. Include a risk flag if any blocker has been open for more than one session.'
    : 'Produce the appropriate report for this context. Default to the session summary format: headline, completed, open, next action.';

  return {
    agent: 'reporter' as WorkerAgentType,
    task,
    tier: 1,
    approach,
    steps: [
      'Identify what type of report is needed: session summary, status report, or decision log',
      'Collect the facts: what was completed, what decisions were made, what is open',
      'Write the headline: one sentence that captures the most important thing',
      'List completed work as bullet points — specific, verifiable ("Auth middleware passing all tests")',
      'List open items with priority order',
      'Identify blockers: anything that prevents progress without human input',
      'State the single next action as a concrete step',
      'Save to session via veto_session_save if this report closes a work session',
    ],
    checklist: [
      '[ ] Headline captures the most important single thing',
      '[ ] Completed items are specific and verifiable',
      '[ ] Open items are prioritised',
      '[ ] Blockers are explicitly named',
      '[ ] Next action is a single concrete step',
      '[ ] Report saved if it closes a session',
    ],
    pitfalls: [
      'Vague completed items ("worked on auth") — not verifiable, not useful',
      'Listing everything instead of prioritising — buries the important items',
      'No next action — the person reading the report cannot resume without re-reading everything',
      'Including implementation details the reader does not need — reports should be scannable in 30 seconds',
    ],
    patterns: [
      'Headline-first: the most important thing should be visible without scrolling',
      'Scannable structure: headline → done → open → blockers → next — in that order',
      'One next action: multiple next actions means no prioritisation has happened',
      'Cold-start test: can someone who has not seen this work pick up where you left off from this report alone?',
    ],
    duration_estimate: '10-20 minutes',
  };
}
