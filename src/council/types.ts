export type AgentVerdict = 'approve' | 'warn' | 'block';
export type CouncilVerdict = 'GREEN' | 'YELLOW' | 'RED' | 'DEADLOCK';

export interface AgentVote {
  verdict: AgentVerdict;
  reason: string;
  concerns: string[];
  recommendation?: string;
  // Non-voting topical guidance. Shown to the user but never counted by the
  // decision engine — only concrete rule matches (concerns) can move the verdict.
  advice?: string;
  /** Who produced the vote: an LLM, or the keyword rules used when none is available. */
  source?: 'llm' | 'rules';
}

export type CouncilStrictness = 'fast' | 'standard' | 'strict';

export interface DebateInput {
  task: string;
  context?: string;
  project_dir?: string;
  strictness?: CouncilStrictness;
  architect_model?: string;
  editor_model?: string;
}

export interface DebateResult {
  task: string;
  final_verdict: CouncilVerdict;
  votes: {
    lead_dev: AgentVote;
    pm: AgentVote;
    architect: AgentVote;
    ux: AgentVote;
    devil: AgentVote;
    legal: AgentVote;
    security: AgentVote;
  };
  recommended: string;
  block_reasons: string[];
  warnings: string[];
  /** How many of the seven votes an LLM actually produced (set by runLlmDebate). */
  llm_votes?: number;
  debated_at: string;
  formatted_output: string;
}
