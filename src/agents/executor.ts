import { AgentTask, AgentResult, AgentOutput, AgentPlan, AgentAnalysis, WorkerAgentType } from './types.js';
import { buildContextString } from '../context/reader.js';
import { getPlugin, isPlugin } from '../plugins/loader.js';

// Development agents
import * as coder from './development/coder.js';
import * as reviewer from './development/reviewer.js';
import * as tester from './development/tester.js';
import * as debugger_ from './development/debugger.js';
import * as refactor from './development/refactor.js';
import * as database from './development/database.js';
import * as api from './development/api.js';
import * as frontend from './development/frontend.js';
import * as backend from './development/backend.js';
import * as devops from './development/devops.js';
import * as performance from './development/performance.js';
import * as migration from './development/migration.js';

// Security agents
import * as securityScanner from './security/scanner.js';
import * as auth from './security/auth.js';
import * as privacy from './security/privacy.js';
import * as secrets from './security/secrets.js';
import * as dependencyAudit from './security/dependency-audit.js';
import * as penetration from './security/penetration.js';

// Memory agents
import * as contextManager from './memory/context-manager.js';
import * as decisionLogger from './memory/decision-logger.js';
import * as projectMapper from './memory/project-mapper.js';
import * as patternLearner from './memory/pattern-learner.js';
import * as knowledgeBase from './memory/knowledge-base.js';

// Research agents
import * as researcher from './research/researcher.js';
import * as techAdvisor from './research/tech-advisor.js';
import * as costAnalyzer from './research/cost-analyzer.js';
import * as competitorAnalyzer from './research/competitor-analyzer.js';
import * as riskAssessor from './research/risk-assessor.js';
import * as estimator from './research/estimator.js';
import * as ethicsBias from './research/ethics-bias.js';

// Quality agents
import * as codeQuality from './quality/code-quality.js';
import * as documentation from './quality/documentation.js';
import * as accessibility from './quality/accessibility.js';
import * as compatibility from './quality/compatibility.js';
import * as errorHandling from './quality/error-handling.js';

// Workflow agents
import * as taskPlanner from './workflow/task-planner.js';
import * as taskCoordinator from './workflow/task-coordinator.js';
import * as fileManager from './workflow/file-manager.js';
import * as gitAgent from './workflow/git-agent.js';
import * as searchAgent from './workflow/search-agent.js';
import * as reporter from './workflow/reporter.js';
import * as automation from './workflow/automation.js';

// Agents that support analyze()
const ANALYZE_CAPABLE: Set<WorkerAgentType> = new Set([
  'reviewer',
  'security-scanner',
  'secrets',
  'dependency-audit',
  'code-quality',
  'documentation',
  'accessibility',
  'error-handling',
]);

type AgentModule = {
  plan: (task: string, context?: string) => import('./types.js').AgentPlan;
  analyze?: (code: string, context?: string) => import('./types.js').AgentAnalysis;
};

function resolveAgent(agentType: WorkerAgentType): AgentModule {
  switch (agentType) {
    case 'coder':            return coder;
    case 'reviewer':         return reviewer;
    case 'tester':           return tester;
    case 'debugger':         return debugger_;
    case 'refactor':         return refactor;
    case 'database':         return database;
    case 'api':              return api;
    case 'frontend':         return frontend;
    case 'backend':          return backend;
    case 'devops':           return devops;
    case 'performance':      return performance;
    case 'migration':        return migration;
    case 'security-scanner': return securityScanner;
    case 'auth':             return auth;
    case 'privacy':          return privacy;
    case 'secrets':          return secrets;
    case 'dependency-audit': return dependencyAudit;
    case 'penetration':      return penetration;
    case 'context-manager':  return contextManager;
    case 'decision-logger':  return decisionLogger;
    case 'project-mapper':   return projectMapper;
    case 'pattern-learner':  return patternLearner;
    case 'knowledge-base':      return knowledgeBase;
    case 'researcher':          return researcher;
    case 'tech-advisor':        return techAdvisor;
    case 'cost-analyzer':       return costAnalyzer;
    case 'competitor-analyzer': return competitorAnalyzer;
    case 'risk-assessor':       return riskAssessor;
    case 'estimator':           return estimator;
    case 'ethics-bias':         return ethicsBias;
    case 'code-quality':        return codeQuality;
    case 'documentation':       return documentation;
    case 'accessibility':       return accessibility;
    case 'compatibility':       return compatibility;
    case 'error-handling':      return errorHandling;
    case 'task-planner':        return taskPlanner;
    case 'task-coordinator':    return taskCoordinator;
    case 'file-manager':        return fileManager;
    case 'git-agent':           return gitAgent;
    case 'search-agent':        return searchAgent;
    case 'reporter':            return reporter;
    case 'automation':          return automation;
    default: {
      const plugin = getPlugin(agentType);
      if (plugin) return plugin;
      throw new Error(`Unknown agent type: ${agentType}`);
    }
  }
}

function computePlanConfidence(plan: AgentPlan): number {
  // More detailed plans = higher confidence: steps, checklist items, pitfalls all signal thoroughness
  const stepScore     = Math.min(1.0, (plan.steps?.length ?? 0) / 10);
  const checkScore    = Math.min(1.0, (plan.checklist?.length ?? 0) / 8);
  const pitfallScore  = Math.min(1.0, (plan.pitfalls?.length ?? 0) / 4);
  const contextBonus  = plan.approach && plan.approach.length > 80 ? 0.05 : 0;
  const raw = (stepScore * 0.5) + (checkScore * 0.3) + (pitfallScore * 0.15) + contextBonus;
  return Math.min(0.97, Math.max(0.4, raw));
}

function deriveOutput(plan?: AgentPlan, analysis?: AgentAnalysis): AgentOutput {
  if (analysis) {
    return {
      confidence: Math.min(1, Math.max(0, analysis.score / 100)),
      severity: analysis.critical_count > 0 ? 'critical' : analysis.high_count > 0 ? 'high' : 'medium',
      recommendation: analysis.summary,
      affected_files: [],
      line_refs: analysis.findings
        .filter(f => f.location)
        .map(f => ({ file: f.location!, line: 0, description: f.description })),
    };
  }
  if (plan) {
    return {
      confidence: computePlanConfidence(plan),
      severity: 'info',
      recommendation: plan.approach,
      affected_files: [],
      line_refs: [],
    };
  }
  return { confidence: 0, severity: 'info', recommendation: '', affected_files: [], line_refs: [] };
}

export async function executeOne(task: AgentTask): Promise<AgentResult> {
  const start = Date.now();
  try {
    const agent = resolveAgent(task.agent);
    const useAnalyze = task.code !== undefined && ANALYZE_CAPABLE.has(task.agent);
    const enrichedContext = buildContextString(task.project_dir, task.context);

    if (useAnalyze && agent.analyze) {
      const analysis = agent.analyze(task.code!, enrichedContext || task.context);
      return {
        id: task.id,
        agent: task.agent,
        analysis,
        output: deriveOutput(undefined, analysis),
        duration_ms: Date.now() - start,
      };
    } else {
      const plan = agent.plan(task.task, enrichedContext || task.context);
      return {
        id: task.id,
        agent: task.agent,
        plan,
        output: deriveOutput(plan, undefined),
        duration_ms: Date.now() - start,
      };
    }
  } catch (err) {
    return {
      id: task.id,
      agent: task.agent,
      output: { confidence: 0, severity: 'info', recommendation: '', affected_files: [], line_refs: [] },
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
  return Promise.all(tasks.map(task => executeOne(task)));
}
