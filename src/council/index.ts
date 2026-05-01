// Council orchestrator — runs all 7 agents in parallel, returns debate result
import { analyze as leadDevAnalyze } from './lead-developer.js';
import { analyze as pmAnalyze } from './product-manager.js';
import { analyze as architectAnalyze } from './system-architect.js';
import { analyze as uxAnalyze } from './ux-designer.js';
import { analyze as devilAnalyze } from './devil-advocate.js';
import { analyze as legalAnalyze } from './legal-compliance.js';
import { analyze as securityAnalyze } from './security.js';
import { decide, formatDebate } from './decision-engine.js';

export type { AgentVote, AgentVerdict, CouncilVerdict, DebateInput, DebateResult } from './types.js';

import type { DebateInput, DebateResult } from './types.js';

export async function runDebate(input: DebateInput): Promise<DebateResult> {
  const fullText = input.context ? `${input.task}\n${input.context}` : input.task;

  // All 7 agents run in parallel — none depend on each other
  const [lead_dev, pm, architect, ux, devil, legal, security] = await Promise.all([
    Promise.resolve(leadDevAnalyze(fullText)),
    Promise.resolve(pmAnalyze(fullText)),
    Promise.resolve(architectAnalyze(fullText)),
    Promise.resolve(uxAnalyze(fullText)),
    Promise.resolve(devilAnalyze(fullText)),
    Promise.resolve(legalAnalyze(fullText)),
    Promise.resolve(securityAnalyze(fullText)),
  ]);

  const votes = { lead_dev, pm, architect, ux, devil, legal, security };
  const { final_verdict, block_reasons, warnings, recommended } = decide(votes);
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
