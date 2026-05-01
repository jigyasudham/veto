import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isTokenCost = t.includes('token') || t.includes('ai cost') || t.includes('api cost') || t.includes('llm');
  const isInfra = t.includes('hosting') || t.includes('server') || t.includes('cloud') || t.includes('infra');

  const approach = isTokenCost
    ? 'Analyse AI token costs across all three platforms. Track tokens-per-task, cost-per-tier, and cost trajectory over time. Identify the top 3 cost drivers and recommend routing adjustments. A 20% reduction in average tier without quality loss is typically achievable via better router threshold calibration.'
    : isInfra
    ? 'Analyse infrastructure costs by service. Identify idle resources, over-provisioned instances, and services that could be consolidated. Compare reserved vs. on-demand pricing for predictable workloads. Document the cost-per-feature to identify which features have disproportionate infrastructure cost.'
    : 'Track the three cost categories in this project: AI token spend, infrastructure, and developer time. Developer time is almost always the largest cost and the most under-tracked. Quantify each category, identify the top driver, and recommend the highest-ROI reduction.';

  return {
    agent: 'cost-analyzer' as WorkerAgentType,
    task,
    tier: 1,
    approach,
    steps: [
      'Identify which cost category to analyse: AI tokens, infrastructure, or developer time',
      'For token costs: call veto_rate_status and veto_learning_stats to get tier distribution',
      'Calculate average cost per task by tier (Tier 1 ≈ $0.001, Tier 2 ≈ $0.01, Tier 3 ≈ $0.05)',
      'Identify tasks that are over-tiered: Tier 3 tasks with output quality achievable at Tier 2',
      'For infrastructure: list monthly costs per service and idle/utilisation %',
      'For developer time: estimate hours lost to context switches, re-explanation, and tool friction',
      'Rank cost drivers by monthly impact ($ or hours)',
      'Propose the top 3 changes with estimated savings and implementation cost',
      'Calculate ROI for each proposal: savings per month / implementation cost in days',
      'Store cost analysis in veto_memory_store (type="reference", tags=["cost", "performance"])',
    ],
    checklist: [
      '[ ] Cost category identified and scoped',
      '[ ] Current monthly cost baseline established',
      '[ ] Top 3 cost drivers identified and ranked by impact',
      '[ ] At least one reduction proposal with estimated ROI',
      '[ ] Developer time cost estimated (not just infrastructure)',
      '[ ] Cost reduction proposals ranked by ROI, not just absolute savings',
    ],
    pitfalls: [
      'Optimising infrastructure cost while ignoring developer time — wrong priority',
      'Treating all Tier 3 tasks as necessary — many can be downgraded with better descriptions',
      'Not establishing a baseline before optimising — you cannot measure improvement without it',
      'Optimising for the cheapest option instead of the best cost/quality ratio',
      'Ignoring the cost of the optimisation itself — a 5% savings that takes 2 weeks is not worth it',
    ],
    patterns: [
      'Baseline-first: measure before optimising',
      'ROI ranking: sort proposals by monthly savings / implementation cost, not just savings',
      'Developer time inclusion: add estimated developer friction hours to every cost analysis',
      'Tier distribution analysis: the ratio of T1/T2/T3 tasks directly predicts AI spend',
    ],
    duration_estimate: '1-2 hours',
  };
}
