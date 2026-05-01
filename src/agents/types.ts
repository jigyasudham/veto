export type WorkerAgentType =
  | 'coder' | 'reviewer' | 'tester' | 'debugger' | 'refactor'
  | 'database' | 'api' | 'frontend' | 'backend' | 'devops'
  | 'performance' | 'migration'
  | 'security-scanner' | 'auth' | 'privacy' | 'secrets'
  | 'dependency-audit' | 'penetration'
  | 'context-manager' | 'decision-logger' | 'project-mapper'
  | 'pattern-learner' | 'knowledge-base'
  | 'researcher' | 'tech-advisor' | 'cost-analyzer'
  | 'competitor-analyzer' | 'risk-assessor' | 'estimator'
  | 'ethics-bias';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AgentFinding {
  severity: FindingSeverity;
  category: string;
  description: string;
  fix: string;
  location?: string;
  cwe?: string;
  owasp?: string;
}

export interface AgentPlan {
  agent: WorkerAgentType;
  task: string;
  tier: 1 | 2 | 3;
  approach: string;
  steps: string[];
  checklist: string[];
  pitfalls: string[];
  patterns: string[];
  duration_estimate: string;
}

export interface AgentAnalysis {
  agent: WorkerAgentType;
  subject: string;
  findings: AgentFinding[];
  score: number;
  verdict: 'approved' | 'approved_with_warnings' | 'needs_revision' | 'rejected';
  summary: string;
  critical_count: number;
  high_count: number;
}

export interface AgentTask {
  id: string;
  agent: WorkerAgentType;
  task: string;
  code?: string;
  context?: string;
}

export interface AgentResult {
  id: string;
  agent: WorkerAgentType;
  plan?: AgentPlan;
  analysis?: AgentAnalysis;
  duration_ms: number;
  error?: string;
}
