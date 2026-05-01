// Skill: learning-loop — how to feed outcome data back into the router and agents

export interface SkillInput { task: string; context?: string; options?: Record<string, unknown>; }
export interface SkillOutput { skill: string; template?: string; checklist: string[]; patterns: string[]; gotchas: string[]; resources: string[]; }

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'learning-loop',
    template: `
// ── Learning Loop Protocol ────────────────────────────────────────────────
//
// The router gets smarter when you record task outcomes.
// Without outcome data, thresholds stay at the default 30/70 forever.
//
// Step 1: Complete a task
//
// Step 2: Score the output quality (0–100):
//   90–100  Excellent — exactly what was needed, no revision required
//   70–89   Good — minor revisions needed
//   50–69   Acceptable — significant revision needed but usable
//   30–49   Poor — required a full rewrite
//   0–29    Failed — output was wrong or harmful
//
// Step 3: Record via veto_record_outcome:
//   {
//     task_type: "write-auth-middleware",  // short label, consistent naming helps
//     complexity: 58,                      // from veto_route_task result
//     model_tier: 2,                       // tier that was actually used
//     agent: "coder",                      // agent type used
//     output_quality: 87,                  // your score
//     tokens_used: 1240                    // optional but useful
//   }
//
// Step 4: After 20+ outcomes: call veto_learning_apply
//   The router reads the quality data and adjusts tier1_max and tier2_max
//   Adjustment is conservative — it needs 20+ data points to act
//
// Step 5: Check veto_learning_stats to see what changed
`.trim(),
    checklist: [
      'Record every task outcome, not just the bad ones — the loop needs both successes and failures',
      'Use consistent task_type labels across sessions (e.g. "write-unit-tests" not "tests")',
      'Score output quality honestly — over-reporting quality prevents threshold improvement',
      'Include tokens_used when possible — this feeds cost/quality optimisation',
      'Call veto_learning_apply after every 10 new outcomes to keep thresholds current',
      'Call veto_learning_stats monthly to review the tier distribution and agent performance',
      'If an agent consistently scores below 70%: check veto_agent_performance_stats for patterns',
      'Council insights: review veto_council_insights monthly to see if any GREEN verdicts led to debugging',
    ],
    patterns: [
      'Consistent labelling: task_type labels that vary prevent pattern detection ("test" vs "write-tests" vs "unit-tests" are invisible to the loop)',
      'Regular application: apply thresholds every 10 outcomes — waiting for 100 delays improvement by months',
      'Quality honesty: the loop self-corrects only when quality scores reflect reality',
      'Council correlation: the council insights loop needs decisions logged with veto_memory_store to work',
    ],
    gotchas: [
      'Only recording failures — a loop trained on failures sees everything as over-tiered',
      'Inconsistent task_type labels — "auth", "authentication", "write-auth" look like three different task types',
      'Not calling veto_learning_apply — recording outcomes without applying has zero effect on routing',
      'Applying thresholds with fewer than 20 data points — results will be noisy and unreliable',
    ],
    resources: [
      'veto_record_outcome — record a task quality score',
      'veto_learning_apply — apply recorded outcomes to adjust tier thresholds',
      'veto_learning_stats — view tier distribution, agent performance, and suggested thresholds',
      'veto_council_insights — review council decisions correlated with debugging sessions',
    ],
  };
}
