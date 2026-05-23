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
  | 'ethics-bias'
  | 'code-quality' | 'documentation' | 'accessibility' | 'compatibility' | 'error-handling'
  | 'task-planner' | 'task-coordinator' | 'file-manager' | 'git-agent'
  | 'search-agent' | 'reporter' | 'automation';

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

export interface LineRef {
  file: string;
  line: number;
  description: string;
}

export interface AgentOutput {
  confidence: number;           // 0.0 – 1.0
  severity: FindingSeverity;    // overall severity of the result
  recommendation: string;       // single-sentence action the caller should take
  affected_files: string[];     // files this plan/analysis touches
  line_refs: LineRef[];         // specific file:line pointers (populated by analyze agents)
}

export interface AgentTask {
  id: string;
  agent: WorkerAgentType;
  task: string;
  code?: string;
  context?: string;
  project_dir?: string;
}

export interface AgentResult {
  id: string;
  agent: WorkerAgentType;
  plan?: AgentPlan;
  analysis?: AgentAnalysis;
  output: AgentOutput;          // always present — derived from plan or analysis
  duration_ms: number;
  llm_backed?: boolean;         // true when result came from MCP Sampling, false when deterministic
  error?: string;
}
