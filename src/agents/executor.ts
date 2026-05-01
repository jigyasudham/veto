import { AgentTask, AgentResult, WorkerAgentType } from './types.js';

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

// Agents that support analyze()
const ANALYZE_CAPABLE: Set<WorkerAgentType> = new Set([
  'reviewer',
  'security-scanner',
  'secrets',
  'dependency-audit',
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
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

export async function executeOne(task: AgentTask): Promise<AgentResult> {
  const start = Date.now();
  try {
    const agent = resolveAgent(task.agent);
    const useAnalyze = task.code !== undefined && ANALYZE_CAPABLE.has(task.agent);

    if (useAnalyze && agent.analyze) {
      const analysis = agent.analyze(task.code!, task.context);
      return {
        id: task.id,
        agent: task.agent,
        analysis,
        duration_ms: Date.now() - start,
      };
    } else {
      const plan = agent.plan(task.task, task.context);
      return {
        id: task.id,
        agent: task.agent,
        plan,
        duration_ms: Date.now() - start,
      };
    }
  } catch (err) {
    return {
      id: task.id,
      agent: task.agent,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
  return Promise.all(tasks.map(task => executeOne(task)));
}
