export type AgentVerdict = 'approve' | 'warn' | 'block';
export type CouncilVerdict = 'GREEN' | 'YELLOW' | 'RED' | 'DEADLOCK';

export interface AgentVote {
  verdict: AgentVerdict;
  reason: string;
  concerns: string[];
  recommendation?: string;
}

export interface DebateInput {
  task: string;
  context?: string;
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
  debated_at: string;
  formatted_output: string;
}
