// Product Manager — ship value fast, cut scope ruthlessly
import type { AgentVote } from './types.js';
import { extractDecision, pickSide, reframeVote } from './decision-extractor.js';

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
    pattern: /\bv2(?!\.\d)|\bv3(?!\.\d)|\bversion\s+[23]\b/i,
    concern: 'Designing v2/v3 before v1 ships is a classic focus trap.',
    recommendation: 'Ship v1. Learn from real users. Then plan v2 with real data.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

const TOPIC_INSIGHTS: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /vscode|vs.?code|ide|extension|sidebar|editor/i,
    concern: 'IDE extensions have extremely high discoverability value — they make a tool real for developers who never touch a terminal. But extension development is a separate build pipeline, separate publish cycle, and a significant maintenance surface.',
    recommendation: 'Scope the extension to the minimal feature set that creates daily habit: status bar + one command. Do not build the full sidebar until the core install flow is proven.',
  },
  {
    pattern: /auto.?save|auto.?session|background.?save/i,
    concern: 'Auto-save adds background noise — every user will see silent saves they did not trigger. The question is whether they trust it or find it alarming.',
    recommendation: 'Show a subtle indicator when auto-save fires (e.g. "session saved" in status bar). Give users a way to disable it. Default threshold at 70% context is reasonable.',
  },
  {
    pattern: /github|pr|pull.?request|jira|linear|issue/i,
    concern: 'External integrations require API keys, OAuth flows, and rate limit handling for third-party services. Scope creep risk is high: users will expect full two-way sync once you ship read-only.',
    recommendation: 'Ship read-only first: fetch PR diff and run analysis. Do not ship comment-posting until the read path is validated by real users.',
  },
  {
    pattern: /llm|model.?call|ai.?backend|gpt|claude.?api|gemini.?api/i,
    concern: 'LLM-backed agents will increase response latency from <100ms to 2–30s. Users who currently get instant responses will notice this immediately.',
    recommendation: 'Show a loading indicator for LLM-backed operations. Make LLM backing opt-in per agent, not forced. Keep the fast heuristic path available as a fallback.',
  },
  {
    pattern: /phase|roadmap|plan|milestone|feature.?list/i,
    concern: 'Phases planned without user validation risk building features nobody wants. The strongest MCP servers grew from a single killer feature, not a comprehensive roadmap.',
    recommendation: 'Identify the one feature that would make users tell others about Veto. Ship that first. Use real install/usage metrics to prioritise the next phase.',
  },
  {
    pattern: /discover|onboard|help|tutorial|guide|doc/i,
    concern: 'A large tool surface (90+ tools) is above the cognitive load threshold for new users. Without discoverability, most tools will never be used — this is the retention killer for complex products.',
    recommendation: 'Add veto_discover immediately. Track which tools get called most. Consider a first-run guided experience via veto_status output.',
  },
  {
    pattern: /mcp.?server|tool.?count|tool.?list/i,
    concern: 'More tools ≠ more value. Each additional tool increases the cognitive load on users and the maintenance burden on you. The most successful MCP servers have 5–10 sharp tools, not 40+.',
    recommendation: 'Audit tool usage data. If any tool has zero calls in 30 days, deprecate it. Consolidate tools that overlap in function.',
  },
];

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

  let vote: AgentVote;

  if (blocks.length > 0) {
    vote = {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: blocks.slice(1).map(b => b.reason),
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  } else if (concerns.length > 0) {
    vote = {
      verdict: 'warn',
      reason: `${concerns.length} product risk${concerns.length > 1 ? 's' : ''} — scope or complexity concern.`,
      concerns,
      recommendation: recommendations[0],
    };
  } else {
    const matched = TOPIC_INSIGHTS.filter(t => t.pattern.test(task));
    if (matched.length > 0) {
      const top = matched.slice(0, 2);
      vote = {
        verdict: 'warn',
        reason: top[0].concern,
        concerns: top.slice(1).map(t => t.concern),
        recommendation: top.map(t => t.recommendation).join(' | '),
      };
    } else {
      vote = { verdict: 'approve', reason: 'Reasonable scope. Ship it.', concerns: [] };
    }
  }

  return applyDecisionStance(vote, task);
}

// PM risk: options that add scope, infrastructure, or delay time-to-value
const PM_RISK = /\b(http|express|rest.?api|api.?layer|new\s+(server|layer|transport)|oauth|auth.?system|bundl)\b/i;

function applyDecisionStance(vote: AgentVote, task: string): AgentVote {
  const ctx = extractDecision(task);
  if (!ctx.isDecisionTask) return vote;
  const { optionA, optionB } = ctx;
  const side = pickSide(optionA, optionB, PM_RISK);
  const advice = side
    ? `"${side.preferred}" ships faster and has lower scope risk. Defer "${side.avoided}" until users explicitly request it and usage data justifies the investment.`
    : `Evaluate which option delivers user value sooner. Ship the simpler path; add complexity only once real demand is confirmed.`;
  return reframeVote(vote, ctx, side?.preferred ?? null, advice);
}
