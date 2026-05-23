import type { WorkerAgentType } from './types.js';

export type AgentOutputType = 'plan' | 'analysis';
export type AgentDomain = 'development' | 'security' | 'memory' | 'research' | 'quality' | 'workflow';

export interface AgentManifestEntry {
  id: WorkerAgentType;
  role: string;
  output_type: AgentOutputType;
  domain: AgentDomain;
}

export const AGENT_MANIFEST: AgentManifestEntry[] = [
  // Development
  { id: 'coder',       role: 'Implements new features and writes production code. Detects task category (API, UI, service, utility) and returns a structured implementation plan.',               output_type: 'plan',     domain: 'development' },
  { id: 'reviewer',    role: 'Reviews code for bugs, style violations, and maintainability issues. Returns scored findings with severity and specific fix recommendations.',                       output_type: 'analysis', domain: 'development' },
  { id: 'tester',      role: 'Designs and writes test suites for unit, integration, and end-to-end scenarios. Plans coverage strategy and identifies edge cases to validate.',                    output_type: 'plan',     domain: 'development' },
  { id: 'debugger',    role: 'Diagnoses runtime errors, logic bugs, and unexpected behavior. Produces a root-cause hypothesis and a step-by-step remediation plan.',                             output_type: 'plan',     domain: 'development' },
  { id: 'refactor',    role: 'Improves code structure and readability without changing external behavior. Identifies code smells and proposes incremental refactoring steps.',                    output_type: 'plan',     domain: 'development' },
  { id: 'database',    role: 'Designs schemas, writes migrations, and optimizes queries. Advises on indexing, normalization, and transaction safety.',                                           output_type: 'plan',     domain: 'development' },
  { id: 'api',         role: 'Designs and implements REST or GraphQL APIs. Defines contracts, request/response types, validation, and middleware chains.',                                       output_type: 'plan',     domain: 'development' },
  { id: 'frontend',    role: 'Builds UI components and client-side logic. Plans component hierarchy, state management, and accessibility requirements.',                                         output_type: 'plan',     domain: 'development' },
  { id: 'backend',     role: 'Implements server-side services, business logic, and data layers. Advises on architecture patterns and dependency injection.',                                     output_type: 'plan',     domain: 'development' },
  { id: 'devops',      role: 'Plans CI/CD pipelines, containerization, and deployment strategies. Covers infrastructure-as-code, monitoring, and rollback procedures.',                         output_type: 'plan',     domain: 'development' },
  { id: 'performance', role: 'Identifies bottlenecks and plans optimization work. Prioritizes by impact-to-effort ratio and recommends profiling and benchmarking approaches.',                  output_type: 'plan',     domain: 'development' },
  { id: 'migration',   role: 'Plans safe data and schema migrations. Sequences steps to avoid downtime and designs rollback strategies for production environments.',                            output_type: 'plan',     domain: 'development' },

  // Security
  { id: 'security-scanner',  role: 'Scans code for OWASP Top 10 and CWE-mapped vulnerabilities including injection, broken auth, and insecure deserialization. Returns severity-scored findings.',  output_type: 'analysis', domain: 'security' },
  { id: 'auth',              role: 'Reviews authentication and authorization implementations. Plans secure token handling, session management, and role-based access control.',                        output_type: 'plan',     domain: 'security' },
  { id: 'privacy',           role: 'Audits data handling for GDPR, CCPA, and privacy best practices. Flags PII exposure risks and recommends data minimization and retention strategies.',          output_type: 'plan',     domain: 'security' },
  { id: 'secrets',           role: 'Detects hardcoded secrets, API keys, and credentials in code and config files. Returns severity-scored findings with remediation steps.',                        output_type: 'analysis', domain: 'security' },
  { id: 'dependency-audit',  role: 'Audits third-party dependencies for known CVEs and outdated packages. Returns severity-scored findings with upgrade and patching recommendations.',              output_type: 'analysis', domain: 'security' },
  { id: 'penetration',       role: 'Plans penetration testing scenarios and attack surface analysis. Identifies entry points, trust boundaries, and likely exploit paths.',                          output_type: 'plan',     domain: 'security' },

  // Memory
  { id: 'context-manager', role: 'Manages context window usage and plans compression or summarization strategies. Ensures critical information is preserved across session boundaries.',         output_type: 'plan', domain: 'memory' },
  { id: 'decision-logger', role: 'Plans how to record architectural decisions and their rationale. Structures decision logs for future reference and team onboarding.',                         output_type: 'plan', domain: 'memory' },
  { id: 'project-mapper',  role: 'Builds and maintains a structured map of the codebase. Identifies key modules, dependency graphs, and architectural boundaries.',                             output_type: 'plan', domain: 'memory' },
  { id: 'pattern-learner', role: 'Extracts recurring coding patterns and anti-patterns from project history. Plans how to encode these as reusable routing and quality rules.',                 output_type: 'plan', domain: 'memory' },
  { id: 'knowledge-base',  role: 'Organizes and retrieves project-specific knowledge and past findings. Plans knowledge storage and semantic search strategies for long-running projects.',     output_type: 'plan', domain: 'memory' },

  // Research
  { id: 'researcher',           role: 'Investigates technical questions and compares implementation options. Produces structured recommendations with trade-off analysis.',                           output_type: 'plan', domain: 'research' },
  { id: 'tech-advisor',         role: 'Evaluates technology choices and library selections. Advises on ecosystem maturity, maintenance status, and fit for project requirements.',                  output_type: 'plan', domain: 'research' },
  { id: 'cost-analyzer',        role: 'Estimates infrastructure, API, and operational costs. Models scaling scenarios and identifies cost optimization opportunities.',                              output_type: 'plan', domain: 'research' },
  { id: 'competitor-analyzer',  role: 'Analyzes competing products and alternative approaches. Identifies feature gaps, differentiators, and market positioning opportunities.',                    output_type: 'plan', domain: 'research' },
  { id: 'risk-assessor',        role: 'Identifies technical, operational, and business risks in proposed changes. Scores risks by likelihood and impact and recommends mitigations.',               output_type: 'plan', domain: 'research' },
  { id: 'estimator',            role: 'Produces time and effort estimates for tasks and projects. Breaks work into trackable units and surfaces uncertainty and dependency factors.',                output_type: 'plan', domain: 'research' },
  { id: 'ethics-bias',          role: 'Reviews AI features and data pipelines for ethical risks and algorithmic bias. Recommends fairness constraints and audit mechanisms.',                       output_type: 'plan', domain: 'research' },

  // Quality
  { id: 'code-quality',    role: 'Audits code for complexity, duplication, and maintainability anti-patterns. Returns scored findings with targeted refactoring suggestions.',          output_type: 'analysis', domain: 'quality' },
  { id: 'documentation',   role: 'Reviews documentation coverage for APIs, modules, and workflows. Identifies gaps and returns findings with structured improvement recommendations.',  output_type: 'analysis', domain: 'quality' },
  { id: 'accessibility',   role: 'Audits UI code for WCAG 2.1 compliance and screen reader compatibility. Returns findings with specific ARIA and semantic HTML fix recommendations.',  output_type: 'analysis', domain: 'quality' },
  { id: 'compatibility',   role: 'Checks code for browser, runtime, and platform compatibility issues. Plans polyfills, feature detection, and graceful degradation strategies.',       output_type: 'plan',     domain: 'quality' },
  { id: 'error-handling',  role: 'Reviews error handling coverage and propagation paths. Flags swallowed exceptions, missing guards, and unhelpful error messages.',                    output_type: 'analysis', domain: 'quality' },

  // Workflow
  { id: 'task-planner',     role: 'Breaks high-level goals into ordered, actionable tasks with clear acceptance criteria. Produces a dependency-aware execution plan.',                         output_type: 'plan', domain: 'workflow' },
  { id: 'task-coordinator', role: 'Orchestrates multi-agent task execution and resolves inter-task dependencies. Plans which agents run in parallel versus sequence for a given workload.',      output_type: 'plan', domain: 'workflow' },
  { id: 'file-manager',     role: 'Plans file system operations including moves, renames, and bulk transformations. Identifies affected imports and downstream callers.',                        output_type: 'plan', domain: 'workflow' },
  { id: 'git-agent',        role: 'Plans git workflows including branching, commit sequencing, and merge strategies. Advises on conflict resolution and history cleanliness.',                   output_type: 'plan', domain: 'workflow' },
  { id: 'search-agent',     role: 'Plans codebase search strategies to locate symbols, patterns, and usage sites. Recommends targeted grep, AST, and semantic search approaches.',              output_type: 'plan', domain: 'workflow' },
  { id: 'reporter',         role: 'Synthesizes findings from multiple agents into a structured summary report. Highlights critical items and produces executive-level briefings.',               output_type: 'plan', domain: 'workflow' },
  { id: 'automation',       role: 'Plans automation of repetitive development tasks including code generation, test running, linting, and deployment steps.',                                    output_type: 'plan', domain: 'workflow' },
];

export const MANIFEST_BY_ID = new Map<WorkerAgentType, AgentManifestEntry>(
  AGENT_MANIFEST.map(e => [e.id, e])
);

export function getManifestEntry(id: WorkerAgentType): AgentManifestEntry | undefined {
  return MANIFEST_BY_ID.get(id);
}
