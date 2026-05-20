// Extracts a binary architectural choice from a task description.
// Used by all council agents to frame their votes against the specific decision.

import type { AgentVote } from './types.js';

export interface DecisionContext {
  isDecisionTask: boolean;
  optionA: string;
  optionB: string;
}

const NULL_CTX: DecisionContext = { isDecisionTask: false, optionA: '', optionB: '' };

function cleanOption(s: string): string {
  return s
    .replace(/^(build|add|use|keep|go\s+with|implement|we\s+should\s+)?/i, '')
    .replace(/[,.\s]+$/, '')
    .trim()
    .slice(0, 70);
}

export function extractDecision(task: string): DecisionContext {
  const flat = task.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');

  // "X vs Y" or "X versus Y"
  const vsMatch = flat.match(/(.{8,90}?)\s+(?:vs\.?|versus)\s+(.{8,90}?)(?:[.?!]|$)/i);
  if (vsMatch) {
    const a = cleanOption(vsMatch[1].split(/[?!—–]/).pop() ?? '');
    const b = cleanOption(vsMatch[2].split(/[,?!.—–]/)[0]);
    if (a.length >= 4 && b.length >= 4) return { isDecisionTask: true, optionA: a, optionB: b };
  }

  // "should we [A] or [B]" / "should we [A], or keep [B]" / "should we [A] — or [B]"
  const shouldMatch = flat.match(/should\s+we\s+(.{8,140}?)\s*,?\s*(?:—\s*)?or\s+(?:keep\s+|go\s+with\s+)?(.{8,120})(?:[?.]|$)/i);
  if (shouldMatch) {
    const a = cleanOption(shouldMatch[1]);
    const b = cleanOption(shouldMatch[2].split(/[,?.!]/)[0]);
    if (a.length >= 4 && b.length >= 4) return { isDecisionTask: true, optionA: a, optionB: b };
  }

  // "X approach/pattern or Y approach/pattern"
  const approachMatch = flat.match(/(.{5,60}?)\s+(?:approach|option|pattern|strategy|method)\s+or\s+(.{5,60}?)\s+(?:approach|option|pattern|strategy|method)/i);
  if (approachMatch) {
    const a = cleanOption(approachMatch[1]);
    const b = cleanOption(approachMatch[2]);
    if (a.length >= 4 && b.length >= 4) return { isDecisionTask: true, optionA: a, optionB: b };
  }

  return NULL_CTX;
}

// Returns which option is preferred from a given agent's perspective.
// riskPatterns: regex matching traits that make an option RISKIER for this domain.
// Counts occurrences so a single safe word can't cancel a strong risk signal.
export function pickSide(
  optionA: string,
  optionB: string,
  riskPatterns: RegExp,
): { preferred: string; avoided: string } | null {
  const g = new RegExp(riskPatterns.source, 'gi');
  const aHits = (optionA.match(g) ?? []).length;
  const bHits = (optionB.match(g) ?? []).length;
  if (aHits > bHits) return { preferred: optionB, avoided: optionA };
  if (bHits > aHits) return { preferred: optionA, avoided: optionB };
  return null;
}

// Reframes an existing vote to explicitly address the architectural choice.
export function reframeVote(
  vote: AgentVote,
  ctx: DecisionContext,
  preferred: string | null,
  domainAdvice: string,
): AgentVote {
  if (!ctx.isDecisionTask) return vote;
  const { optionA, optionB } = ctx;
  const rec = preferred
    ? `Prefer "${preferred}" — ${domainAdvice}`
    : domainAdvice || vote.recommendation || '';
  return {
    ...vote,
    reason: `[${optionA} vs ${optionB}] ${vote.reason}`,
    recommendation: rec,
  };
}
