// Skill: cost-track — monitor and reduce AI token spend and infrastructure costs

export interface SkillInput { task: string; context?: string; options?: Record<string, unknown>; }
export interface SkillOutput { skill: string; checklist: string[]; patterns: string[]; gotchas: string[]; resources: string[]; }

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'cost-track',
    checklist: [
      'Call veto_learning_stats to see the current Tier 1/2/3 distribution',
      'A healthy distribution is roughly 40% T1 / 45% T2 / 15% T3 — more T3 than this is expensive',
      'Identify tasks that are routed to Tier 3 but could be Tier 2 with a better description',
      'Call veto_rate_status to check current daily usage % per platform',
      'If Claude is above 70%: T1/T2 tasks are already auto-routing to Gemini — verify this is working',
      'Call veto_agent_performance_stats to identify agents with low quality scores — they waste tokens on retries',
      'Record task outcomes via veto_record_outcome — this is the only way to measure actual cost/quality ratio',
      'After 20+ outcomes: call veto_learning_apply — learned thresholds reduce over-routing to expensive tiers',
      'Monthly: export veto_memory_export and review knowledge base size — prune irrelevant entries',
    ],
    patterns: [
      'Tier distribution monitoring: T3% × avg_T3_tokens = the main cost driver',
      'Outcome recording: quality data enables threshold calibration which directly reduces cost',
      'Rate limit utilisation: 70–90% is healthy; under 30% means you are paying for unused capacity',
      'Context compression: veto_route_task with context= returns a compression plan — use it',
    ],
    gotchas: [
      'Not recording outcomes — the learning loop cannot calibrate without quality data',
      'Treating all Tier 3 tasks as justified — many are there because of a short description, not actual complexity',
      'Ignoring context compression — a 15,000 token context costs 10× more than a compressed 1,500 token context',
      'Optimising AI cost while ignoring developer time — developer time is almost always the larger cost',
    ],
    resources: [
      'veto_learning_stats — current tier distribution and suggested thresholds',
      'veto_rate_status — daily usage % per platform',
      'veto_learning_apply — apply learned thresholds to reduce over-routing',
      'veto_record_outcome — record output quality to feed the cost/quality calibration loop',
    ],
  };
}
