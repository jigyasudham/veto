// Router learning tools: record an outcome, inspect learning stats, and force-
// apply learned routing thresholds. Pure handlers over the router's learning
// store — no server-local state.

import {
  recordOutcome, getLearningStats, getLearnedThresholds, applyLearnedThresholds,
  getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights,
} from '../../router/index.js';
import type { HandlerMap } from '../registry.js';

export const learningHandlers: HandlerMap = {
  veto_record_outcome: ({ args }) => {
    const task_type = String(args?.task_type ?? '').trim();
    const complexity = typeof args?.complexity === 'number' ? args.complexity : 50;
    const model_tier = (typeof args?.model_tier === 'number' ? args.model_tier : 2) as 1 | 2 | 3;
    const output_quality = typeof args?.output_quality === 'number' ? args.output_quality : 70;
    if (!task_type) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task_type is required.' }) }], isError: true };
    }
    const rec = recordOutcome(task_type, complexity, model_tier, args?.agent ? String(args.agent) : 'dynamic', output_quality, typeof args?.tokens_used === 'number' ? args.tokens_used : 0, args?.file_ext ? String(args.file_ext) : undefined);
    const stats = getLearningStats();
    const nextStep = rec.auto_applied
      ? `Router thresholds auto-updated from ${rec.total} recorded outcomes.`
      : stats.total_tasks >= 20
        ? 'Thresholds auto-apply every 20 outcomes; call veto_learning_apply to force an update now.'
        : `${20 - stats.total_tasks} more outcome(s) until the router auto-applies learned thresholds.`;
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Outcome recorded.', total_outcomes: stats.total_tasks, auto_applied: rec.auto_applied, next_step: nextStep }, null, 2) }] };
  },

  veto_learning_stats: ({ args }) => {
    const includeAgentStats = args?.include_agent_stats !== false;
    const includeTaskTypes = args?.include_task_types === true;
    const includeCouncil = args?.include_council_insights === true;

    const stats = getLearningStats();
    const learned = getLearnedThresholds();
    const result: Record<string, unknown> = {
      total_outcomes: stats.total_tasks,
      tier_breakdown: stats.tier_breakdown,
      current_thresholds: {
        tier1_max: learned.tier1_max,
        tier2_max: learned.tier2_max,
        source: learned.source,
        data_points: learned.data_points,
        note: learned.source === 'learned'
          ? `Learned from ${learned.data_points} outcomes.`
          : 'Using defaults — the router auto-applies learned thresholds every 20 recorded outcomes (or call veto_learning_apply to force it).',
      },
      suggested_thresholds: stats.suggested_thresholds,
      ready_to_apply: stats.total_tasks >= 20,
    };

    if (includeAgentStats) {
      result['agent_performance'] = getAgentPerformanceStats();
    }
    if (includeTaskTypes) {
      result['task_type_breakdown'] = getTaskTypeBreakdown();
    }
    if (includeCouncil) {
      result['council_insights'] = getCouncilInsights();
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  veto_learning_apply: () => {
    const result = applyLearnedThresholds();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
