// Product Manager — ship value fast, cut scope ruthlessly
import type { AgentVote } from './types.js';

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /rewrite.{0,20}from.{0,10}scratch/i,
    reason: 'Rewriting from scratch abandons working code and delays users by months.',
    recommendation: 'Incremental refactor using Strangler Fig. Split only when bottleneck is proven.',
  },
  {
    pattern: /build.{0,20}(our own|custom).{0,20}(framework|orm|database|auth.?system|message.?queue)/i,
    reason: 'Building custom infrastructure has a 12+ month cost before it provides value.',
    recommendation: 'Use battle-tested existing solutions. Build what differentiates you, not plumbing.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /\bmicroservice/i,
    concern: 'Microservices add 10x operational complexity. Justified only at Netflix/Amazon scale.',
    recommendation: 'Start modular monolith. Extract services only when a specific bottleneck demands it.',
  },
  {
    pattern: /enterprise.{0,20}(grade|pattern|architecture|solution)/i,
    concern: 'Enterprise patterns optimize for 10,000-person orgs, not fast-moving products.',
    recommendation: 'Ship the simple version. Add enterprise complexity when customers pay for it.',
  },
  {
    pattern: /future.{0,20}proof|build.{0,20}for.{0,20}(scale|growth|million)/i,
    concern: 'Optimizing for imaginary future scale delays value to users you have today.',
    recommendation: "YAGNI. Build for 10x current scale, not 1000x. You'll know when you need more.",
  },
  {
    pattern: /\bperfect\b|\bflawless\b|fully.{0,10}generic|completely.{0,10}flexible/i,
    concern: 'Perfect is the enemy of shipped. What is the minimum version that solves the problem?',
    recommendation: 'Define a specific "done" criterion. Timebox perfection work to 20% of total.',
  },
  {
    pattern: /build.{0,20}(framework|platform|engine|layer|system)\b.{0,20}first/i,
    concern: 'Building infrastructure before product delays user value. Products fund platforms.',
    recommendation: 'Build product features. Extract the framework only when the pattern is proven.',
  },
  {
    pattern: /abstrac|generic.{0,20}(solution|framework|wrapper|handler)/i,
    concern: 'Premature abstraction bets on requirements that may never come.',
    recommendation: 'Three concrete implementations before extracting an abstraction.',
  },
  {
    pattern: /add.{0,20}feature.{0,30}(not.{0,10}ask|nobody.{0,10}request|just.{0,10}in.{0,10}case)/i,
    concern: 'Building unrequested features is scope creep. Validate demand first.',
    recommendation: 'Ship what was asked. Add features after user feedback confirms demand.',
  },
  {
    pattern: /v2|v3|version\s+[23]/i,
    concern: 'Designing v2/v3 before v1 ships is a classic focus trap.',
    recommendation: 'Ship v1. Learn from real users. Then plan v2 with real data.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no product concerns.', concerns: [] };
  }

  const blocks: Array<{ reason: string; recommendation: string }> = [];
  const concerns: string[] = [];
  const recommendations: string[] = [];

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(task)) {
      blocks.push({ reason: rule.reason, recommendation: rule.recommendation });
    }
  }
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(task)) {
      concerns.push(rule.concern);
      recommendations.push(rule.recommendation);
    }
  }

  if (blocks.length > 0) {
    return {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: blocks.slice(1).map(b => b.reason),
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  }

  if (concerns.length > 0) {
    return {
      verdict: 'warn',
      reason: `${concerns.length} product risk${concerns.length > 1 ? 's' : ''} — scope or complexity concern.`,
      concerns,
      recommendation: recommendations[0],
    };
  }

  return { verdict: 'approve', reason: 'Reasonable scope. Ship it.', concerns: [] };
}
