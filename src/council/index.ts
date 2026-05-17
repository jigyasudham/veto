// Council orchestrator — runs all 7 agents in parallel, returns debate result
import { analyze as leadDevAnalyze } from './lead-developer.js';
import { analyze as pmAnalyze } from './product-manager.js';
import { analyze as architectAnalyze } from './system-architect.js';
import { analyze as uxAnalyze } from './ux-designer.js';
import { analyze as devilAnalyze } from './devil-advocate.js';
import { analyze as legalAnalyze } from './legal-compliance.js';
import { analyze as securityAnalyze } from './security.js';
import { decide, formatDebate } from './decision-engine.js';
import { buildContextString } from '../context/reader.js';

export type { AgentVote, AgentVerdict, CouncilVerdict, DebateInput, DebateResult } from './types.js';

import type { DebateInput, DebateResult } from './types.js';

export function runDebate(input: DebateInput): DebateResult {
  const enrichedContext = buildContextString(input.project_dir, input.context);
  const fullText = enrichedContext ? `${input.task}\n\n${enrichedContext}` : input.task;
  const strictness = input.strictness ?? 'standard';

  // fast: 3 core agents (dev + architect + security) — full council as fallback
  const lead_dev  = leadDevAnalyze(fullText);
  const architect = architectAnalyze(fullText);
  const security  = securityAnalyze(fullText);

  let pm       = pmAnalyze(fullText);
  let ux       = uxAnalyze(fullText);
  let devil    = devilAnalyze(fullText);
  let legal    = legalAnalyze(fullText);

  if (strictness === 'fast') {
    // Override non-core agents with silent approvals to preserve DebateResult shape
    const silent = (): import('./types.js').AgentVote => ({ verdict: 'approve', reason: 'skipped (fast mode)', concerns: [] });
    pm = silent(); ux = silent(); devil = silent(); legal = silent();
  }

  const votes = { lead_dev, pm, architect, ux, devil, legal, security };
  const { final_verdict, block_reasons, warnings, recommended } = decide(votes);

  if (strictness === 'strict' && block_reasons.length > 0) {
    // Rebuttal round: devil's advocate argues against the most critical blocker
    const rebuttalContext = `REBUTTAL REQUIRED. The council flagged this blocker:\n"${block_reasons[0]}"\nDevil's Advocate: argue why this concern may be overstated or how it can be mitigated.\n\n${fullText}`;
    const rebuttal = devilAnalyze(rebuttalContext);
    // Merge rebuttal reasoning into devil vote
    votes.devil = {
      verdict: rebuttal.verdict,
      reason: `[REBUTTAL] ${rebuttal.reason}`,
      concerns: rebuttal.concerns,
      recommendation: rebuttal.recommendation,
    };
  }

  const debated_at = new Date().toISOString();
  const formatted_output = formatDebate(input.task, votes, final_verdict, block_reasons, warnings, recommended);

  return {
    task: input.task,
    final_verdict,
    votes,
    recommended,
    block_reasons,
    warnings,
    debated_at,
    formatted_output,
  };
}
