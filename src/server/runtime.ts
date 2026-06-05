// Shared, mutable server runtime state and the small helpers that read/write it.
//
// Extracted from server.ts so per-domain handler modules can import this state
// instead of reaching into server.ts (which they can't — handlers live in their
// own files now). Behaviour is unchanged: these are the exact definitions that
// used to be module-locals in server.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSession, storeKnowledge, resolveContextWindow } from '../memory/local.js';
import { executeOne } from '../agents/executor.js';
import type { AgentPlan } from '../agents/types.js';

// Package version, read once. Lives here so handler modules can import it without
// reaching into server.ts.
const _here = dirname(fileURLToPath(import.meta.url));
export const VERSION = (JSON.parse(readFileSync(join(_here, '../../package.json'), 'utf8')) as { version: string }).version;

// ── Active project directory (set by session/handoff tools, read by others) ──
let activeProjectDir: string | null = null;
export function getActiveProjectDir(): string | null { return activeProjectDir; }
export function setActiveProjectDir(dir: string | null): void { activeProjectDir = dir; }

// ── Server health, surfaced by veto_health ──
export const serverHealth = {
  startTime: Date.now(),
  errorCount: 0,
  lastError: null as string | null,
};

// ── Auto-save state ──
export interface AutoSaveCache {
  summary: string;
  context: string;
  task_state?: string;
  platform: string;
  project_dir?: string;
  context_window?: number;
}
export const autoSave = {
  threshold_pct: 70,
  cooldown_ms: 5 * 60 * 1000,
  last_save_at: null as string | null,
  last_session_id: null as string | null,
  cached: null as AutoSaveCache | null,
};

export function maybeAutoSave(token_count: number, platform: string, model?: string): { triggered: boolean; session_id?: string; usage_pct?: number } {
  if (!autoSave.cached) return { triggered: false };
  const window_size = autoSave.cached.context_window ?? resolveContextWindow(platform, model);
  const usage_pct = Math.round((token_count / window_size) * 100);
  if (usage_pct < autoSave.threshold_pct) return { triggered: false };
  if (autoSave.last_save_at) {
    const elapsed = Date.now() - new Date(autoSave.last_save_at).getTime();
    if (elapsed < autoSave.cooldown_ms) return { triggered: false };
  }
  const result = saveSession({ ...autoSave.cached, token_count, platform, save_type: 'auto' });
  autoSave.last_save_at = result.saved_at;
  autoSave.last_session_id = result.session_id;
  return { triggered: true, session_id: result.session_id, usage_pct };
}

// ── Critical-failure knowledge auto-store ──
export function autoStoreCritical(title: string, issues: string[], projectDir?: string, tags: string[] = []): void {
  storeKnowledge({
    type: 'error',
    title,
    content: issues.join('\n'),
    tags: ['critical', 'failure', ...tags],
    project_dir: projectDir,
    relevance: 1.0,
  });
}

// ── Task planning ──
export function parsePrdIntoTasks(prd: string, plan: AgentPlan, maxTasks: number) {
  const lines = plan.steps;
  const tasks = lines.slice(0, maxTasks).map((line, i) => ({
    id: `task-${i + 1}`,
    agent: 'coder' as const,
    task: line,
    dependencies: i > 0 ? [`task-${i}`] : [],
  }));
  return { description: prd, tasks };
}

export async function buildTaskPlan(description: string, project_dir?: string, max_tasks = 10) {
  const result = await executeOne({
    id: 'planner-1',
    agent: 'task-planner',
    task: description,
    project_dir,
  });
  return parsePrdIntoTasks(description, result.plan!, max_tasks);
}
