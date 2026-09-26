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
  llm_backed?: boolean;
  model?: string;
  /**
   * The artifact a generator tool needs back (a Mermaid diagram, a commit
   * message, a documented file…). When set, the LLM is asked for exactly this
   * shape instead of a plan or an analysis, and the answer is checked against
   * it. Without it, generators used to read a "2-3 sentence" plan field as a
   * whole file, and fell back to unrelated deterministic text when no LLM ran.
   */
  deliverable?: Deliverable;
}

export interface Deliverable {
  /** What to produce, in one or two sentences. */
  description: string;
  /** The keys of the "deliverable" object, each with what it must hold. */
  shape: Record<string, string>;
  /** Keys that must be present and non-empty for the answer to count. */
  required: string[];
  /** Response budget for sampling (default 3000). */
  max_tokens?: number;
}

export interface AgenticAgentPrompt {
  mode: 'agentic';
  agent: WorkerAgentType;
  instruction: string;
  output_prompt: string;
  schema: string;
}

export interface AgentResult {
  id: string;
  agent: WorkerAgentType;
  plan?: AgentPlan;
  analysis?: AgentAnalysis;
  /** The checked deliverable object, when the task asked for one and an LLM produced it. */
  deliverable?: Record<string, unknown>;
  output: AgentOutput;          // always present — derived from plan or analysis
  duration_ms: number;
  llm_backed?: boolean;         // true when result came from MCP Sampling, false when deterministic
  llm_upgrade?: {
    available: true;
    instruction: string;
    prompt: AgenticAgentPrompt;
  };
  error?: string;
}
