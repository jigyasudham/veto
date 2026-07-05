// Decision Engine — collects all votes, calculates final verdict
import type { AgentVote, CouncilVerdict, DebateResult } from './types.js';
import { extractDecision } from './decision-extractor.js';

type Votes = DebateResult['votes'];

export function decide(votes: Votes): {
  final_verdict: CouncilVerdict;
  block_reasons: string[];
  warnings: string[];
  recommended: string;
} {
  const entries: Array<[string, AgentVote]> = [
    ['Lead Developer', votes.lead_dev],
    ['Product Manager', votes.pm],
    ['System Architect', votes.architect],
    ['UX Designer', votes.ux],
    ["Devil's Advocate", votes.devil],
    ['Legal & Compliance', votes.legal],
    ['Security', votes.security],
  ];

  // Expert agents — their block is always RED regardless of other votes
  const CRITICAL = new Set(['Lead Developer', 'System Architect', 'Legal & Compliance', 'Security']);

  const blockers = entries.filter(([, v]) => v.verdict === 'block');
  const warners = entries.filter(([, v]) => v.verdict === 'warn');
  const approvers = entries.filter(([, v]) => v.verdict === 'approve');

  const criticalBlockers = blockers.filter(([name]) => CRITICAL.has(name));
  const secondaryBlockers = blockers.filter(([name]) => !CRITICAL.has(name));
  const criticalApprovers = approvers.filter(([name]) => CRITICAL.has(name));

  // A warn only counts toward escalation when it names a specific risk.
  // Hedge-warns with no concerns are recorded as warnings but can't flip the verdict.
  const meaningfulWarners = warners.filter(([, v]) => v.concerns.some(c => typeof c === 'string' && c.length > 0));
  const criticalMeaningfulWarners = meaningfulWarners.filter(([name]) => CRITICAL.has(name));

  const block_reasons = blockers.map(([, v]) => v.reason);
  const warnings: string[] = [
    ...blockers.flatMap(([, v]) => v.concerns),
    ...warners.map(([, v]) => v.reason),
    ...warners.flatMap(([, v]) => v.concerns),
  ].filter((w): w is string => typeof w === 'string' && w.length > 0);

  let final_verdict: CouncilVerdict;

  if (criticalBlockers.length >= 1) {
    // Any expert domain agent blocks → RED, no debate
    final_verdict = 'RED';
  } else if (secondaryBlockers.length >= 2 && criticalApprovers.length >= 2) {
    // Business/UX objections vs technical approval — genuine split
    final_verdict = 'DEADLOCK';
  } else if (
    secondaryBlockers.length >= 1 ||
    meaningfulWarners.length >= 3 ||
    criticalMeaningfulWarners.length >= 2
  ) {
    // Escalate only on substantive dissent: a block, three agents naming real
    // risks, or two expert-domain agents naming real risks. The Devil's
    // Advocate warns on almost everything by design — one routine warn plus a
    // hedge must not be enough to fence-sit, or YELLOW carries no signal.
    final_verdict = 'YELLOW';
  } else {
    final_verdict = 'GREEN';
  }

  const recommendations = [
    ...blockers.map(([, v]) => v.recommendation).filter(Boolean),
    ...warners.map(([, v]) => v.recommendation).filter(Boolean),
  ] as string[];

  const recommended = recommendations.length > 0
    ? recommendations[0]
    : 'Proceed with standard implementation best practices.';

  return { final_verdict, block_reasons, warnings, recommended };
}

export function formatDebate(
  task: string,
  votes: Votes,
  verdict: CouncilVerdict,
  block_reasons: string[],
  warnings: string[],
  recommended: string,
): string {
  const AGENT_ICONS: Record<keyof Votes, string> = {
    lead_dev: '🔵',
    pm: '🟢',
    architect: '🏛️ ',
    ux: '🎨',
    devil: '😈',
    legal: '⚖️ ',
    security: '🔒',
  };

  const AGENT_LABELS: Record<keyof Votes, string> = {
    lead_dev: 'Lead Dev:  ',
    pm: 'PM:        ',
    architect: 'Architect: ',
    ux: 'UX:        ',
    devil: 'Devil:     ',
    legal: 'Legal:     ',
    security: 'Security:  ',
  };

  const VERDICT_BADGE: Record<string, string> = {
    block: '[BLOCKING]',
    warn: '[WARN]',
    approve: '[APPROVE]',
  };

  const VERDICT_LINE: Record<CouncilVerdict, string> = {
    GREEN: '✅ VERDICT: GREEN — All clear. Proceed.',
    YELLOW: '⚠️  VERDICT: YELLOW — Proceed with caution.',
    RED: '🚫 VERDICT: RED — BLOCKED.',
    DEADLOCK: '⚖️  VERDICT: DEADLOCK — Council is split. You decide.',
  };

  const divider = '─'.repeat(54);
  const lines: string[] = [
    '',
    '⚠️  VETO COUNCIL INITIATED',
    divider,
    '',
  ];

  const keys: Array<keyof Votes> = ['lead_dev', 'pm', 'architect', 'ux', 'devil', 'legal', 'security'];

  for (const key of keys) {
    const vote = votes[key];
    const icon = AGENT_ICONS[key];
    const label = AGENT_LABELS[key];
    const badge = VERDICT_BADGE[vote.verdict];
    const prefix = `${icon} ${label}`;
    const indent = '             ';

    const shortReason = vote.reason.length > 46 ? vote.reason.slice(0, 43) + '...' : vote.reason;
    lines.push(`${prefix}${shortReason} ${badge}`);

    for (const concern of vote.concerns.slice(0, 2)) {
      const short = concern.length > 46 ? concern.slice(0, 43) + '...' : concern;
      lines.push(`${indent}↳ ${short}`);
    }

    // Non-voting topical guidance — shown, but never part of the verdict
    if (vote.advice) {
      const firstLine = vote.advice.split('\n')[0];
      const short = firstLine.length > 40 ? firstLine.slice(0, 37) + '...' : firstLine;
      lines.push(`${indent}💡 ${short} [advisory]`);
    }
  }

  lines.push('');
  lines.push(divider);
  lines.push(VERDICT_LINE[verdict]);
  lines.push('');

  if (block_reasons.length > 0) {
    lines.push('🚫 Blocked because:');
    for (const r of block_reasons) {
      lines.push(`   • ${r}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    const shown = warnings.slice(0, 4);
    const extra = warnings.length - shown.length;
    lines.push(`⚠️  Warning${warnings.length > 1 ? 's' : ''}:`);
    for (const w of shown) {
      lines.push(`   • ${w}`);
    }
    if (extra > 0) lines.push(`   • ...and ${extra} more`);
    lines.push('');
  }

  // Council position on a binary choice — surface which option most agents prefer
  const decision = extractDecision(task);
  if (decision.isDecisionTask) {
    const allRecs = Object.values(votes)
      .map(v => v.recommendation ?? '')
      .filter(Boolean)
      .join(' ');
    const prefersA = (allRecs.match(new RegExp(`"${decision.optionA.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')) ?? []).length;
    const prefersB = (allRecs.match(new RegExp(`"${decision.optionB.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')) ?? []).length;
    if (prefersA > prefersB) {
      lines.push(`🎯 Council leans toward: "${decision.optionA}" (${prefersA} agent${prefersA !== 1 ? 's' : ''} prefer it)`);
    } else if (prefersB > prefersA) {
      lines.push(`🎯 Council leans toward: "${decision.optionB}" (${prefersB} agent${prefersB !== 1 ? 's' : ''} prefer it)`);
    } else {
      lines.push(`🎯 Council is split on: "${decision.optionA}" vs "${decision.optionB}" — see agent recommendations below`);
    }
  }

  lines.push(`✅ Recommended: ${recommended}`);

  if (verdict === 'RED') {
    lines.push('');
    lines.push('Override with: proceed anyway [not recommended]');
  } else if (verdict === 'DEADLOCK') {
    lines.push('');
    lines.push('Council is split. Your call: [proceed / abort]');
  }

  lines.push('');
  return lines.join('\n');
}
