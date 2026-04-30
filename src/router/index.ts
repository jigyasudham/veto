// Router entry point — composes all sub-modules into a single routeTask() call

import { scoreComplexity } from './complexity-scorer.js';
import { selectModel } from './model-selector.js';
import { getRateStatus, trackRequest, getRoutingAdvice } from './rate-monitor.js';
import { compressContext, estimateTokens } from './context-compressor.js';
import { recordOutcome, getLearningStats } from './learning-updater.js';

export type { ComplexityResult, ComplexityFactors } from './complexity-scorer.js';
export type { AgentType, Tier, ModelRecommendation } from './model-selector.js';
export type { Platform, RateLimitEntry, RateStatus } from './rate-monitor.js';
export type { CompressionStrategy, CompressionResult } from './context-compressor.js';
export type { LearningStats } from './learning-updater.js';
export { estimateTokens, getRateStatus, trackRequest, recordOutcome, getLearningStats };

export type RouteOptions = {
  agentType?: import('./model-selector.js').AgentType;
  filesAffected?: number;
  forceCouncil?: boolean;
  context?: string;
  relevantFiles?: string[];
  preferredPlatform?: import('./rate-monitor.js').Platform;
};

export type RouteResult = {
  complexity: import('./complexity-scorer.js').ComplexityResult;
  model: import('./model-selector.js').ModelRecommendation;
  rate_status: import('./rate-monitor.js').RateStatus;
  context_plan?: import('./context-compressor.js').CompressionResult;
  effective_platform: import('./rate-monitor.js').Platform;
  routed_at: string;
};

export function routeTask(task: string, options: RouteOptions = {}): RouteResult {
  const complexity = scoreComplexity(task, options.filesAffected, options.forceCouncil);
  const model = selectModel(complexity.score, options.agentType ?? 'dynamic');

  const preferred = options.preferredPlatform ?? 'claude';
  // Only shift Tier 1/2 away from Claude on warning; Tier 3 always stays on best model
  const effective_platform =
    model.tier === 3 ? preferred : getRoutingAdvice(preferred);

  trackRequest(effective_platform);

  const rate_status = getRateStatus();

  const context_plan = options.context
    ? compressContext(options.context, options.relevantFiles ?? [])
    : undefined;

  return {
    complexity,
    model,
    rate_status,
    context_plan,
    effective_platform,
    routed_at: new Date().toISOString(),
  };
}
