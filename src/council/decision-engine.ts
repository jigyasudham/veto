// Decision Engine — collects all votes, calculates final verdict
import type { AgentVote, CouncilVerdict, DebateResult } from './types.js';

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
  ];

  const blockers = entries.filter(([, v]) => v.verdict === 'block');
  const warners = entries.filter(([, v]) => v.verdict === 'warn');
  const approvers = entries.filter(([, v]) => v.verdict === 'approve');

  const block_reasons = blockers.map(([, v]) => v.reason);
  const warnings: string[] = [
    ...blockers.flatMap(([, v]) => v.concerns),
    ...warners.map(([, v]) => v.reason),
    ...warners.flatMap(([, v]) => v.concerns),
  ].filter((w): w is string => typeof w === 'string' && w.length > 0);

  let final_verdict: CouncilVerdict;

  if (blockers.length >= 2 && approvers.length >= 2) {
    // Genuine split — neither side has majority
    final_verdict = 'DEADLOCK';
  } else if (blockers.length >= 1) {
    final_verdict = 'RED';
  } else if (warners.length >= 1) {
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
  };

  const AGENT_LABELS: Record<keyof Votes, string> = {
    lead_dev: 'Lead Dev:  ',
    pm: 'PM:        ',
    architect: 'Architect: ',
    ux: 'UX:        ',
    devil: 'Devil:     ',
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

  const keys: Array<keyof Votes> = ['lead_dev', 'pm', 'architect', 'ux', 'devil'];

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
