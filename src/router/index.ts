// Router entry point — composes all sub-modules into a single routeTask() call

import { scoreComplexity } from './complexity-scorer.js';
import { selectModel } from './model-selector.js';
import { getRateStatus, trackRequest, trackTokens, getRoutingAdvice } from './rate-monitor.js';
import { compressContext, estimateTokens } from './context-compressor.js';
import { recordOutcome, getLearningStats, getLearnedThresholds, applyLearnedThresholds, getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights, getRecommendedAgent, isFeedbackEnabled, recordRoutingFeedback, getRoutingFeedbackStats, resetRoutingFeedback, listRoutingFeedback, setFeedbackEnabled } from './learning-updater.js';

export type { ComplexityResult, ComplexityFactors } from './complexity-scorer.js';
export type { AgentType, Tier, ModelRecommendation } from './model-selector.js';
export type { Platform, RateLimitEntry, RateStatus } from './rate-monitor.js';
export type { CompressionStrategy, CompressionResult } from './context-compressor.js';
export type { LearningStats, LearnedThresholds, AgentPerformanceStat, TaskTypeBreakdown, CouncilInsight, RoutingFeedbackStats, RoutingFeedbackEntry } from './learning-updater.js';
export { estimateTokens, getRateStatus, trackRequest, trackTokens, recordOutcome, getLearningStats, getLearnedThresholds, applyLearnedThresholds, getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights, getRecommendedAgent, isFeedbackEnabled, setFeedbackEnabled, recordRoutingFeedback, getRoutingFeedbackStats, resetRoutingFeedback, listRoutingFeedback };

export type RouteOptions = {
  agentType?: import('./model-selector.js').AgentType;
  filesAffected?: number;
  forceCouncil?: boolean;
  context?: string;
  relevantFiles?: string[];
  preferredPlatform?: import('./rate-monitor.js').Platform;
  sessionId?: string;
  architectModel?: string;
  editorModel?: string;
};

export type RouteResult = {
  complexity: import('./complexity-scorer.js').ComplexityResult;
  model: import('./model-selector.js').ModelRecommendation;
  rate_status: import('./rate-monitor.js').RateStatus;
  context_plan?: import('./context-compressor.js').CompressionResult;
  effective_platform: import('./rate-monitor.js').Platform;
  routed_at: string;
  feedback_enabled: boolean;
  feedback_id?: string;
};

export function routeTask(task: string, options: RouteOptions = {}): RouteResult {
  const learned = getLearnedThresholds();
  const complexity = scoreComplexity(task, options.filesAffected, options.forceCouncil, learned.source === 'learned' ? learned : undefined);
  const model = selectModel(complexity.score, options.agentType ?? 'dynamic', {
    architect_model: options.architectModel,
    editor_model: options.editorModel,
  });

  const preferred = options.preferredPlatform ?? 'claude';
  // Only shift Tier 1/2 away from Claude on warning; Tier 3 always stays on best model
  const effective_platform =
    model.tier === 3 ? preferred : getRoutingAdvice(preferred);

  trackRequest(effective_platform);

  const rate_status = getRateStatus();

  const context_plan = options.context
    ? compressContext(options.context, options.relevantFiles ?? [], effective_platform)
    : undefined;

  const feedback_enabled = isFeedbackEnabled();
  let feedback_id: string | undefined;
  if (feedback_enabled) {
    feedback_id = recordRoutingFeedback({
      task,
      complexity: complexity.score,
      model_tier: model.tier as 1 | 2 | 3,
      agent: options.agentType,
      session_id: options.sessionId,
    });
  }

  return {
    complexity,
    model,
    rate_status,
    context_plan,
    effective_platform,
    routed_at: new Date().toISOString(),
    feedback_enabled,
    feedback_id,
  };
}
