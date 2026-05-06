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

  // All 7 agents are synchronous — run them all then collect results
  const lead_dev   = leadDevAnalyze(fullText);
  const pm         = pmAnalyze(fullText);
  const architect  = architectAnalyze(fullText);
  const ux         = uxAnalyze(fullText);
  const devil      = devilAnalyze(fullText);
  const legal      = legalAnalyze(fullText);
  const security   = securityAnalyze(fullText);

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
