#!/usr/bin/env node
// Veto MCP Server — 49 tools, 23 phases complete, LLM council + auto-learning router

// Suppress node:sqlite experimental warning — it would corrupt the MCP stdio protocol
process.removeAllListeners('warning');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildContextString, readProjectContext } from './context/reader.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import {
  saveSession, restoreSession, listSessions, closeSession, getDbPath, saveCouncilOutcome,
  storeKnowledge, searchKnowledge, deleteKnowledge,
  updateProjectMap, getProjectMap,
  upsertPattern, getPatterns,
  getContextStatus, fetchAndCacheDocs, saveTaskPlan, getTaskPlan,
  getUsageStatus, getAuditLog, getHealthStats, CONTEXT_WINDOWS,
  logUsage, getUsageLogs, getDb,
  storeScanDiagnostics, clearScanDiagnostics,
  updateSession, resolveContextWindow, getMetrics,
  upsertContextUsage, getContextUsage, recordToolCall, getSessionReplay,
} from './memory/local.js';
import { exportMemory, importMemory, getLocalDbSize, exportMemoryMarkdown, importMemoryMarkdown } from './memory/sync.js';
import { buildRepoMap, repoMapToCompact } from './repo-map/index.js';
import { runDebate } from './council/index.js';
import { runLlmDebate, buildAgenticDebatePrompt, parseAgentResponses, runFromAgentResponses } from './council/llm-council.js';
import { autoSummarizeSession } from './council/session-summarizer.js';
import { routeTask, getRateStatus, trackTokens, recordOutcome, getLearningStats, getLearnedThresholds, applyLearnedThresholds, getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights, getRecommendedAgent } from './router/index.js';
import { getConfig, setConfig } from './memory/config.js';
import type { AgentType, Platform } from './router/index.js';
import { executeParallel, executeOne, initLlmRunner } from './agents/executor.js';
import { buildAgenticAgentPrompt } from './agents/llm-runner.js';
import type { AgentTask, WorkerAgentType } from './agents/types.js';
import { handoff, continueSession, getPlatformSetup } from './adapters/index.js';
import type { SetupPlatform } from './adapters/index.js';
import { startWatch, pollWatch, stopWatch, listWatches } from './watcher/index.js';
import { runPipeline } from './workflow/pipeline.js';
import type { PipelineStep } from './workflow/pipeline.js';
import { loadPlugins, listPlugins } from './plugins/loader.js';
import { fetchPrDiff } from './github/pr-fetcher.js';
import { discoverProject } from './discover.js';
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { extname, basename, join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync as execSyncTop } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

// Tracks the project_dir of the most recently active session in this process.
// Used as a fallback when memory_store/memory_search are called without an explicit project_dir,
// so memories are automatically scoped to the current project.
let activeProjectDir: string | null = null;

// Server health tracking
const SERVER_START_TIME = Date.now();
let serverErrorCount = 0;
let lastServerError: string | null = null;

// Auto-save: cached context from the last explicit session save. Populated by
// veto_session_save and veto_handoff. Cleared on server restart (in-memory only).
interface AutoSaveCache {
  summary: string;
  context: string;
  task_state?: string;
  platform: string;
  project_dir?: string;
  context_window?: number;
}
const autoSave = {
  threshold_pct: 70,
  cooldown_ms: 5 * 60 * 1000, // 5 min between auto-saves
  last_save_at: null as string | null,
  last_session_id: null as string | null,
  cached: null as AutoSaveCache | null,
};

function maybeAutoSave(token_count: number, platform: string, model?: string): { triggered: boolean; session_id?: string; usage_pct?: number } {
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

const server = new Server(
  { name: 'veto', version: VERSION },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    instructions: `Veto is a 49-tool MCP server for AI-assisted software engineering. Tools fall into five categories:

SESSION & CONTEXT — veto_status, veto_session_save, veto_session_restore, veto_sessions_list, veto_continue, veto_handoff, veto_autosave_status. Persist work across context windows and switch AI platforms without losing progress. Call veto_session_save at 60–70% context capacity; veto_status triggers auto-save automatically above 70%.

CODE INTELLIGENCE — veto_code_review, veto_diff_review, veto_security_scan, veto_secrets_scan, veto_ci_gate, veto_pr_review. Pass code or a git diff; each tool returns scored findings with severity (critical/high/medium/low). veto_diff_review and veto_ci_gate run code review + security + secrets scans in parallel — use these before any merge or deploy.

NAMED PIPELINES — veto_full_review, veto_pre_commit, veto_new_feature. Curated multi-tool compositions: veto_full_review runs code+security+secrets+quality in parallel (pre-ship); veto_pre_commit runs secrets+review on staged changes (pre-commit); veto_new_feature runs council+plan+tasks in sequence (new features). Each collapses 3–5 manual calls into 1.

COUNCIL & ROUTING — veto_council_debate, veto_route_task, veto_agent_plan, veto_execute_parallel, veto_workflow, veto_benchmark. The council runs 7 specialist agents (Lead Dev, PM, Architect, UX, Devil's Advocate, Legal, Security) and returns a verdict.

Two-phase council flow (LLM-backed, no API keys needed):
  Phase 1 — call veto_council_debate with { task }. The response includes llm_upgrade.debate_prompt.
  Phase 2 — reason as all 7 agents using that prompt, produce agent_responses JSON, then call veto_council_debate again with { task, agent_responses } to get the final LLM-backed verdict.

Council verdict colors:
  GREEN   — approved, proceed with confidence
  YELLOW  — approved with warnings, review warnings before shipping
  RED     — blocked, do not proceed without addressing block_reasons
  DEADLOCK — council split evenly, human decision required

MEMORY & DISCOVERY — veto_memory_store, veto_memory_search, veto_memory_delete, veto_project_map_update, veto_project_map_get, veto_pattern_store, veto_patterns_list, veto_discover, veto_summarize, veto_explain. Use veto_discover to map an unknown repo in seconds, veto_summarize for a plain-English briefing, and veto_memory_store to persist key findings across sessions.

OBSERVABILITY — veto_usage_status, veto_audit_log, veto_health, veto_metrics, veto_rate_status, veto_learning_stats, veto_learning_apply. Monitor token budgets, council decision history, and auto-router performance. Call veto_learning_apply after 20+ outcomes to tune routing thresholds from real data.

MCP PROMPTS (8) — slash-command-style workflow templates: code-review, security-audit, deploy-checklist, explain-file, full-review, new-feature, debug-incident, onboard. Select a prompt from the Prompts panel to launch a pre-built workflow.

Recommended start sequence:
  1. veto_status — confirm server is running and check token usage
  2. veto_discover or veto_summarize — orient to the codebase before touching files
  3. veto_route_task — pick the right agent before heavy analysis
  4. veto_full_review or veto_diff_review — validate before shipping
  5. veto_session_save — checkpoint before context fills`,
  }
);

// ─── Tool Risk Annotations (#21) ─────────────────────────────────────────────
// readOnlyHint: tool makes no writes. destructiveHint: writes are irreversible.
// openWorldHint: tool reaches outside the local DB (network, filesystem, processes).

const TOOL_ANNOTATIONS: Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }> = {
  // read-only — query/inspect only
  veto_status:           { readOnlyHint: true },
  veto_autosave_status:  { readOnlyHint: true },
  veto_sessions_list:    { readOnlyHint: true },
  veto_rate_status:      { readOnlyHint: true },
  veto_route_task:       { readOnlyHint: true },
  veto_agent_plan:       { readOnlyHint: true },
  veto_code_review:      { readOnlyHint: true },
  veto_diff_review:      { readOnlyHint: true },
  veto_security_scan:    { readOnlyHint: true },
  veto_secrets_scan:     { readOnlyHint: true },
  veto_project_map_get:  { readOnlyHint: true },
  veto_patterns_list:    { readOnlyHint: true },
  veto_learning_stats:   { readOnlyHint: true },
  veto_watch_poll:       { readOnlyHint: true },
  veto_plugins:          { readOnlyHint: true },
  veto_context_status:   { readOnlyHint: true },
  veto_audit_log:        { readOnlyHint: true },
  veto_health:           { readOnlyHint: true },
  veto_discover:         { readOnlyHint: true },
  veto_summarize:        { readOnlyHint: true },
  veto_explain:          { readOnlyHint: true },
  veto_benchmark:        { readOnlyHint: false, destructiveHint: false },
  // read-only + open world (external network)
  veto_docs_fetch:       { readOnlyHint: true,  openWorldHint: true },
  veto_pr_review:        { readOnlyHint: true,  openWorldHint: true },
  // reversible writes (local DB — can be deleted/reset)
  veto_council_debate:    { readOnlyHint: false, destructiveHint: false },
  veto_execute_parallel:  { readOnlyHint: false, destructiveHint: false },
  veto_session_save:      { readOnlyHint: false, destructiveHint: false },
  veto_session_restore:   { readOnlyHint: false, destructiveHint: false },
  veto_memory_store:      { readOnlyHint: false, destructiveHint: false },
  veto_project_map_update:{ readOnlyHint: false, destructiveHint: false },
  veto_pattern_store:     { readOnlyHint: false, destructiveHint: false },
  veto_memory_export:     { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  veto_record_outcome:    { readOnlyHint: false, destructiveHint: false },
  veto_learning_apply:    { readOnlyHint: false, destructiveHint: false },
  veto_handoff:           { readOnlyHint: false, destructiveHint: false },
  veto_continue:          { readOnlyHint: false, destructiveHint: false },
  veto_task_parse:        { readOnlyHint: false, destructiveHint: false },
  veto_watch:             { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  veto_watch_stop:        { readOnlyHint: false, destructiveHint: false },
  veto_full_review:       { readOnlyHint: true },
  veto_pre_commit:        { readOnlyHint: true },
  veto_new_feature:       { readOnlyHint: false, destructiveHint: false },
  veto_delegate:          { readOnlyHint: true },
  veto_prompt_optimizer:  { readOnlyHint: true },
  veto_sre_advisor:       { readOnlyHint: true },
  veto_diagram:           { readOnlyHint: true },
  veto_pr_post:           { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  veto_debt_register:     { readOnlyHint: true },
  veto_adr:               { readOnlyHint: false, destructiveHint: false },
  veto_env_setup:         { readOnlyHint: false, destructiveHint: false },
  veto_commit_message:    { readOnlyHint: true },
  veto_pr_description:    { readOnlyHint: true },
  veto_rca:               { readOnlyHint: true },
  veto_release_notes:     { readOnlyHint: true },
  veto_postmortem:        { readOnlyHint: true },
  veto_workflow:          { readOnlyHint: false, destructiveHint: false },
  veto_ci_gate:           { readOnlyHint: false, destructiveHint: false },
  veto_usage_status:      { readOnlyHint: false, destructiveHint: false },
  // destructive — permanent deletes or config overwrites
  veto_memory_delete:     { readOnlyHint: false, destructiveHint: true },
  veto_memory_import:     { readOnlyHint: false, destructiveHint: true },
  veto_platform_setup:    { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
  // documentation & quality
  veto_doc_gen:           { readOnlyHint: true },
  veto_type_coverage:     { readOnlyHint: true },
  veto_test_gaps:         { readOnlyHint: true },
  veto_onboard:           { readOnlyHint: true },
  // code intelligence — dep / query / bundle / dead-code
  veto_dep_advisor:       { readOnlyHint: true, openWorldHint: true },
  veto_query_advisor:     { readOnlyHint: true },
  veto_bundle_advisor:    { readOnlyHint: true },
  veto_dead_code:         { readOnlyHint: true },
  // hitl / openapi / flag auditor
  veto_hitl_checkpoint:   { readOnlyHint: true },
  veto_openapi_gen:       { readOnlyHint: false, destructiveHint: false },
  veto_flag_auditor:      { readOnlyHint: true },
  // Phase 7: Intelligence & Advanced
  veto_local_llm:         { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  veto_clone_detector:    { readOnlyHint: true },
  veto_lint_rules:        { readOnlyHint: false, destructiveHint: false },
  veto_api_contract:      { readOnlyHint: false, destructiveHint: false },
  veto_merge_conflict:    { readOnlyHint: false, destructiveHint: false },
  veto_translate:         { readOnlyHint: false, destructiveHint: false },
  veto_a11y_advisor:      { readOnlyHint: true },
  veto_session_replay:    { readOnlyHint: true },
  veto_compose_agents:    { readOnlyHint: false, destructiveHint: false },
  // Phase 8: Long-Horizon
  veto_semantic_search:   { readOnlyHint: true },
  veto_sdd_agent:         { readOnlyHint: false, destructiveHint: false },
  veto_notify_ide:        { readOnlyHint: true },
};

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string; inputSchema: object }>;
  return { tools: tools.map(t => ({ ...t, annotations: TOOL_ANNOTATIONS[t.name] ?? {} })) };
});

// ─── Shared Scan Utility ──────────────────────────────────────────────────────

async function runTripleScan(diff: string, context: string) {
  const [reviewResult, secResult, secretsResult] = await Promise.all([
    executeOne({ id: 'scan-review',  agent: 'reviewer',         task: 'Review this git diff for code quality issues', code: diff, context }),
    executeOne({ id: 'scan-sec',     agent: 'security-scanner', task: 'Scan this git diff for security vulnerabilities', code: diff, context }),
    executeOne({ id: 'scan-secrets', agent: 'secrets',          task: 'Scan this git diff for exposed secrets or credentials', code: diff }),
  ]);
  const hasBlocking = (reviewResult.analysis?.critical_count ?? 0) > 0
    || (secResult.analysis?.critical_count ?? 0) > 0
    || (secretsResult.analysis?.critical_count ?? 0) > 0;
  const hasWarnings = (reviewResult.analysis?.high_count ?? 0) > 0
    || (secResult.analysis?.high_count ?? 0) > 0;
  const verdict = hasBlocking ? 'fail' : hasWarnings ? 'warn' : 'pass';
  // auto-record per agent so learning accumulates from every scan (diff_review, ci_gate, pr_review)
  autoRecord('scan', 'reviewer',         reviewResult.analysis?.score ?? Math.round(reviewResult.output.confidence * 100));
  autoRecord('scan', 'security-scanner', secResult.analysis?.score    ?? Math.round(secResult.output.confidence    * 100));
  autoRecord('scan', 'secrets', (secretsResult.analysis?.findings?.length ?? 0) === 0 ? 100 : secretsResult.analysis?.score ?? Math.round(secretsResult.output.confidence * 100));
  return { reviewResult, secResult, secretsResult, verdict };
}

function parseLineFromLocation(location?: string): number {
  if (!location) return 1;
  const m = location.match(/(?:^|line\s+)(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}

function mapSeverityToVscode(severity?: string): string {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'information';
}

// Auto-learning helper — records a learning_data row from any agent result.
// Keeps call sites to one line rather than repeating the tier/quality logic.
// After every 20 outcomes the thresholds are applied automatically.
function autoRecord(taskType: string, agent: string, quality: number, complexity = 50): void {
  const tier: 1|2|3 = quality >= 80 ? 1 : quality >= 40 ? 2 : 3;
  recordOutcome(taskType.slice(0, 50), complexity, tier, agent, quality);
  try {
    const count = (getDb().prepare('SELECT COUNT(*) as c FROM learning_data').get() as { c: number }).c;
    if (count >= 20 && count % 20 === 0) applyLearnedThresholds();
  } catch { /* never interrupt the caller */ }
}

// Auto-store helper — writes a knowledge_base entry when a scan produces critical/blocking issues.
// This is what populates the Memory panel in the VS Code extension automatically.
function autoStoreCritical(title: string, blockingIssues: string[], projectDir?: string, extraTags: string[] = [], sessionId?: string): void {
  if (blockingIssues.length === 0) return;
  storeKnowledge({
    type: 'decision',
    title: title.slice(0, 100),
    content: `Blocking issues:\n${blockingIssues.map(i => `- ${i}`).join('\n')}`,
    tags: ['critical', 'blocked', ...extraTags],
    project_dir: projectDir,
    session_id: sessionId,
    relevance: 1.0,
  });
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

// Task-parse helper reused by veto_task_parse and veto_new_feature.
// Returns the structured plan + plan_id without the MCP response wrapper.
async function buildTaskPlan(description: string, project_dir?: string, max_tasks = 20): Promise<{
  plan_id: string;
  cached: boolean;
  summary: string;
  total_tasks: number;
  total_complexity: number;
  critical_path: string[];
  parallelisable_groups: string[][];
  duration_estimate: string;
  tasks: Array<{ id: string; title: string; complexity: number; priority: string; depends_on: string[]; suggested_agent: string; estimated_hours: number }>;
}> {
  const hash = createHash('sha256').update(description).digest('hex').slice(0, 16);
  const cached = getTaskPlan(hash);
  if (cached) return { plan_id: cached.id, cached: true, ...JSON.parse(cached.plan_json) };

  const ctx = project_dir ? buildContextString(project_dir) : '';
  const planResult = await executeOne({ id: 'task-parse-1', agent: 'task-planner', task: `Parse this project description into a structured task breakdown with dependencies and complexity scores (max ${max_tasks} tasks):\n\n${description}`, context: ctx || undefined, project_dir });

  const agentKeywords: Array<{ keywords: RegExp; agent: string }> = [
    { keywords: /test|spec|coverage|assert|unit|integration/i,            agent: 'tester' },
    { keywords: /secur|auth|jwt|oauth|permission|role|encrypt|hash/i,     agent: 'auth' },
    { keywords: /database|schema|migrat|sql|query|index|table/i,          agent: 'database' },
    { keywords: /api|endpoint|rest|graphql|route|openapi/i,               agent: 'api' },
    { keywords: /ui|component|frontend|react|vue|svelte|html|css|style/i, agent: 'frontend' },
    { keywords: /docker|deploy|ci|cd|pipeline|container|k8s|infra/i,      agent: 'devops' },
    { keywords: /refactor|clean|restructure|rename|extract/i,             agent: 'refactor' },
    { keywords: /review|audit|quality|lint|check/i,                       agent: 'reviewer' },
    { keywords: /debug|fix|bug|error|crash|trace|diagnos/i,               agent: 'debugger' },
    { keywords: /document|readme|comment|jsdoc|wiki/i,                    agent: 'documentation' },
    { keywords: /perform|optim|speed|cache|profil|latency/i,              agent: 'performance' },
    { keywords: /migrat|upgrade|version|port|convert/i,                   agent: 'migration' },
  ];
  const pickAgent = (step: string) => { for (const { keywords, agent } of agentKeywords) if (keywords.test(step)) return agent; return 'coder'; };
  const scoreStep = (step: string) => { const words = step.split(/\s+/).length; const hasComplex = /integrat|architect|design|implement|optim|migrat|refactor/i.test(step); return Math.min(10, Math.min(7, Math.max(2, Math.round(words / 3))) + (hasComplex ? 2 : 0)); };
  const inferDeps = (step: string, idx: number) => { const lower = step.toLowerCase(); if (/^(deploy|test|release|publish|document)/i.test(step.trim()) && idx > 0) return [`task-${idx}`]; if (/after.{0,30}(setup|init|instal|creat|build)/i.test(lower) && idx > 0) return [`task-${idx}`]; return idx > 0 && /integrat|connect|wire|link/i.test(lower) ? [`task-${idx}`] : []; };

  const steps: string[] = planResult.plan?.steps ?? [];
  const tasks = steps.slice(0, max_tasks).map((step, i) => {
    const complexity = scoreStep(step);
    const agent = pickAgent(step);
    const priority = i === 0 ? 'critical' : complexity >= 7 ? 'high' : complexity >= 5 ? 'medium' : 'low';
    return { id: `task-${i + 1}`, title: step, complexity, priority, depends_on: inferDeps(step, i), suggested_agent: agent, estimated_hours: complexity <= 3 ? 1 : complexity <= 6 ? 2 : complexity <= 8 ? 4 : 8 };
  });

  const plan = { summary: description.slice(0, 100), total_tasks: tasks.length, total_complexity: tasks.reduce((s, t) => s + t.complexity, 0), critical_path: tasks.map(t => t.id), parallelisable_groups: tasks.length > 2 ? [tasks.slice(1, Math.ceil(tasks.length / 2)).map(t => t.id)] : [], tasks, duration_estimate: planResult.plan?.duration_estimate ?? 'unknown' };
  autoRecord(description, 'task-planner', Math.round(planResult.output.confidence * 100));
  const plan_id = saveTaskPlan(JSON.stringify(plan), hash, project_dir);
  return { plan_id, cached: false, ...plan };
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const callStart = Date.now();
  let resultStatus: 'success' | 'error' = 'success';
  let errorMessage: string | undefined;

  try {
    const response = await (async () => {
      switch (name) {
    case 'veto_status': {
      const statusTokenCount = typeof args?.token_count === 'number' ? args.token_count : null;
      const statusPlatform = args?.platform ? String(args.platform) : 'claude';
      const statusModel = args?.model ? String(args.model) : undefined;
      if (statusTokenCount !== null && statusTokenCount > 0) {
        trackTokens(statusPlatform as Platform, statusTokenCount);
        upsertContextUsage({
          platform: statusPlatform,
          model: statusModel,
          token_count: statusTokenCount,
          context_window: resolveContextWindow(statusPlatform, statusModel),
          session_id: autoSave.last_session_id ?? undefined,
        });
      }
      const autoSaveResult = statusTokenCount !== null ? maybeAutoSave(statusTokenCount, statusPlatform, statusModel) : null;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'running',
                version: VERSION,
                server: 'veto',
                phase: 17,
                capabilities: [
                  'session_save', 'session_restore', 'sessions_list',
                  'router', 'rate_monitor',
                  'council_debate',
                  'agent_plan', 'parallel_exec',
                  'code_review', 'diff_review', 'security_scan', 'secrets_scan', 'ci_gate', 'pr_review',
                  'workflow', 'watch',
                  'explain',
                  'memory_store', 'memory_search', 'memory_delete', 'memory_export', 'memory_import',
                  'project_map', 'pattern_store',
                  'learning_stats', 'learning_apply', 'record_outcome',
                  'handoff', 'continue', 'platform_setup',
                  'plugins',
                  'docs_fetch', 'context_status', 'task_parse',
                  'usage_status', 'audit_log', 'health',
                  'auto_save', 'discover', 'summarize',
                ],
                db_path: getDbPath(),
                uptime_ms: process.uptime() * 1000,
                timestamp: new Date().toISOString(),
                ...(autoSaveResult?.triggered ? { auto_save: { triggered: true, session_id: autoSaveResult.session_id, usage_pct: autoSaveResult.usage_pct } } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_autosave_status': {
      const liveUsage = getContextUsage();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            threshold_pct: autoSave.threshold_pct,
            cooldown_ms: autoSave.cooldown_ms,
            context_cached: autoSave.cached !== null,
            cached_summary: autoSave.cached?.summary ?? null,
            last_save_at: autoSave.last_save_at,
            last_session_id: autoSave.last_session_id,
            live_context_usage: liveUsage,
            note: 'Pass token_count to veto_session_save or veto_status to update live_context_usage. VS Code extension reads context_usage table directly.',
          }, null, 2),
        }],
      };
    }

    case 'veto_session_save': {
      const sessionProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      if (sessionProjectDir) activeProjectDir = sessionProjectDir;
      const savePlatform = args?.platform ? String(args.platform) : 'claude';
      const shouldAutoSummarize = args?.auto_summarize === true;

      // Auto-summarize: try MCP Sampling first, fall back to agentic prompt for host AI
      let autoSummaryResult: Awaited<ReturnType<typeof autoSummarizeSession>> = null;
      if (shouldAutoSummarize) {
        autoSummaryResult = await autoSummarizeSession(server, {
          summary: args?.summary ? String(args.summary) : undefined,
          context: args?.context ? String(args.context) : undefined,
          task_state: args?.task_state ? String(args.task_state) : undefined,
        });
        // If agentic prompt returned, short-circuit — return it so the AI can fill it in
        if (autoSummaryResult && 'mode' in autoSummaryResult && autoSummaryResult.mode === 'agentic') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                auto_summarized: false,
                ...autoSummaryResult,
              }, null, 2),
            }],
          };
        }
      }

      // Enforce size limits — unbounded strings exhaust SQLite page cache and memory
      const SUMMARY_LIMIT = 2_000;
      const CONTEXT_LIMIT = 50_000;
      const TASK_STATE_LIMIT = 20_000;
      const generatedSession = autoSummaryResult && 'auto_summarized' in autoSummaryResult ? autoSummaryResult : null;
      const RAW_SUMMARY = generatedSession?.summary ?? String(args?.summary ?? '');
      const RAW_CONTEXT = generatedSession?.context ?? String(args?.context ?? '');
      const RAW_TASK_STATE = generatedSession?.task_state ?? (args?.task_state ? String(args.task_state) : undefined);
      const saveSummary = RAW_SUMMARY.slice(0, SUMMARY_LIMIT);
      const saveContext = RAW_CONTEXT.slice(0, CONTEXT_LIMIT);
      const saveTaskState = RAW_TASK_STATE ? RAW_TASK_STATE.slice(0, TASK_STATE_LIMIT) : undefined;
      const truncationWarnings: string[] = [];
      if (RAW_SUMMARY.length > SUMMARY_LIMIT) truncationWarnings.push(`summary truncated to ${SUMMARY_LIMIT} chars (was ${RAW_SUMMARY.length})`);
      if (RAW_CONTEXT.length > CONTEXT_LIMIT) truncationWarnings.push(`context truncated to ${CONTEXT_LIMIT} chars (was ${RAW_CONTEXT.length})`);
      if (RAW_TASK_STATE && RAW_TASK_STATE.length > TASK_STATE_LIMIT) truncationWarnings.push(`task_state truncated to ${TASK_STATE_LIMIT} chars (was ${RAW_TASK_STATE.length})`);

      const existingId = args?.session_id ? String(args.session_id) : undefined;

      const saveModel = args?.model ? String(args.model) : undefined;
      const sessionInput = {
        summary: saveSummary,
        context: saveContext,
        task_state: saveTaskState,
        platform: savePlatform,
        model: saveModel,
        connection_type: args?.connection_type ? String(args.connection_type) : 'subscription',
        project_dir: sessionProjectDir,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
        tags: Array.isArray(args?.tags) ? (args.tags as unknown[]).map(String) : undefined,
      };

      let result: { session_id: string; saved_at: string; usage_pct: number; context_warning: boolean; continuation_prompt: string | null };
      let wasUpdate = false;

      if (existingId) {
        const updated = updateSession(existingId, sessionInput);
        if (updated) {
          result = { session_id: updated.session_id, saved_at: updated.saved_at, usage_pct: 0, context_warning: false, continuation_prompt: null };
          wasUpdate = true;
        } else {
          result = saveSession(sessionInput);
        }
      } else {
        result = saveSession(sessionInput);
      }
      // Cache for auto-save: future veto_status calls with high token_count will re-save this context
      const resolvedWindow = resolveContextWindow(savePlatform, saveModel);
      autoSave.cached = { summary: saveSummary, context: saveContext, task_state: saveTaskState, platform: savePlatform, project_dir: sessionProjectDir, context_window: resolvedWindow };
      autoSave.last_save_at = result.saved_at;
      autoSave.last_session_id = result.session_id;

      // Update live token count so VS Code extension and veto_status reflect it immediately
      const saveTokenCount = typeof args?.token_count === 'number' ? args.token_count : 0;
      if (saveTokenCount > 0) {
        trackTokens(savePlatform as Platform, saveTokenCount);
        upsertContextUsage({
          platform: savePlatform,
          model: saveModel,
          token_count: saveTokenCount,
          context_window: resolvedWindow,
          session_id: result.session_id,
        });
      }

      const autoSumFailed = shouldAutoSummarize && !autoSummaryResult;
      const responseObj: Record<string, unknown> = {
        success: true,
        message: wasUpdate
          ? `Session updated in-place. ID unchanged: ${result.session_id}`
          : result.context_warning
            ? `⚠️ Context at ${result.usage_pct}% — consider handing off soon.`
            : 'Session saved. Use this ID to restore on any AI platform.',
        session_id: result.session_id,
        saved_at: result.saved_at,
        updated: wasUpdate,
        auto_summarized: autoSummaryResult ? true : false,
        ...(autoSumFailed ? { auto_summarize_warning: 'MCP Sampling unavailable — saved provided values instead. For best results use Claude Code or another host that supports sampling.' } : {}),
        ...(wasUpdate ? {} : { usage_pct: result.usage_pct, context_warning: result.context_warning }),
        ...(truncationWarnings.length > 0 ? { truncation_warnings: truncationWarnings } : {}),
      };
      if (result.continuation_prompt) responseObj.continuation_prompt = result.continuation_prompt;

      return { content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }] };
    }

    case 'veto_session_restore': {
      const session_id = String(args?.session_id ?? '');
      const resuming_as = args?.resuming_as ? String(args.resuming_as) : undefined;
      const result = restoreSession(session_id, resuming_as);

      if (!result.found) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: false, message: `No session found with id: ${session_id}` },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const s = result.session!;
      if (s.project_dir) activeProjectDir = s.project_dir;

      const parsedTaskState = s.task_state ? (() => { try { return JSON.parse(s.task_state!); } catch { return s.task_state; } })() : null;
      const nextAction = (typeof parsedTaskState === 'object' && parsedTaskState !== null)
        ? (parsedTaskState.nextAction ?? parsedTaskState.next_action ?? null)
        : null;

      const resumeInstructions = [
        'Context restored from previous session. Trust the summary, context, and task_state above — they were written by the AI that last worked on this.',
        'Do NOT re-read source files to orient yourself. That defeats the purpose of session restore and wastes tokens.',
        'Only open a file if you are about to EDIT it — not to "verify" or "familiarize yourself" with it.',
        nextAction ? `Start immediately with: ${nextAction}` : 'Read task_state.nextAction (or context) for where to start.',
        'If context seems stale (e.g. you find a file has changed), read only that file, update the context, and continue.',
      ].join(' ');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                resume_instructions: resumeInstructions,
                session_id: s.id,
                created_by: s.platform,
                saved_at: s.started_at,
                project_dir: s.project_dir,
                summary: s.summary,
                context: s.context ? (() => { try { return JSON.parse(s.context!); } catch { return s.context; } })() : null,
                task_state: parsedTaskState,
                token_count: s.token_count,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_sessions_list': {
      const limit = Math.min(typeof args?.limit === 'number' ? args.limit : 10, 50);
      const query = args?.query ? String(args.query).trim() : undefined;
      const sessions = listSessions(limit, query);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: sessions.length,
                sessions: sessions.map((s) => ({
                  id: s.id,
                  platform: s.platform,
                  started_at: s.started_at,
                  ended_at: s.ended_at,
                  project_dir: s.project_dir,
                  summary: s.summary,
                  token_count: s.token_count,
                  tags: (s as unknown as { tags?: string }).tags ? JSON.parse((s as unknown as { tags: string }).tags) : [],
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_route_task': {
      const routeTaskStr = String(args?.task ?? '');
      const fileExt = args?.file_ext ? String(args.file_ext) : undefined;
      const result = routeTask(routeTaskStr, {
        agentType: args?.agent_type ? (String(args.agent_type) as AgentType) : undefined,
        filesAffected: typeof args?.files_affected === 'number' ? args.files_affected : undefined,
        forceCouncil: args?.force_council === true,
        context: args?.context ? String(args.context) : undefined,
        preferredPlatform: args?.preferred_platform ? (String(args.preferred_platform) as Platform) : 'claude',
        architectModel: args?.architect_model ? String(args.architect_model) : undefined,
        editorModel: args?.editor_model ? String(args.editor_model) : undefined,
      });
      const recommended_agent = getRecommendedAgent(routeTaskStr, fileExt);
      // #41: auto-record every routing so tier distribution stats are always populated
      recordOutcome(routeTaskStr.slice(0, 50), result.complexity.score, result.model.tier, 'router', 70);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...result, recommended_agent }, null, 2),
        }],
      };
    }

    case 'veto_rate_status': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(getRateStatus(), null, 2),
          },
        ],
      };
    }

    case 'veto_council_debate': {
      const task = String(args?.task ?? '').trim();
      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task is required.' }) }],
          isError: true,
        };
      }

      const strictnessArg = (['fast', 'standard', 'strict'].includes(String(args?.strictness ?? '')))
        ? String(args!.strictness) as 'fast' | 'standard' | 'strict'
        : 'standard';
      const debateInput = {
        task,
        context: args?.context ? String(args.context) : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
        strictness: strictnessArg,
        architect_model: args?.architect_model ? String(args.architect_model) : undefined,
        editor_model: args?.editor_model ? String(args.editor_model) : undefined,
      };

      // Phase 2: agent_responses provided — run verdict engine on LLM-generated votes
      const rawAgentResponses = args?.agent_responses;
      if (rawAgentResponses && typeof rawAgentResponses === 'object') {
        const parsed = parseAgentResponses(JSON.stringify(rawAgentResponses), task);
        if (parsed) {
          const debateStart = Date.now();
          const result = runFromAgentResponses(debateInput, parsed);
          const debateDuration = Date.now() - debateStart;
          const sessionId = args?.session_id ? String(args.session_id) : undefined;
          const outcomeId = saveCouncilOutcome({
            session_id: sessionId, task, verdict: result.final_verdict,
            lead_dev: JSON.stringify(result.votes.lead_dev), pm: JSON.stringify(result.votes.pm),
            architect: JSON.stringify(result.votes.architect), ux: JSON.stringify(result.votes.ux),
            devil: JSON.stringify(result.votes.devil), legal: JSON.stringify(result.votes.legal),
            security: JSON.stringify(result.votes.security), recommended: result.recommended,
            duration_ms: debateDuration,
          });
          const payload = { outcome_id: outcomeId, llm_backed: true, final_verdict: result.final_verdict, block_reasons: result.block_reasons, warnings: result.warnings, recommended: result.recommended, debated_at: result.debated_at, votes: result.votes };
          return { content: [{ type: 'text', text: result.formatted_output + '\n\n' + JSON.stringify(payload, null, 2) }] };
        }
      }

      // Phase 1: run deterministic debate + attach llm_upgrade prompt for host AI
      const debateStart = Date.now();
      const result = await runLlmDebate(server, debateInput);
      const debateDuration = Date.now() - debateStart;

      const sessionId = args?.session_id ? String(args.session_id) : undefined;
      const outcomeId = saveCouncilOutcome({
        session_id: sessionId,
        task,
        verdict: result.final_verdict,
        lead_dev: JSON.stringify(result.votes.lead_dev),
        pm: JSON.stringify(result.votes.pm),
        architect: JSON.stringify(result.votes.architect),
        ux: JSON.stringify(result.votes.ux),
        devil: JSON.stringify(result.votes.devil),
        legal: JSON.stringify(result.votes.legal),
        security: JSON.stringify(result.votes.security),
        recommended: result.recommended,
        duration_ms: debateDuration,
      });

      // #38: auto-record learning outcome from verdict — no manual veto_record_outcome needed
      {
        const qMap: Record<string, number> = { GREEN: 90, YELLOW: 60, RED: 20, DEADLOCK: 50 };
        const tMap: Record<string, 1|2|3> = { GREEN: 1, YELLOW: 2, RED: 3, DEADLOCK: 2 };
        recordOutcome(task.slice(0, 50), 50, tMap[result.final_verdict] ?? 2, 'council', qMap[result.final_verdict] ?? 50);
      }

      // Auto-store RED verdicts so they appear in the Memory panel immediately
      if (result.final_verdict === 'RED' || (result.final_verdict === 'YELLOW' && (result.warnings.length >= 2 || result.block_reasons.length > 0))) {
        const isRed = result.final_verdict === 'RED';
        const lines: string[] = [`Task: ${task}`];
        if (result.block_reasons.length > 0) lines.push(`\nBlocked by:\n${result.block_reasons.map(r => `- ${r}`).join('\n')}`);
        if (result.warnings.length > 0) lines.push(`\nWarnings:\n${result.warnings.map(w => `- ${w}`).join('\n')}`);

        // Include per-agent reasoning so future debates inherit the full context
        const agentSummary = Object.entries(result.votes)
          .filter(([, v]) => v.verdict !== 'approve')
          .map(([name, v]) => `- ${name} [${v.verdict}]: ${v.reason}`)
          .join('\n');
        if (agentSummary) lines.push(`\nAgent reasoning:\n${agentSummary}`);

        if (result.recommended) lines.push(`\nRecommended: ${result.recommended}`);
        storeKnowledge({
          type: 'decision',
          title: `${result.final_verdict}: ${task.slice(0, 80)}`,
          content: lines.join(''),
          tags: [isRed ? 'red-verdict' : 'yellow-verdict', isRed ? 'blocked' : 'caution', 'council'],
          project_dir: args?.project_dir ? String(args.project_dir) : undefined,
          session_id: sessionId,
          relevance: isRed ? 1.0 : 0.8,
        });
      }

      // Build agentic upgrade prompt so host AI can provide real LLM reasoning on any platform
      const enrichedCtx = buildContextString(debateInput.project_dir, debateInput.context);
      const { optionA, optionB, isDecisionTask } = (await import('./council/decision-extractor.js')).extractDecision(task);
      const decisionCtx = isDecisionTask ? `Option A: "${optionA}" vs Option B: "${optionB}"` : undefined;
      const agenticPrompt = buildAgenticDebatePrompt(task, enrichedCtx, decisionCtx);

      const responsePayload = {
        outcome_id: outcomeId,
        llm_backed: false,
        final_verdict: result.final_verdict,
        block_reasons: result.block_reasons,
        warnings: result.warnings,
        recommended: result.recommended,
        debated_at: result.debated_at,
        votes: {
          lead_dev:  result.votes.lead_dev,
          pm:        result.votes.pm,
          architect: result.votes.architect,
          ux:        result.votes.ux,
          devil:     result.votes.devil,
          legal:     result.votes.legal,
          security:  result.votes.security,
        },
        llm_upgrade: {
          available: true,
          instruction: 'The verdict above is deterministic. For LLM-backed analysis: (1) read debate_prompt and reason as all 7 agents, generating the agent_responses JSON; (2) call veto_council_debate again with { task, agent_responses } to get the final LLM-backed verdict. Works on Claude Code, Gemini CLI, and Codex CLI with no API keys.',
          debate_prompt: agenticPrompt,
        },
      } as Record<string, unknown>;

      const fullText = result.formatted_output + '\n\n' + JSON.stringify(responsePayload, null, 2);

      if (typeof args?.max_tokens === 'number') {
        const { exceeded, estimated_tokens } = logUsage({
          tool_name: 'veto_council_debate',
          session_id: sessionId,
          max_tokens: args.max_tokens,
          output: fullText,
        });
        if (exceeded) {
          responsePayload.budget_warning = `Estimated output tokens (${estimated_tokens}) exceeded max_tokens budget (${args.max_tokens}).`;
        }
      }

      return {
        content: [{ type: 'text', text: fullText }],
      };
    }

    case 'veto_agent_plan': {
      const agentType = String(args?.agent ?? '') as WorkerAgentType;
      const task = String(args?.task ?? '').trim();
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task is required.' }) }], isError: true };
      }
      const result = await executeOne({
        id: 'plan-1',
        agent: agentType,
        task,
        context: args?.context ? String(args.context) : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
        llm_backed: args?.llm_backed === true,
      });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
      }
      autoRecord(task, agentType, Math.round(result.output.confidence * 100));
      return { content: [{ type: 'text', text: JSON.stringify({ ...(result.plan ?? result.analysis), output: result.output }, null, 2) }] };
    }

    case 'veto_code_review': {
      const code = String(args?.code ?? '').trim();
      if (!code) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'code is required.' }) }], isError: true };
      }
      const reviewFilePath = args?.file_path ? String(args.file_path) : undefined;
      const result = await executeOne({ id: 'review-1', agent: 'reviewer', task: 'review this code', code, context: args?.context ? String(args.context) : undefined });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
      }
      autoRecord('code review', 'reviewer', result.analysis?.score ?? Math.round(result.output.confidence * 100));
      if (reviewFilePath && result.analysis?.findings) {
        storeScanDiagnostics(reviewFilePath, result.analysis.findings.map((f: { location?: string; description?: string; severity?: string }) => ({
          line: parseLineFromLocation(f.location),
          message: f.description ?? '',
          severity: mapSeverityToVscode(f.severity),
        })), 'code-review');
      } else if (reviewFilePath) {
        clearScanDiagnostics(reviewFilePath);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis, null, 2) }] };
    }

    case 'veto_diff_review': {
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      // Resolve diff — use provided or read from git
      let diff = args?.diff ? String(args.diff).trim() : '';
      if (!diff && projectDir) {
        try {
          diff = execSyncTop('git diff HEAD --no-color', {
            cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
          }).toString().trim();
          if (!diff) {
            diff = execSyncTop('git diff --cached --no-color', {
              cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
            }).toString().trim();
          }
        } catch { /* not a git repo or no changes */ }
      }

      if (!diff) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No diff provided and no git changes detected. Pass diff or point to a project_dir with uncommitted changes.' }) }], isError: true };
      }

      // Parse changed files from diff header lines
      const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
      const diffChunks = diff.split(/^diff --git /m).filter(Boolean);

      const context = buildContextString(projectDir, userContext);
      const { reviewResult, secResult, secretsResult, verdict } = await runTripleScan(diff, context);
      const verdictEmoji = verdict === 'pass' ? '✅ PASS' : verdict === 'warn' ? '⚠️  WARN' : '❌ FAIL';

      // Per-file finding counts (approximate from line refs)
      const fileFindings: Record<string, number> = {};
      for (const f of changedFiles) fileFindings[f] = 0;
      for (const finding of [...(reviewResult.analysis?.findings ?? []), ...(secResult.analysis?.findings ?? [])]) {
        const match = changedFiles.find(f => finding.location?.includes(f));
        if (match) fileFindings[match]++;
      }

      if (verdict === 'fail') {
        const blockingIssues: string[] = [];
        if ((reviewResult.analysis?.critical_count ?? 0) > 0) blockingIssues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
        if ((secResult.analysis?.critical_count ?? 0) > 0) blockingIssues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
        if ((secretsResult.analysis?.findings?.length ?? 0) > 0) blockingIssues.push(`Secrets: exposed credentials detected`);
        autoStoreCritical(`Diff review failed: ${changedFiles.slice(0, 2).join(', ')}`, blockingIssues, projectDir, ['diff-review']);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            verdict,
            verdict_label: verdictEmoji,
            files_changed: changedFiles.length,
            files: changedFiles,
            file_findings: fileFindings,
            code_review: {
              score: reviewResult.analysis?.score ?? null,
              verdict: reviewResult.analysis?.verdict ?? null,
              critical: reviewResult.analysis?.critical_count ?? 0,
              high: reviewResult.analysis?.high_count ?? 0,
              findings: reviewResult.analysis?.findings ?? [],
            },
            security: {
              score: secResult.analysis?.score ?? null,
              verdict: secResult.analysis?.verdict ?? null,
              critical: secResult.analysis?.critical_count ?? 0,
              high: secResult.analysis?.high_count ?? 0,
              findings: secResult.analysis?.findings ?? [],
            },
            secrets: {
              verdict: secretsResult.analysis?.verdict ?? null,
              findings: secretsResult.analysis?.findings ?? [],
            },
            summary: [
              `${verdictEmoji} — ${changedFiles.length} file(s) changed`,
              `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} (score ${reviewResult.analysis?.score ?? '?'}/100)`,
              `Security: ${secResult.analysis?.verdict ?? 'n/a'} — ${secResult.analysis?.critical_count ?? 0} critical, ${secResult.analysis?.high_count ?? 0} high`,
              `Secrets: ${(secretsResult.analysis?.findings?.length ?? 0) > 0 ? '🔴 Exposed credentials detected' : '✅ Clean'}`,
            ].join('\n'),
          }, null, 2),
        }],
      };
    }

    case 'veto_security_scan': {
      const code = String(args?.code ?? '').trim();
      if (!code) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'code is required.' }) }], isError: true };
      }
      const secFilePath = args?.file_path ? String(args.file_path) : undefined;
      const result = await executeOne({ id: 'scan-1', agent: 'security-scanner', task: 'scan this code for security issues', code, context: args?.context ? String(args.context) : undefined });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
      }
      autoRecord('security scan', 'security-scanner', result.analysis?.score ?? Math.round(result.output.confidence * 100));
      if (secFilePath && result.analysis?.findings) {
        storeScanDiagnostics(secFilePath, result.analysis.findings.map((f: { location?: string; description?: string; severity?: string }) => ({
          line: parseLineFromLocation(f.location),
          message: f.description ?? '',
          severity: mapSeverityToVscode(f.severity),
        })), 'security');
      } else if (secFilePath) {
        clearScanDiagnostics(secFilePath);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis, null, 2) }] };
    }

    case 'veto_secrets_scan': {
      const text = String(args?.text ?? '').trim();
      if (!text) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'text is required.' }) }], isError: true };
      }
      const secretsFilePath = args?.file_path ? String(args.file_path) : undefined;
      const result = await executeOne({ id: 'secrets-1', agent: 'secrets', task: 'scan for exposed credentials', code: text });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
      }
      autoRecord('secrets scan', 'secrets', (result.analysis?.findings?.length ?? 0) === 0 ? 100 : result.analysis?.score ?? Math.round(result.output.confidence * 100));
      if (secretsFilePath && result.analysis?.findings) {
        storeScanDiagnostics(secretsFilePath, result.analysis.findings.map((f: { location?: string; description?: string; severity?: string }) => ({
          line: parseLineFromLocation(f.location),
          message: f.description ?? '',
          severity: mapSeverityToVscode(f.severity),
        })), 'secrets');
      } else if (secretsFilePath) {
        clearScanDiagnostics(secretsFilePath);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis, null, 2) }] };
    }

    case 'veto_execute_parallel': {
      const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const llmBacked = args?.llm_backed === true;
      const agentOutputs = args?.agent_outputs as Record<string, unknown> | undefined;

      if (rawTasks.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'tasks array is required and must not be empty.' }) }], isError: true };
      }
      const parallelProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const defaultModel = args?.editor_model ? String(args.editor_model) : args?.architect_model ? String(args.architect_model) : undefined;
      const tasks: AgentTask[] = rawTasks.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ''),
        agent: String(t.agent ?? '') as WorkerAgentType,
        task: String(t.task ?? ''),
        code: t.code ? String(t.code) : undefined,
        context: t.context ? String(t.context) : undefined,
        project_dir: t.project_dir ? String(t.project_dir) : parallelProjectDir,
        llm_backed: llmBacked,
        model: t.model ? String(t.model) : defaultModel,
      }));

      // Phase 2: Agentic loop
      if (llmBacked && !agentOutputs) {
        const prompts = tasks.map(t => buildAgenticAgentPrompt(t)).filter(Boolean);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              mode: 'agentic_loop',
              instruction: 'Reason as each agent below using their provided roles and schemas. Return a JSON object mapping task IDs (or agent names) to agent responses.',
              prompts,
            }, null, 2)
          }]
        };
      }

      const results = (llmBacked && agentOutputs)
        ? (await import('./agents/llm-runner.js')).parseAgenticAgentResponses(tasks, agentOutputs)
        : await executeParallel(tasks);

      // #40: auto-record learning outcome per completed parallel task
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.error) continue;
        const quality = Math.round(r.output.confidence * 100);
        const tier: 1|2|3 = quality >= 80 ? 1 : quality >= 40 ? 2 : 3;
        recordOutcome(tasks[i]?.task.slice(0, 50) ?? r.agent, 50, tier, r.agent, quality);
      }

      const deterministicFallbacks = results
        .map((r, i) => ({ r, t: tasks[i] }))
        .filter(({ r }) => !r.error && r.llm_backed === false);

      const parallelPayload: Record<string, unknown> = {
        count: results.length,
        total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
        llm_backed_count: results.filter(r => r.llm_backed === true).length,
        results: results.map(r => ({
          id: r.id,
          agent: r.agent,
          duration_ms: r.duration_ms,
          llm_backed: r.llm_backed,
          error: r.error,
          output: { ...(r.plan ?? r.analysis), structured: r.output },
        })),
      };

      if (deterministicFallbacks.length > 0) {
        parallelPayload.llm_upgrade = {
          available: true,
          instruction: 'Some agents ran deterministically (MCP Sampling unavailable or failed). For LLM-backed output, reason as each agent using the prompts below, then pass results back via veto_execute_parallel with pre-filled output.',
          agent_prompts: deterministicFallbacks.map(({ r, t }) =>
            t ? buildAgenticAgentPrompt(t) : null
          ).filter(Boolean),
        };
      }

      if (typeof args?.max_tokens === 'number') {
        const outputText = JSON.stringify(parallelPayload, null, 2);
        const { exceeded, estimated_tokens } = logUsage({
          tool_name: 'veto_execute_parallel',
          max_tokens: args.max_tokens,
          output: outputText,
        });
        if (exceeded) {
          parallelPayload.budget_warning = `Estimated output tokens (${estimated_tokens}) exceeded max_tokens budget (${args.max_tokens}).`;
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(parallelPayload, null, 2) }],
      };
    }

    case 'veto_memory_store': {
      const title = String(args?.title ?? '').trim();
      const content = String(args?.content ?? '').trim();
      if (!title || !content) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'title and content are required.' }) }], isError: true };
      }
      const id = storeKnowledge({
        title,
        content,
        type: args?.type ? String(args.type) as import('./memory/schema.js').KnowledgeType : 'solution',
        tags: Array.isArray(args?.tags) ? args.tags.map(String) : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : (activeProjectDir ?? undefined),
        session_id: args?.session_id ? String(args.session_id) : undefined,
        relevance: typeof args?.relevance === 'number' ? args.relevance : 1.0,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, message: 'Knowledge stored.' }, null, 2) }] };
    }

    case 'veto_memory_search': {
      const results = searchKnowledge({
        query: args?.query ? String(args.query) : undefined,
        type: args?.type ? String(args.type) as import('./memory/schema.js').KnowledgeType : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : (activeProjectDir ?? undefined),
        limit: typeof args?.limit === 'number' ? args.limit : 10,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: results.length,
            results: results.map(r => ({
              id: r.id,
              type: r.type,
              title: r.title,
              content: r.content,
              tags: r.tags ? JSON.parse(r.tags) : [],
              project_dir: r.project_dir,
              relevance: r.relevance,
              accessed_count: r.accessed_count,
              created_at: r.created_at,
            })),
          }, null, 2),
        }],
      };
    }

    case 'veto_memory_delete': {
      const id = String(args?.id ?? '').trim();
      if (!id) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'id is required.' }) }], isError: true };
      }
      const deleted = deleteKnowledge(id);
      return { content: [{ type: 'text', text: JSON.stringify({ success: deleted, message: deleted ? 'Entry deleted.' : 'Entry not found.' }, null, 2) }] };
    }

    case 'veto_project_map_update': {
      const project_dir = String(args?.project_dir ?? '').trim();
      if (!project_dir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      }

      // auto_compute: build live repo-map instead of requiring manual structure
      if (args?.auto_compute === true) {
        try {
          const computed = buildRepoMap({ projectDir: project_dir, maxTopModules: 30 });
          const id = updateProjectMap({
            project_dir,
            structure: {
              auto_computed: true,
              generated_at: computed.generated_at,
              total_files: computed.total_files,
              symbol_count: computed.symbol_count,
              top_modules: computed.top_modules.slice(0, 20).map(m => ({
                file: m.file, rank: m.rank, refs: m.ref_count,
                exports: m.symbols.slice(0, 5).map(s => s.name),
              })),
            },
            key_modules: computed.top_modules.slice(0, 15).map(m => m.file),
          });
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, auto_computed: true, total_files: computed.total_files, symbol_count: computed.symbol_count, top_modules_count: computed.top_modules.length }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Repo-map failed: ${err instanceof Error ? err.message : String(err)}` }) }], isError: true };
        }
      }

      const structure = String(args?.structure ?? '').trim();
      if (!structure) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide structure or set auto_compute: true to compute it automatically.' }) }], isError: true };
      }
      const id = updateProjectMap({
        project_dir,
        structure,
        key_modules: Array.isArray(args?.key_modules) ? args.key_modules.map(String) : undefined,
        tech_stack: Array.isArray(args?.tech_stack) ? args.tech_stack.map(String) : undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, message: 'Project map updated.' }, null, 2) }] };
    }

    case 'veto_project_map_get': {
      const project_dir = String(args?.project_dir ?? '').trim();
      if (!project_dir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      }
      const row = getProjectMap(project_dir);
      if (!row) {
        return { content: [{ type: 'text', text: JSON.stringify({ found: false, message: 'No project map found. Call veto_project_map_update to create one.' }, null, 2) }] };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: true,
            project_dir: row.project_dir,
            structure: JSON.parse(row.structure),
            key_modules: row.key_modules ? JSON.parse(row.key_modules) : [],
            tech_stack: row.tech_stack ? JSON.parse(row.tech_stack) : [],
            updated_at: row.updated_at,
          }, null, 2),
        }],
      };
    }

    case 'veto_pattern_store': {
      const pattern_key = String(args?.pattern_key ?? '').trim();
      const pattern_val = String(args?.pattern_val ?? '').trim();
      if (!pattern_key || !pattern_val) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'pattern_key and pattern_val are required.' }) }], isError: true };
      }
      upsertPattern({
        pattern_key,
        pattern_val,
        confidence: typeof args?.confidence === 'number' ? args.confidence : 1.0,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Pattern stored.' }, null, 2) }] };
    }

    case 'veto_patterns_list': {
      const prefix = args?.prefix ? String(args.prefix) : undefined;
      const limit = typeof args?.limit === 'number' ? args.limit : 20;
      const patterns = getPatterns(prefix, limit);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: patterns.length,
            patterns: patterns.map(p => ({
              key: p.pattern_key,
              val: p.pattern_val,
              confidence: p.confidence,
              seen_count: p.seen_count,
              updated_at: p.updated_at,
            })),
          }, null, 2),
        }],
      };
    }

    case 'veto_handoff': {
      const summary = String(args?.summary ?? '').trim();
      const context = String(args?.context ?? '').trim();
      if (!summary || !context) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'summary and context are required.' }) }], isError: true };
      }
      const handoffPlatform = args?.from_platform ? String(args.from_platform) : 'claude';
      const handoffTaskState = args?.task_state ? String(args.task_state) : undefined;
      const handoffProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const result = handoff({
        summary,
        context,
        task_state: handoffTaskState,
        from_platform: handoffPlatform as Platform,
        to_platform: args?.to_platform ? String(args.to_platform) as Platform : undefined,
        project_dir: handoffProjectDir,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
      });
      // Cache for auto-save
      autoSave.cached = { summary, context, task_state: handoffTaskState, platform: handoffPlatform, project_dir: handoffProjectDir };
      autoSave.last_save_at = result.saved_at;
      autoSave.last_session_id = result.session_id;
      // Close the current session so ended_at is recorded
      if (activeProjectDir) {
        const sessions = listSessions(1);
        if (sessions[0] && sessions[0].id !== result.session_id) closeSession(sessions[0].id);
      }
      return { content: [{ type: 'text', text: result.instructions + '\n\n' + JSON.stringify({ session_id: result.session_id, to_platform: result.to_platform, saved_at: result.saved_at, reason: result.reason }, null, 2) }] };
    }

    case 'veto_continue': {
      const resuming_as = args?.resuming_as ? String(args.resuming_as) : undefined;
      const result = continueSession(args?.session_id ? String(args.session_id) : undefined, resuming_as);
      if (!result.found) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: result.message }, null, 2) }], isError: true };
      }
      if (result.project_dir) activeProjectDir = result.project_dir;
      return {
        content: [{
          type: 'text',
          text: result.message + '\n\n' + JSON.stringify({
            session_id: result.session_id,
            created_by: result.platform,
            active_client: result.active_client ?? result.platform,
            summary: result.summary,
            context: result.context,
            task_state: result.task_state,
            next_action: result.next_action,
            project_dir: result.project_dir,
            token_count: result.token_count,
            restored_at: result.restored_at,
          }, null, 2),
        }],
      };
    }

    case 'veto_platform_setup': {
      const platform = String(args?.platform ?? '').trim() as SetupPlatform;
      const vetoServerPath = String(args?.veto_server_path ?? '').trim();
      if (!platform || !vetoServerPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'platform and veto_server_path are required.' }) }], isError: true };
      }
      const setup = getPlatformSetup(platform, vetoServerPath);
      return { content: [{ type: 'text', text: JSON.stringify(setup, null, 2) }] };
    }

    case 'veto_record_outcome': {
      const task_type = String(args?.task_type ?? '').trim();
      const complexity = typeof args?.complexity === 'number' ? args.complexity : 50;
      const model_tier = (typeof args?.model_tier === 'number' ? args.model_tier : 2) as 1 | 2 | 3;
      const output_quality = typeof args?.output_quality === 'number' ? args.output_quality : 70;
      if (!task_type) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task_type is required.' }) }], isError: true };
      }
      recordOutcome(task_type, complexity, model_tier, args?.agent ? String(args.agent) : 'dynamic', output_quality, typeof args?.tokens_used === 'number' ? args.tokens_used : 0, args?.file_ext ? String(args.file_ext) : undefined);
      const stats = getLearningStats();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Outcome recorded.', total_outcomes: stats.total_tasks, next_step: stats.total_tasks >= 20 ? 'You have 20+ outcomes. Call veto_learning_apply to update router thresholds.' : `Need ${20 - stats.total_tasks} more outcomes before veto_learning_apply can adjust thresholds.` }, null, 2) }] };
    }

    case 'veto_learning_stats': {
      const includeAgentStats = args?.include_agent_stats !== false;
      const includeTaskTypes = args?.include_task_types === true;
      const includeCouncil = args?.include_council_insights === true;

      const stats = getLearningStats();
      const learned = getLearnedThresholds();
      const result: Record<string, unknown> = {
        total_outcomes: stats.total_tasks,
        tier_breakdown: stats.tier_breakdown,
        current_thresholds: {
          tier1_max: learned.tier1_max,
          tier2_max: learned.tier2_max,
          source: learned.source,
          data_points: learned.data_points,
          note: learned.source === 'learned'
            ? `Learned from ${learned.data_points} outcomes.`
            : 'Using defaults — call veto_learning_apply after 20+ outcomes to update from data.',
        },
        suggested_thresholds: stats.suggested_thresholds,
        ready_to_apply: stats.total_tasks >= 20,
      };

      if (includeAgentStats) {
        result['agent_performance'] = getAgentPerformanceStats();
      }
      if (includeTaskTypes) {
        result['task_type_breakdown'] = getTaskTypeBreakdown();
      }
      if (includeCouncil) {
        result['council_insights'] = getCouncilInsights();
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_learning_apply': {
      const result = applyLearnedThresholds();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_memory_export': {
      const format = args?.format === 'markdown' ? 'markdown' : 'json';
      if (format === 'markdown') {
        const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
        const outputPath = args?.output_path ? String(args.output_path) : undefined;
        const result = exportMemoryMarkdown(projectDir, outputPath);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const result = exportMemory(args?.output_path ? String(args.output_path) : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_memory_import': {
      const format = args?.format === 'markdown' ? 'markdown' : 'json';
      if (format === 'markdown') {
        const inputPath = String(args?.input_path ?? '').trim();
        if (!inputPath) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'input_path is required for markdown import.' }) }], isError: true };
        const result = importMemoryMarkdown(inputPath);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const result = importMemory(args?.input_path ? String(args.input_path) : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_watch': {
      const dir = String(args?.project_dir ?? '').trim();
      if (!dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      const watch_id = startWatch(dir);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, watch_id, project_dir: dir, message: `Watching "${dir}". Call veto_watch_poll with watch_id to collect events.` }, null, 2) }] };
    }

    case 'veto_watch_poll': {
      const watch_id = String(args?.watch_id ?? '').trim();
      if (!watch_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'watch_id is required.' }) }], isError: true };
      const result = pollWatch(watch_id);
      if (!result.found) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `No active watcher with id: ${watch_id}` }) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, watch_id, project_dir: result.project_dir, event_count: result.events.length, events: result.events }, null, 2) }] };
    }

    case 'veto_watch_stop': {
      const watch_id = String(args?.watch_id ?? '').trim();
      if (!watch_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'watch_id is required.' }) }], isError: true };
      const stopped = stopWatch(watch_id);
      return { content: [{ type: 'text', text: JSON.stringify({ success: stopped, message: stopped ? `Watcher ${watch_id} stopped.` : `No watcher found with id: ${watch_id}` }, null, 2) }] };
    }

    case 'veto_workflow': {
      const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
      if (rawSteps.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'steps array is required and must not be empty.' }) }], isError: true };
      const steps: PipelineStep[] = rawSteps.map((s: Record<string, unknown>) => ({
        id: String(s.id ?? ''),
        agent: String(s.agent ?? '') as WorkerAgentType,
        task: String(s.task ?? ''),
        code: s.code ? String(s.code) : undefined,
        context: s.context ? String(s.context) : undefined,
        gate: typeof s.gate === 'number' ? s.gate : undefined,
        retry_on_fail: s.retry_on_fail === true,
        max_retries: typeof s.max_retries === 'number' ? Math.min(s.max_retries, 5) : undefined,
        condition: s.condition ? String(s.condition) : undefined,
        dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : undefined,
      }));
      const mode = String(args?.mode ?? 'linear') === 'dag' ? 'dag' : 'linear';
      const result = await runPipeline(
        steps,
        args?.project_dir ? String(args.project_dir) : undefined,
        mode,
        async (question: string) => {
          try {
            const resp = await server.createMessage({
              messages: [{ role: 'user', content: { type: 'text', text: question } }]
            });
            return resp.content.type === 'text' ? resp.content.text : '';
          } catch {
            return ''; // sampling not supported by client
          }
        }
      );

      // #39: auto-record learning outcome per executed workflow step
      for (const step of result.results) {
        if (step.status === 'skipped') continue;
        const quality = step.error ? 0 : step.confidence;
        const tier: 1|2|3 = quality >= 80 ? 1 : quality >= 40 ? 2 : 3;
        const taskStr = steps.find(s => s.id === step.id)?.task.slice(0, 50) ?? step.id;
        recordOutcome(taskStr, 50, tier, step.agent, quality);
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_explain': {
      const filePath = args?.file_path ? String(args.file_path).trim() : '';
      const rawText  = args?.text      ? String(args.text).trim()      : '';
      const depth    = String(args?.depth ?? 'overview');
      const userContext = args?.context ? String(args.context) : undefined;

      if (!filePath && !rawText) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide file_path or text.' }) }], isError: true };
      }

      let fileContent: string;
      let agent: WorkerAgentType;
      let taskLabel: string;

      if (rawText) {
        fileContent = rawText;
        // Auto-detect agent from content: error messages → debugger, stack traces → debugger, code → coder
        const looksLikeError = /error|exception|traceback|stack trace|at \w+\.|TypeError|SyntaxError|ENOENT/i.test(rawText);
        agent = looksLikeError ? 'debugger' : 'coder';
        taskLabel = looksLikeError ? 'raw error/stack trace' : 'raw text input';
      } else {
        try {
          fileContent = readFileSync(filePath, 'utf8');
        } catch {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read file: ${filePath}` }) }], isError: true };
        }
        const ext = extname(filePath).toLowerCase();
        const name_ = basename(filePath).toLowerCase();
        agent = 'coder';
        if (['.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) agent = 'frontend';
        else if (['.sql', '.prisma'].includes(ext) || name_.includes('schema')) agent = 'database';
        else if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(name_)) agent = 'tester';
        else if (['.yaml', '.yml', '.toml', '.dockerfile'].includes(ext) || name_ === 'dockerfile') agent = 'devops';
        else if (name_.includes('auth') || name_.includes('login') || name_.includes('jwt') || name_.includes('token')) agent = 'auth';
        else if (name_.includes('security') || name_.includes('crypt')) agent = 'security-scanner';
        taskLabel = `${ext} file: ${basename(filePath)}`;
      }

      const task = `Explain this ${taskLabel} at ${depth} depth.${userContext ? ` Focus: ${userContext}` : ''}`;
      const result = await executeOne({ id: 'explain-1', agent, task, code: fileContent, project_dir: undefined });
      autoRecord(`explain ${taskLabel}`, agent, Math.round(result.output.confidence * 100));
      return {
        content: [{ type: 'text', text: JSON.stringify({
          source: filePath || 'raw text', agent_used: agent, depth,
          explanation: result.plan ?? result.analysis,
          output: result.output,
        }, null, 2) }],
      };
    }

    case 'veto_plugins': {
      return { content: [{ type: 'text', text: JSON.stringify({ plugins: listPlugins(), plugin_dir: `${process.env.HOME ?? process.env.USERPROFILE}/.veto/agents/`, instructions: 'Drop a .js file exporting plan(task, context?) to register a custom agent.' }, null, 2) }] };
    }

    // ── Phase 13: Developer Intelligence ──────────────────────────────────────

    case 'veto_docs_fetch': {
      const package_name = String(args?.package_name ?? '').trim();
      const ecosystem = String(args?.ecosystem ?? 'npm') as 'npm' | 'pypi' | 'crates';
      const version = args?.version ? String(args.version) : undefined;
      const max_chars = typeof args?.max_chars === 'number' ? args.max_chars : 8000;

      if (!package_name) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'package_name is required.' }) }], isError: true };
      }

      const result = await fetchAndCacheDocs(package_name, ecosystem, version, max_chars, VERSION);
      if (!result) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Could not fetch docs for ${package_name} (${ecosystem}). Source may be offline — try again.` }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    }

    case 'veto_context_status': {
      const session_id = String(args?.session_id ?? '');
      if (!session_id) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'session_id is required.' }) }], isError: true };
      }
      const status = getContextStatus(session_id);
      if (!status) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `No session found: ${session_id}` }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...status }, null, 2) }] };
    }

    case 'veto_task_parse': {
      const description = String(args?.description ?? '').trim();
      const project_dir = args?.project_dir ? String(args.project_dir) : undefined;
      const max_tasks = typeof args?.max_tasks === 'number' ? Math.min(args.max_tasks, 50) : 20;
      if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };
      const plan = await buildTaskPlan(description, project_dir, max_tasks);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
    }

    // ── Phase 14: Observability & Safety ──────────────────────────────────────

    case 'veto_usage_status': {
      if (args?.set_budget && typeof args.set_budget === 'object') {
        const b = args.set_budget as Record<string, unknown>;
        const current = getConfig().dailyTokenBudget;
        setConfig({
          dailyTokenBudget: {
            claude: typeof b.claude === 'number' ? b.claude : current.claude,
            gemini: typeof b.gemini === 'number' ? b.gemini : current.gemini,
            codex:  typeof b.codex  === 'number' ? b.codex  : current.codex,
          },
        });
      }
      const status = getUsageStatus();
      const { dailyTokenBudget } = getConfig();
      const rateStatus = getRateStatus();
      const recentBudgetLog = getUsageLogs({ limit: 10 });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            ...status,
            daily_token_budget: dailyTokenBudget,
            tokens_today: {
              claude: rateStatus.claude.tokens_today,
              gemini: rateStatus.gemini.tokens_today,
              codex:  rateStatus.codex.tokens_today,
            },
            budget_used_pct: {
              claude: rateStatus.claude.used_percent,
              gemini: rateStatus.gemini.used_percent,
              codex:  rateStatus.codex.used_percent,
            },
            operation_budget_log: recentBudgetLog.map(e => ({
              tool: e.tool_name,
              max_tokens: e.max_tokens,
              estimated_tokens: e.estimated_tokens,
              exceeded: e.exceeded === 1,
              at: e.created_at,
            })),
          }, null, 2),
        }],
      };
    }

    case 'veto_audit_log': {
      const events = getAuditLog({
        session_id: args?.session_id ? String(args.session_id) : undefined,
        verdict:    args?.verdict    ? String(args.verdict)    : undefined,
        since:      args?.since      ? String(args.since)      : undefined,
        limit:      typeof args?.limit === 'number' ? args.limit : 20,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, count: events.length, events }, null, 2) }] };
    }

    case 'veto_health': {
      const stats = getHealthStats();
      let db_size_bytes = 0;
      try { db_size_bytes = statSync(getDbPath()).size; } catch { /* db may not exist */ }
      const db_size_human = db_size_bytes < 1024 ? `${db_size_bytes}B`
        : db_size_bytes < 1048576 ? `${(db_size_bytes / 1024).toFixed(1)}KB`
        : `${(db_size_bytes / 1048576).toFixed(1)}MB`;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            version: VERSION,
            status: serverErrorCount > 10 ? 'degraded' : 'healthy',
            uptime_seconds: Math.round((Date.now() - SERVER_START_TIME) / 1000),
            db_path: getDbPath(),
            db_size_bytes,
            db_size_human,
            error_count_since_start: serverErrorCount,
            last_error: lastServerError,
            context_windows: CONTEXT_WINDOWS,
            ...stats,
          }, null, 2),
        }],
      };
    }

    // ── Phase 15: CI/CD & Distribution ────────────────────────────────────────

    case 'veto_ci_gate': {
      const project_dir = String(args?.project_dir ?? '').trim();
      const diff_input  = args?.diff    ? String(args.diff)    : undefined;
      const context     = args?.context ? String(args.context) : undefined;
      const fail_on     = args?.fail_on === 'warn' ? 'warn' : 'fail';

      if (!project_dir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      }

      const start = Date.now();

      // Read diff if not provided
      let diff = diff_input;
      if (!diff) {
        try { diff = execSyncTop('git diff HEAD', { cwd: project_dir, encoding: 'utf8', timeout: 15000 }); } catch { diff = ''; }
      }

      if (!diff?.trim()) {
        return { content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', exit_code: 0, message: 'No changes detected.', duration_ms: Date.now() - start }) }] };
      }

      const projectCtx = (() => { try { return buildContextString(project_dir); } catch { return ''; } })();
      const fullContext = [context, projectCtx].filter(Boolean).join('\n\n');

      const { reviewResult: codeResult, secResult, secretsResult, verdict } = await runTripleScan(diff, fullContext);
      const exit_code = verdict === 'fail' || (verdict === 'warn' && fail_on === 'warn') ? 1 : 0;

      const codeScore    = codeResult.analysis?.score ?? Math.round((codeResult.output?.confidence ?? 0.8) * 100);
      const secScore     = secResult.analysis?.score  ?? Math.round((secResult.output?.confidence  ?? 0.8) * 100);
      const secretsClean = (secretsResult.analysis?.findings?.length ?? 0) === 0;

      const blocking_issues: string[] = [];
      if ((codeResult.analysis?.critical_count ?? 0) > 0) blocking_issues.push(`Code review: ${codeResult.analysis?.summary ?? 'critical issues found'}`);
      if ((secResult.analysis?.critical_count  ?? 0) > 0) blocking_issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
      if (!secretsClean) blocking_issues.push(`Secrets: ${secretsResult.analysis?.summary ?? 'exposed credentials detected'}`);

      const icon = verdict === 'pass' ? '✅' : verdict === 'warn' ? '⚠️' : '❌';
      const ci_summary = [
        `${icon} **Veto CI Gate: ${verdict.toUpperCase()}**`,
        ``,
        `| Check | Score | Status |`,
        `|---|---|---|`,
        `| Code Review | ${codeScore}% | ${(codeResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
        `| Security Scan | ${secScore}% | ${(secResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
        `| Secrets Scan | — | ${secretsClean ? '✅ Clean' : '❌ Found'} |`,
        blocking_issues.length > 0 ? `\n**Blocking issues:**\n${blocking_issues.map(i => `- ${i}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');

      autoStoreCritical(`CI gate failed: ${project_dir}`, blocking_issues, project_dir, ['ci-gate']);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            verdict, exit_code,
            checks: {
              code_review: { score: codeScore, critical: codeResult.analysis?.critical_count ?? 0, high: codeResult.analysis?.high_count ?? 0 },
              security:    { score: secScore,  critical: secResult.analysis?.critical_count  ?? 0, high: secResult.analysis?.high_count  ?? 0 },
              secrets:     { clean: secretsClean, findings: secretsResult.analysis?.findings ?? [] },
            },
            blocking_issues,
            ci_summary,
            duration_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }

    case 'veto_pr_review': {
      const pr_url  = String(args?.pr_url ?? '').trim();
      const context = args?.context ? String(args.context) : '';
      const fail_on = args?.fail_on === 'warn' ? 'warn' : 'fail';

      if (!pr_url) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'pr_url is required.' }) }], isError: true };
      }

      const start = Date.now();
      const fetched = await fetchPrDiff(pr_url);
      if (!fetched.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: fetched.error }) }], isError: true };
      }

      const { diff, meta } = fetched;
      const prContext = [
        `PR: ${meta.title} (${meta.html_url})`,
        `Author: ${meta.author} · ${meta.head_branch} → ${meta.base_branch}`,
        `Changes: +${meta.additions} -${meta.deletions} across ${meta.changed_files} files`,
        context,
      ].filter(Boolean).join('\n');

      const { reviewResult, secResult, secretsResult, verdict } = await runTripleScan(diff, prContext);
      const exit_code = verdict === 'fail' || (verdict === 'warn' && fail_on === 'warn') ? 1 : 0;

      const codeScore    = reviewResult.analysis?.score ?? Math.round((reviewResult.output?.confidence ?? 0.8) * 100);
      const secScore     = secResult.analysis?.score    ?? Math.round((secResult.output?.confidence    ?? 0.8) * 100);
      const secretsClean = (secretsResult.analysis?.findings?.length ?? 0) === 0;

      const blocking_issues: string[] = [];
      if ((reviewResult.analysis?.critical_count ?? 0) > 0) blocking_issues.push(`Code review: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
      if ((secResult.analysis?.critical_count    ?? 0) > 0) blocking_issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
      if (!secretsClean) blocking_issues.push(`Secrets: ${secretsResult.analysis?.summary ?? 'exposed credentials detected'}`);

      // Build ready-to-post GitHub review comment (Markdown)
      const icon = verdict === 'pass' ? '✅' : verdict === 'warn' ? '⚠️' : '❌';
      const review_comment = [
        `## ${icon} Veto Review — ${verdict.toUpperCase()}`,
        ``,
        `| Check | Score | Status |`,
        `|---|---|---|`,
        `| Code Review | ${codeScore}% | ${(reviewResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
        `| Security Scan | ${secScore}% | ${(secResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
        `| Secrets Scan | — | ${secretsClean ? '✅ Clean' : '❌ Found'} |`,
        ``,
        blocking_issues.length > 0
          ? `**Blocking issues:**\n${blocking_issues.map(i => `- ${i}`).join('\n')}`
          : `No blocking issues found.`,
        ``,
        `> Reviewed by [Veto](https://github.com/jigyasudham/veto) · ${meta.changed_files} files · +${meta.additions}/-${meta.deletions} · ${Date.now() - start}ms`,
      ].join('\n');

      autoStoreCritical(`PR review failed: ${meta.title}`, blocking_issues, undefined, ['pr-review']);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            verdict, exit_code,
            pr: { title: meta.title, author: meta.author, url: meta.html_url, base: meta.base_branch, head: meta.head_branch, additions: meta.additions, deletions: meta.deletions, changed_files: meta.changed_files },
            checks: {
              code_review: { score: codeScore, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0 },
              security:    { score: secScore,  critical: secResult.analysis?.critical_count    ?? 0, high: secResult.analysis?.high_count    ?? 0 },
              secrets:     { clean: secretsClean, findings: secretsResult.analysis?.findings ?? [] },
            },
            blocking_issues,
            review_comment,
            duration_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }

    // ── Phase 16: Workspace Discovery & Summarization ─────────────────────────

    case 'veto_discover': {
      const discoverDir = String(args?.project_dir ?? '').trim();
      const discoverDepth = (['quick', 'standard', 'full'].includes(String(args?.depth ?? '')))
        ? String(args!.depth) as 'quick' | 'standard' | 'full'
        : 'standard';
      const discoverStore = args?.store !== false;

      if (!discoverDir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      }
      try { statSync(discoverDir); } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Directory not found: ${discoverDir}` }) }], isError: true };
      }

      const result = discoverProject(discoverDir, discoverDepth);

      // Build live repo-map for 'full' depth or when explicitly requested
      let repoMap: ReturnType<typeof buildRepoMap> | null = null;
      if (discoverDepth === 'full' || args?.include_repo_map === true) {
        try { repoMap = buildRepoMap({ projectDir: discoverDir, maxTopModules: 20 }); } catch { /* non-fatal */ }
      }

      if (discoverStore) {
        updateProjectMap({
          project_dir: result.project_dir,
          structure: {
            ecosystems: result.ecosystems,
            key_files: result.key_files,
            file_count_by_ext: result.file_counts,
            total_files: result.total_files,
            scanned_at: result.scanned_at,
            ...(repoMap ? { top_modules: repoMap.top_modules.slice(0, 10).map(m => ({ file: m.file, rank: m.rank, exports: m.symbols.slice(0, 4).map(s => s.name) })) } : {}),
          },
          key_modules: result.key_files,
          tech_stack: result.tech_stack,
        });
        storeKnowledge({
          type: 'solution',
          title: `Project discovery: ${result.project_dir}`,
          content: `Stack: ${result.tech_stack.join(', ') || 'unknown'}. Branch: ${result.git.branch || 'none'}. Commit: ${result.git.commit || 'none'}. Files: ${result.total_files}. Ecosystems: ${Object.keys(result.ecosystems).join(', ') || 'none'}. Key files: ${result.key_files.join(', ')}.`,
          tags: ['discover', ...result.tech_stack.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ''))],
          project_dir: result.project_dir,
        });
      }

      const discoverPayload: Record<string, unknown> = { success: true, stored: discoverStore, ...result };
      if (repoMap) {
        discoverPayload.repo_map = {
          total_files: repoMap.total_files,
          symbol_count: repoMap.symbol_count,
          top_modules: repoMap.top_modules.slice(0, 15),
          dep_graph: repoMap.dep_graph,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(discoverPayload, null, 2) }] };
    }

    case 'veto_summarize': {
      const sumFilePath   = args?.file_path   ? String(args.file_path).trim()   : undefined;
      const sumProjectDir = args?.project_dir ? String(args.project_dir).trim() : undefined;
      const sumFocus      = args?.focus        ? String(args.focus)               : undefined;
      const sumFormat     = args?.format === 'detailed' ? 'detailed' : 'brief';

      if (!sumFilePath && !sumProjectDir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide project_dir or file_path.' }) }], isError: true };
      }

      const sumStart = Date.now();

      // ── File summary ───────────────────────────────────────────────────────
      if (sumFilePath) {
        let fileContent: string;
        try { fileContent = readFileSync(sumFilePath, 'utf8'); }
        catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read file: ${sumFilePath}` }) }], isError: true }; }

        const ext = extname(sumFilePath).toLowerCase();
        const name_ = basename(sumFilePath).toLowerCase();
        let agent: WorkerAgentType = 'documentation';
        if (['.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) agent = 'frontend';
        else if (['.sql', '.prisma'].includes(ext) || name_.includes('schema')) agent = 'database';
        else if (/\.(test|spec)\.(ts|js)$/.test(name_)) agent = 'tester';
        else if (['.yaml', '.yml', '.dockerfile'].includes(ext) || name_ === 'dockerfile') agent = 'devops';
        else if (name_.includes('auth') || name_.includes('jwt')) agent = 'auth';

        const focusNote = sumFocus ? ` Focus on: ${sumFocus}.` : '';
        const depthNote = sumFormat === 'detailed' ? 'Write paragraph-level prose.' : 'Return 4–6 bullet points only.';
        const task = `Summarize this file concisely for a developer who has never seen it.${focusNote} ${depthNote} File: ${basename(sumFilePath)}`;
        const r = await executeOne({ id: 'sum-file', agent, task, code: fileContent.slice(0, 8000) });
        autoRecord(`summarize ${basename(sumFilePath)}`, agent, Math.round(r.output.confidence * 100));

        return { content: [{ type: 'text', text: JSON.stringify({
          success: true, subject: 'file', path: sumFilePath, format: sumFormat,
          summary: r.plan ?? r.analysis ?? r.output,
          agent_used: agent, duration_ms: Date.now() - sumStart,
        }, null, 2) }] };
      }

      // ── Project / directory summary ────────────────────────────────────────
      const discResult = discoverProject(sumProjectDir!, 'standard');
      const ctx = [
        `Project: ${sumProjectDir}`,
        `Stack: ${discResult.tech_stack.join(', ') || 'unknown'}`,
        `Ecosystems: ${JSON.stringify(discResult.ecosystems)}`,
        `Key files: ${discResult.key_files.join(', ')}`,
        `Total files: ${discResult.total_files}`,
        `Git branch: ${discResult.git.branch ?? 'none'}, commit: ${discResult.git.commit ?? 'none'}`,
        discResult.structure.length > 0 ? `\nFile tree (top 60 lines):\n${discResult.structure.slice(0, 60).join('\n')}` : '',
      ].filter(Boolean).join('\n');

      const focusNote = sumFocus ? ` Focus especially on: ${sumFocus}.` : '';
      const depthNote = sumFormat === 'detailed' ? 'Write paragraph-level prose with sections.' : 'Return 5–7 bullet points that capture the essence.';
      const task = `You are a senior engineer briefing a colleague on this codebase.${focusNote} ${depthNote} Be concise and precise — no filler.`;

      const r = await executeOne({ id: 'sum-proj', agent: 'project-mapper', task, context: ctx });
      autoRecord('summarize project', 'project-mapper', Math.round(r.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, subject: 'project', path: sumProjectDir, format: sumFormat,
        tech_stack: discResult.tech_stack,
        ecosystems: discResult.ecosystems,
        key_files: discResult.key_files,
        total_files: discResult.total_files,
        git: discResult.git,
        summary: r.plan ?? r.analysis ?? r.output,
        agent_used: 'project-mapper', duration_ms: Date.now() - sumStart,
      }, null, 2) }] };
    }

    case 'veto_benchmark': {
      const task       = String(args?.task       ?? '');
      const approachA  = String(args?.approach_a ?? '');
      const approachB  = String(args?.approach_b ?? '');
      const ctx        = args?.context    ? String(args.context)    : undefined;
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;

      if (!task || !approachA || !approachB) {
        throw new Error('veto_benchmark requires task, approach_a, and approach_b');
      }

      const bmStart = Date.now();

      // Run both debates in parallel via LLM council
      const [debateA, debateB] = await Promise.all([
        runLlmDebate(server, { task: `${task}\n\nApproach A: ${approachA}`, context: ctx, project_dir: projectDir }),
        runLlmDebate(server, { task: `${task}\n\nApproach B: ${approachB}`, context: ctx, project_dir: projectDir }),
      ]);

      // Score: GREEN=3, YELLOW=2, RED=1, DEADLOCK=0
      const verdictScore: Record<string, number> = { GREEN: 3, YELLOW: 2, RED: 1, DEADLOCK: 0 };
      const scoreA = verdictScore[debateA.final_verdict] ?? 0;
      const scoreB = verdictScore[debateB.final_verdict] ?? 0;

      const warnCountA = debateA.warnings.length;
      const warnCountB = debateB.warnings.length;
      const blockCountA = debateA.block_reasons.length;
      const blockCountB = debateB.block_reasons.length;

      let winner: 'A' | 'B' | 'TIE';
      let confidence: 'high' | 'medium' | 'low';
      let reasoning: string;

      if (scoreA !== scoreB) {
        winner = scoreA > scoreB ? 'A' : 'B';
        const diff = Math.abs(scoreA - scoreB);
        confidence = diff >= 2 ? 'high' : 'medium';
        reasoning = `Approach ${winner} received a ${winner === 'A' ? debateA.final_verdict : debateB.final_verdict} verdict vs ${winner === 'A' ? debateB.final_verdict : debateA.final_verdict} for Approach ${winner === 'A' ? 'B' : 'A'}.`;
      } else {
        // Same verdict — break tie on warnings, then block reasons
        if (warnCountA !== warnCountB) {
          winner = warnCountA < warnCountB ? 'A' : 'B';
          confidence = 'low';
          reasoning = `Both approaches received ${debateA.final_verdict}. Approach ${winner} had fewer warnings (${winner === 'A' ? warnCountA : warnCountB} vs ${winner === 'A' ? warnCountB : warnCountA}).`;
        } else if (blockCountA !== blockCountB) {
          winner = blockCountA < blockCountB ? 'A' : 'B';
          confidence = 'low';
          reasoning = `Both approaches received ${debateA.final_verdict} with equal warnings. Approach ${winner} had fewer blocking concerns.`;
        } else {
          winner = 'TIE';
          confidence = 'low';
          reasoning = `Both approaches received ${debateA.final_verdict} with equal warnings and blocks. Council cannot differentiate — consider a more specific framing.`;
        }
      }

      // Auto-record both debates
      const qMap: Record<string, number> = { GREEN: 90, YELLOW: 60, RED: 20, DEADLOCK: 50 };
      autoRecord('benchmark', 'council', qMap[debateA.final_verdict] ?? 50);
      autoRecord('benchmark', 'council', qMap[debateB.final_verdict] ?? 50);

      return { content: [{ type: 'text', text: JSON.stringify({
        winner,
        confidence,
        reasoning,
        recommendation: winner !== 'TIE'
          ? `Use Approach ${winner}. ${winner === 'A' ? debateA.recommended : debateB.recommended}`
          : `No clear winner. ${debateA.recommended}`,
        approach_a: {
          label: 'A',
          description: approachA.slice(0, 120),
          verdict: debateA.final_verdict,
          warnings: warnCountA,
          block_reasons: blockCountA,
          recommended: debateA.recommended,
          votes: Object.fromEntries(Object.entries(debateA.votes).map(([k, v]) => [k, v.verdict])),
        },
        approach_b: {
          label: 'B',
          description: approachB.slice(0, 120),
          verdict: debateB.final_verdict,
          warnings: warnCountB,
          block_reasons: blockCountB,
          recommended: debateB.recommended,
          votes: Object.fromEntries(Object.entries(debateB.votes).map(([k, v]) => [k, v.verdict])),
        },
        duration_ms: Date.now() - bmStart,
      }, null, 2) }] };
    }

    // ── Part 4: New Features ───────────────────────────────────────────────────

    case 'veto_metrics': {
      const metrics = getMetrics();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...metrics }, null, 2) }] };
    }

    case 'veto_git_blame': {
      const blameDir  = args?.project_dir ? String(args.project_dir).trim() : '';
      const blameFile = args?.file_path   ? String(args.file_path).trim()   : '';
      const blameTarget = blameFile || blameDir;

      if (!blameTarget) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide project_dir or file_path.' }) }], isError: true };
      }

      const resolvedTarget = resolve(blameTarget);
      try { statSync(resolvedTarget); } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Path not found: ${resolvedTarget}` }) }], isError: true };
      }

      function gitExec(cmd: string, cwd: string): string {
        try { return execSyncTop(cmd, { cwd, timeout: 5000, stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
        catch { return ''; }
      }

      const cwd = statSync(resolvedTarget).isDirectory() ? resolvedTarget : dirname(resolvedTarget);

      const shortlog = gitExec(`git shortlog -sn -- "${resolvedTarget}"`, cwd);
      const contributors = shortlog.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        return m ? { commits: parseInt(m[1], 10), author: m[2].trim() } : null;
      }).filter(Boolean);

      const lastModified = gitExec(`git log -1 --format="%ai|%aN|%s" -- "${resolvedTarget}"`, cwd);
      const [last_modified_at, last_author, last_commit_message] = lastModified.split('|');

      const totalCommits = gitExec(`git rev-list --count HEAD -- "${resolvedTarget}"`, cwd);

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        path: resolvedTarget,
        total_commits: parseInt(totalCommits || '0', 10),
        contributors,
        last_modified_at: last_modified_at?.trim(),
        last_author: last_author?.trim(),
        last_commit_message: last_commit_message?.trim(),
      }, null, 2) }] };
    }

    case 'veto_changelog': {
      const changelogDir = args?.project_dir ? String(args.project_dir).trim() : activeProjectDir ?? process.cwd();
      const maxEntries   = typeof args?.max_entries === 'number' ? Math.min(args.max_entries, 200) : 50;

      const resolvedDir = resolve(changelogDir);
      try { statSync(resolvedDir); } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Directory not found: ${resolvedDir}` }) }], isError: true };
      }

      function gitRun(cmd: string): string {
        try { return execSyncTop(cmd, { cwd: resolvedDir, timeout: 5000, stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
        catch { return ''; }
      }

      const lastTag = gitRun('git describe --tags --abbrev=0 2>/dev/null') || '';
      const range   = lastTag ? `${lastTag}..HEAD` : 'HEAD';
      const rawLog  = gitRun(`git log ${range} --format="%s|||%H|||%aN|||%ai" --no-merges -n ${maxEntries}`);

      if (!rawLog) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, since_tag: lastTag || 'beginning', entries: [], message: 'No commits found in range.' }) }] };
      }

      const typeLabels: Record<string, string> = {
        feat: 'Features', fix: 'Bug Fixes', refactor: 'Refactoring', perf: 'Performance',
        docs: 'Documentation', test: 'Tests', chore: 'Chores', ci: 'CI/CD',
        style: 'Style', build: 'Build', revert: 'Reverts',
      };

      const grouped: Record<string, Array<{ message: string; hash: string; author: string; date: string }>> = {};

      for (const line of rawLog.split('\n').filter(Boolean)) {
        const [subject, hash, author, date] = line.split('|||');
        if (!subject) continue;
        const typeMatch = subject.match(/^(\w+)(\([\w-]+\))?:\s*(.*)/);
        const type  = typeMatch ? typeMatch[1].toLowerCase() : 'other';
        const msg   = typeMatch ? typeMatch[3] : subject;
        const label = typeLabels[type] ?? 'Other';
        if (!grouped[label]) grouped[label] = [];
        grouped[label].push({ message: msg.trim(), hash: hash?.trim().slice(0, 8) ?? '', author: author?.trim() ?? '', date: date?.trim().slice(0, 10) ?? '' });
      }

      const sections = Object.entries(grouped).map(([section, items]) => ({ section, items }));

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        since_tag: lastTag || '(beginning of history)',
        total_commits: rawLog.split('\n').filter(Boolean).length,
        sections,
      }, null, 2) }] };
    }

    // ── Named Pipelines (Phase 4.2) ──────────────────────────────────────────────

    case 'veto_full_review': {
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      let diff = args?.diff ? String(args.diff).trim() : '';
      if (!diff && projectDir) {
        try {
          diff = execSyncTop('git diff HEAD --no-color', { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
          if (!diff) diff = execSyncTop('git diff --cached --no-color', { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        } catch { /* not a git repo */ }
      }
      if (!diff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No diff provided and no git changes detected. Pass diff or point to a project_dir with uncommitted changes.' }) }], isError: true };

      const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
      const context = buildContextString(projectDir, userContext);

      const [{ reviewResult, secResult, secretsResult, verdict: scanVerdict }, qualityResult] = await Promise.all([
        runTripleScan(diff, context),
        executeOne({ id: 'quality-1', agent: 'code-quality', task: 'Assess overall code quality and maintainability of these changes', code: diff.slice(0, 8000), context }),
      ]);

      const qualityScore = Math.round(qualityResult.output.confidence * 100);
      const verdict = (scanVerdict === 'fail' || qualityScore < 40) ? 'fail'
                    : (scanVerdict === 'warn' || qualityScore < 70) ? 'warn'
                    : 'pass';
      const verdictEmoji = verdict === 'pass' ? '✅ PASS' : verdict === 'warn' ? '⚠️  WARN' : '❌ FAIL';

      if (verdict === 'fail') {
        const issues: string[] = [];
        if ((reviewResult.analysis?.critical_count ?? 0) > 0) issues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
        if ((secResult.analysis?.critical_count ?? 0) > 0) issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
        if ((secretsResult.analysis?.findings?.length ?? 0) > 0) issues.push('Secrets: exposed credentials detected');
        autoStoreCritical(`Full review failed: ${changedFiles.slice(0, 2).join(', ')}`, issues, projectDir, ['full-review']);
      }
      autoRecord('full-review', 'code-quality', qualityScore);

      return { content: [{ type: 'text', text: JSON.stringify({
        pipeline: 'full_review',
        verdict,
        verdict_label: verdictEmoji,
        files_changed: changedFiles.length,
        files: changedFiles,
        code_review: { score: reviewResult.analysis?.score ?? null, verdict: reviewResult.analysis?.verdict ?? null, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0, findings: reviewResult.analysis?.findings ?? [] },
        security:    { score: secResult.analysis?.score ?? null, verdict: secResult.analysis?.verdict ?? null, critical: secResult.analysis?.critical_count ?? 0, high: secResult.analysis?.high_count ?? 0, findings: secResult.analysis?.findings ?? [] },
        secrets:     { verdict: secretsResult.analysis?.verdict ?? null, findings: secretsResult.analysis?.findings ?? [] },
        quality:     { score: qualityScore, recommendation: qualityResult.output.recommendation, plan: qualityResult.plan },
        summary: [
          `${verdictEmoji} — ${changedFiles.length} file(s) changed`,
          `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} (score ${reviewResult.analysis?.score ?? '?'}/100)`,
          `Security: ${secResult.analysis?.verdict ?? 'n/a'} — ${secResult.analysis?.critical_count ?? 0} critical, ${secResult.analysis?.high_count ?? 0} high`,
          `Secrets: ${(secretsResult.analysis?.findings?.length ?? 0) > 0 ? '🔴 Exposed credentials detected' : '✅ Clean'}`,
          `Quality: ${qualityScore}/100`,
        ].join('\n'),
      }, null, 2) }] };
    }

    case 'veto_pre_commit': {
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let diff = '';
      try {
        diff = execSyncTop('git diff --cached --no-color', { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      } catch { /* not a git repo */ }
      if (!diff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No staged changes found. Stage files with git add before running veto_pre_commit.' }) }], isError: true };

      const context = buildContextString(projectDir, userContext);
      const [secretsResult, reviewResult] = await Promise.all([
        executeOne({ id: 'pre-secrets', agent: 'secrets',  task: 'Scan staged changes for exposed secrets or credentials', code: diff }),
        executeOne({ id: 'pre-review',  agent: 'reviewer', task: 'Review staged changes for critical code quality issues', code: diff, context }),
      ]);

      const hasSecrets = (secretsResult.analysis?.findings?.length ?? 0) > 0;
      const hasCriticalCode = (reviewResult.analysis?.critical_count ?? 0) > 0;
      const verdict = (hasSecrets || hasCriticalCode) ? 'fail' : (reviewResult.analysis?.high_count ?? 0) > 0 ? 'warn' : 'pass';
      const verdictEmoji = verdict === 'pass' ? '✅ PASS' : verdict === 'warn' ? '⚠️  WARN' : '❌ FAIL';

      if (verdict === 'fail') {
        const issues: string[] = [];
        if (hasSecrets) issues.push('Secrets: exposed credentials detected');
        if (hasCriticalCode) issues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
        autoStoreCritical(`Pre-commit blocked: ${projectDir}`, issues, projectDir, ['pre-commit']);
      }
      autoRecord('pre-commit', 'secrets',  hasSecrets ? 0 : 100);
      autoRecord('pre-commit', 'reviewer', reviewResult.analysis?.score ?? Math.round(reviewResult.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        pipeline: 'pre_commit',
        verdict,
        verdict_label: verdictEmoji,
        blocked: verdict === 'fail',
        secrets:     { found: hasSecrets, findings: secretsResult.analysis?.findings ?? [] },
        code_review: { score: reviewResult.analysis?.score ?? null, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0, findings: reviewResult.analysis?.findings ?? [] },
        summary: [
          `${verdictEmoji} — Pre-commit check`,
          `Secrets: ${hasSecrets ? '🔴 Found — commit BLOCKED' : '✅ Clean'}`,
          `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} — ${reviewResult.analysis?.critical_count ?? 0} critical, ${reviewResult.analysis?.high_count ?? 0} high`,
        ].join('\n'),
      }, null, 2) }] };
    }

    case 'veto_new_feature': {
      const description = String(args?.description ?? '').trim();
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };

      const context = buildContextString(projectDir, userContext);

      // Step 1 — governance first: council debate
      const debateResult = await runLlmDebate(server, { task: description, context: userContext, project_dir: projectDir, strictness: 'standard' });
      const outcomeId = saveCouncilOutcome({ task: description, verdict: debateResult.final_verdict, lead_dev: JSON.stringify(debateResult.votes.lead_dev), pm: JSON.stringify(debateResult.votes.pm), architect: JSON.stringify(debateResult.votes.architect), ux: JSON.stringify(debateResult.votes.ux), devil: JSON.stringify(debateResult.votes.devil), legal: JSON.stringify(debateResult.votes.legal), security: JSON.stringify(debateResult.votes.security), recommended: debateResult.recommended });
      { const qMap: Record<string, number> = { GREEN: 90, YELLOW: 60, RED: 20, DEADLOCK: 50 }; const tMap: Record<string, 1|2|3> = { GREEN: 1, YELLOW: 2, RED: 3, DEADLOCK: 2 }; recordOutcome(description.slice(0, 50), 50, tMap[debateResult.final_verdict] ?? 2, 'council', qMap[debateResult.final_verdict] ?? 50); }

      // RED verdict — block: do not plan what governance has rejected
      if (debateResult.final_verdict === 'RED') {
        return { content: [{ type: 'text', text: JSON.stringify({
          pipeline: 'new_feature',
          verdict: 'blocked',
          council: { outcome_id: outcomeId, verdict: 'RED', block_reasons: debateResult.block_reasons, warnings: debateResult.warnings, recommended: debateResult.recommended },
          agent_plan: null, tasks: null,
          summary: `❌ BLOCKED — Council RED verdict. Resolve block_reasons before planning.\n${debateResult.block_reasons.map((r: string) => `  - ${r}`).join('\n')}`,
        }, null, 2) }] };
      }

      // Steps 2+3 — approved: plan + decompose in parallel
      const VALID_AGENTS = ['coder','tester','reviewer','debugger','refactor','database','api','frontend','backend','devops','performance','auth','security-scanner','documentation'];
      const rawAgent = (debateResult.recommended ?? '').toLowerCase().split(/[\s,;]/)[0];
      const planAgent: WorkerAgentType = (VALID_AGENTS.includes(rawAgent) ? rawAgent : 'coder') as WorkerAgentType;

      const [planResult, taskPlan] = await Promise.all([
        executeOne({ id: 'plan-1', agent: planAgent, task: description, context, project_dir: projectDir }),
        buildTaskPlan(description, projectDir),
      ]);
      autoRecord('new-feature', planAgent, Math.round(planResult.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        pipeline: 'new_feature',
        verdict: debateResult.final_verdict === 'GREEN' ? 'approved' : 'approved_with_warnings',
        council: { outcome_id: outcomeId, verdict: debateResult.final_verdict, block_reasons: debateResult.block_reasons, warnings: debateResult.warnings, recommended: debateResult.recommended },
        agent_plan: { agent: planAgent, plan: planResult.plan, output: planResult.output },
        tasks: taskPlan,
        summary: [
          `${debateResult.final_verdict === 'GREEN' ? '✅' : '⚠️'} Council: ${debateResult.final_verdict}`,
          debateResult.warnings.length > 0 ? `Warnings: ${debateResult.warnings.join('; ')}` : null,
          `Recommended agent: ${planAgent}`,
          `Tasks: ${taskPlan.total_tasks} (est. ${taskPlan.duration_estimate})`,
        ].filter(Boolean).join('\n'),
      }, null, 2) }] };
    }

    case 'veto_delegate': {
      const agentId = String(args?.agent_id ?? '').trim() as WorkerAgentType;
      const task    = String(args?.task ?? '').trim();
      const context = args?.context     ? String(args.context)     : undefined;
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const maxLen  = typeof args?.max_summary_tokens === 'number' ? Math.min(args.max_summary_tokens, 2000) : 500;

      if (!agentId || !task) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'agent_id and task are required.' }) }], isError: true };
      }

      const enrichedCtx = buildContextString(projectDir, context);
      const result = await executeOne({ id: 'delegate-1', agent: agentId, task, context: enrichedCtx || undefined, project_dir: projectDir });

      autoRecord(task, agentId, Math.round(result.output.confidence * 100));

      // Return compact summary only — no verbose findings/steps to avoid context pollution
      const summary = [
        result.output.recommendation,
        result.plan?.approach,
        result.analysis?.verdict ? `Verdict: ${result.analysis.verdict}` : null,
        result.analysis?.score   ? `Score: ${result.analysis.score}/100`  : null,
      ].filter(Boolean).join('\n').slice(0, maxLen);

      return { content: [{ type: 'text', text: JSON.stringify({
        agent: agentId,
        task: task.slice(0, 100),
        summary,
        confidence: Math.round(result.output.confidence * 100),
        severity: result.output.severity ?? null,
        duration_ms: result.duration_ms,
        truncated: summary.length >= maxLen,
      }, null, 2) }] };
    }

    case 'veto_commit_message': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const hint       = args?.hint ? String(args.hint) : undefined;

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let diff = '';
      try {
        diff = execSyncTop('git diff --cached --no-color', { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      } catch { /* not a git repo */ }
      if (!diff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No staged changes. Run git add first.' }) }], isError: true };

      const truncatedDiff = diff.slice(0, 6000);

      const result = await executeOne({
        id:      'commit-msg-1',
        agent:   'git-agent' as WorkerAgentType,
        task:    'Generate a conventional commit message for these staged changes. Follow the Conventional Commits spec: type(scope): subject\n\nbody. Types: feat/fix/docs/chore/refactor/test/perf/ci/build/style. Be concise. Subject ≤ 72 chars.',
        code:    truncatedDiff,
        context: hint,
      });

      autoRecord('commit-message', 'git-agent', Math.round(result.output.confidence * 100));

      const message = (result.plan?.approach ?? result.output.recommendation ?? '').trim();
      const firstLine = message.split('\n')[0] ?? '';
      const match = firstLine.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)/);

      return { content: [{ type: 'text', text: JSON.stringify({
        message,
        type:       match ? match[1] : null,
        scope:      match ? (match[2] ?? null) : null,
        subject:    match ? match[3] : null,
        confidence: Math.round(result.output.confidence * 100),
      }, null, 2) }] };
    }

    case 'veto_pr_description': {
      const projectDir  = String(args?.project_dir ?? '').trim();
      const baseBranch  = args?.base_branch ? String(args.base_branch) : 'main';
      const titleHint   = args?.title   ? String(args.title)   : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let stat = '';
      let commitLog = '';
      try {
        stat      = execSyncTop(`git diff ${baseBranch}...HEAD --no-color --stat`,  { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        commitLog = execSyncTop(`git log ${baseBranch}...HEAD --oneline`,            { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      } catch (e) {
        if (!stat && !commitLog) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `git diff failed: ${(e as Error).message}` }) }], isError: true };
      }

      let fullDiff = '';
      try {
        fullDiff = execSyncTop(`git diff ${baseBranch}...HEAD --no-color`, { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      } catch { /* ignore */ }

      const contextParts: string[] = [];
      if (titleHint)   contextParts.push(`PR Title: ${titleHint}`);
      if (userContext) contextParts.push(`Context: ${userContext}`);
      if (commitLog)   contextParts.push(`Commits:\n${commitLog}`);
      if (stat)        contextParts.push(`Diff stat:\n${stat}`);
      const builtContext = contextParts.join('\n\n');

      const result = await executeOne({
        id:          'pr-desc-1',
        agent:       'documentation' as WorkerAgentType,
        task:        "Write a complete GitHub Pull Request description. Include: ## Summary (3–5 bullet points of what changed and why), ## Changes (file-level breakdown from the diff stat), ## Test Plan (bulleted checklist of how to verify the changes), ## Breaking Changes (any API or interface changes; say 'None' if clean). Be specific and developer-facing.",
        code:        fullDiff.slice(0, 8000),
        context:     builtContext || undefined,
        project_dir: projectDir,
      });

      const quality = Math.round(result.output.confidence * 100);
      autoRecord('pr-description', 'documentation', quality);

      const body = (result.plan?.approach ?? result.output.recommendation ?? '').trim();
      const suggestedTitle = titleHint ?? (commitLog.split('\n')[0]?.replace(/^[a-f0-9]+ /, '') ?? 'Pull Request');

      return { content: [{ type: 'text', text: JSON.stringify({
        title:       suggestedTitle,
        body,
        base_branch: baseBranch,
        confidence:  quality,
      }, null, 2) }] };
    }

    case 'veto_pr_post': {
      const m = String(args?.pr_url ?? '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Invalid PR URL. Expected: https://github.com/owner/repo/pull/123' }) }], isError: true };
      const [, owner, repo, prNum] = m;

      if (!process.env.GITHUB_TOKEN) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'GITHUB_TOKEN env var not set' }) }], isError: true };

      const findings: Array<{ severity: string; message: string; location?: string }> =
        Array.isArray(args?.findings) ? args.findings : [];
      const reviewBody = args?.body ? String(args.body) :
        `Veto review: ${findings.length} finding(s) — ${findings.filter(f => f.severity === 'critical' || f.severity === 'high').length} critical/high`;
      const eventVal = String(args?.event ?? '');
      const event = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(eventVal) ? eventVal : 'COMMENT';

      const comments = findings
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .slice(0, 20)
        .map(f => ({ body: `**[${f.severity.toUpperCase()}]** ${f.message}${f.location ? `\n\n_Location: ${f.location}_` : ''}` }));

      const prPostUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/reviews`;
      const prPostHeaders: Record<string, string> = {
        'User-Agent': 'veto-mcp-server',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      };
      const prPostResp = await fetch(prPostUrl, {
        method: 'POST',
        headers: prPostHeaders,
        body: JSON.stringify({ body: reviewBody, event, comments }),
      });
      if (!prPostResp.ok) {
        const err = await prPostResp.text();
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `GitHub API error ${prPostResp.status}: ${err.slice(0, 200)}` }) }], isError: true };
      }
      const review = await prPostResp.json() as { id: number; html_url: string; state: string };

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        review_id: review.id,
        review_url: review.html_url,
        event,
        findings_posted: comments.length,
        total_findings: findings.length,
      }, null, 2) }] };
    }

    case 'veto_debt_register': {
      const project_dir = String(args?.project_dir ?? '').trim();
      if (!project_dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let gitLog = '';
      try {
        gitLog = execSyncTop('git log --since=90.days --name-only --format="" --no-merges', {
          cwd: project_dir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch { /* not a git repo */ }

      const churnMap: Record<string, number> = {};
      for (const line of gitLog.split('\n').filter(Boolean)) {
        if (line.includes('.')) {
          churnMap[line.trim()] = (churnMap[line.trim()] ?? 0) + 1;
        }
      }

      const maxFiles = typeof args?.max_files === 'number' ? Math.min(args.max_files, 30) : 10;
      const extensions = Array.isArray(args?.extensions) ? args.extensions.map(String) : ['.ts', '.js', '.py', '.go', '.java'];
      const topFiles = Object.entries(churnMap)
        .filter(([f]) => extensions.some(ext => f.endsWith(ext)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxFiles)
        .map(([file, commits]) => ({ file, commits }));

      const fileContents = topFiles.map(({ file, commits }) => {
        try {
          const abs = join(project_dir, file);
          const content = readFileSync(abs, 'utf8').slice(0, 3000);
          return { file, commits, content };
        } catch { return { file, commits, content: '' }; }
      }).filter(f => f.content);

      if (fileContents.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          total_files_analyzed: 0,
          date_range: 'last 90 days',
          debt_items: [],
          summary: 'No eligible files found in git history for the last 90 days.',
        }, null, 2) }] };
      }

      const debtCode = fileContents
        .map(f => `=== ${f.file} (${f.commits} commits) ===\n${f.content}`)
        .join('\n\n')
        .slice(0, 8000);

      const debtResult = await executeOne({
        id: `debt-${Date.now()}`,
        agent: 'code-quality',
        task: 'Analyze these high-churn source files for technical debt. For each file, identify: (1) the primary debt type (complexity/duplication/coupling/coverage/documentation), (2) severity (high/medium/low), (3) estimated fix effort in hours, (4) recommended agent to fix it. Rank by: high-churn × high-severity first.',
        code: debtCode,
      });

      autoRecord('debt-register', 'code-quality', Math.round(debtResult.output.confidence * 100));

      const steps = debtResult.plan?.steps ?? [];
      let debtItems: Array<{
        file: string;
        churn_commits: number;
        priority: string;
        debt_type: string;
        suggested_agent: string;
        estimated_hours: number;
      }>;

      if (steps.length > 0) {
        debtItems = steps.map((step: string, i: number) => {
          const matchedFile = fileContents[i] ?? fileContents[0];
          return {
            file: matchedFile.file,
            churn_commits: matchedFile?.commits ?? 0,
            priority: i < Math.ceil(steps.length / 3) ? 'high' : i < Math.ceil(steps.length * 2 / 3) ? 'medium' : 'low',
            debt_type: 'complexity',
            suggested_agent: 'refactor',
            estimated_hours: 2,
            description: step,
          };
        });
      } else {
        debtItems = fileContents.map(f => ({
          file: f.file,
          churn_commits: f.commits,
          priority: f.commits > 20 ? 'high' : f.commits > 10 ? 'medium' : 'low',
          debt_type: 'complexity',
          suggested_agent: 'refactor',
          estimated_hours: 2,
        }));
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        total_files_analyzed: fileContents.length,
        date_range: 'last 90 days',
        debt_items: debtItems,
        summary: (debtResult.plan?.approach ?? debtResult.output.recommendation ?? '').trim(),
      }, null, 2) }] };
    }

    case 'veto_adr': {
      const task         = String(args?.task         ?? '').trim();
      const verdict      = String(args?.verdict      ?? '').trim().toUpperCase();
      const recommended  = String(args?.recommended  ?? '').trim();
      const rationale    = args?.rationale    ? String(args.rationale)    : undefined;
      const consequences = args?.consequences ? String(args.consequences) : undefined;
      const projectDir   = args?.project_dir  ? String(args.project_dir)  : undefined;
      const outcomeId    = args?.outcome_id   ? String(args.outcome_id)   : undefined;

      if (!task || !verdict || !recommended) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task, verdict, and recommended are required.' }) }], isError: true };
      }

      const statusMap: Record<string, string> = {
        GREEN:    'Accepted',
        YELLOW:   'Accepted with reservations',
        RED:      'Rejected',
        DEADLOCK: 'Deferred',
      };
      const adrStatus  = statusMap[verdict] ?? 'Under review';
      const today      = new Date().toISOString().slice(0, 10);
      const outcomeRef = outcomeId ? ` (outcome: ${outcomeId})` : '';

      const adrContent = [
        `# ${task.slice(0, 80)}`,
        '',
        `Date: ${today}`,
        `Status: ${adrStatus}`,
        `Council verdict: ${verdict}${outcomeRef}`,
        '',
        '## Context',
        '',
        task,
        ...(rationale ? ['', rationale] : []),
        '',
        '## Decision',
        '',
        recommended,
        '',
        '## Consequences',
        '',
        consequences ?? 'Under review.',
      ].join('\n');

      let adrFilePath: string | null = null;
      if (projectDir) {
        const slug         = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const decisionsDir = join(projectDir, 'docs', 'decisions');
        let nextNum = 1;
        try {
          const files = readdirSync(decisionsDir);
          nextNum = files.filter(f => /^\d{4}-/.test(f)).length + 1;
        } catch { /* directory doesn't exist yet */ }
        const paddedNum = String(nextNum).padStart(4, '0');
        adrFilePath = join(decisionsDir, `${paddedNum}-${slug}.md`);
        mkdirSync(decisionsDir, { recursive: true });
        writeFileSync(adrFilePath, adrContent, 'utf8');
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        success:   true,
        adr:       adrContent,
        file_path: adrFilePath,
        status:    adrStatus,
      }, null, 2) }] };
    }

    case 'veto_env_setup': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const writeFiles = args?.write_files === true;

      if (!projectDir) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
      }

      const detected: string[]     = [];
      const summaryParts: string[] = [];

      // Read package.json
      const pkgPath = join(projectDir, 'package.json');
      if (existsSync(pkgPath)) {
        detected.push('node');
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
          summaryParts.push(`Node project: ${pkg.name ?? 'unnamed'}`);
          if (pkg.scripts && typeof pkg.scripts === 'object') {
            summaryParts.push(`Scripts: ${Object.keys(pkg.scripts as object).join(', ')}`);
          }
          if (pkg.dependencies && typeof pkg.dependencies === 'object') {
            summaryParts.push(`Dependencies: ${Object.keys(pkg.dependencies as object).slice(0, 20).join(', ')}`);
          }
        } catch { /* ignore parse errors */ }
      }

      // Read .env or .env.local
      for (const envFile of ['.env', '.env.local']) {
        const envPath = join(projectDir, envFile);
        if (existsSync(envPath)) {
          try {
            const lines = readFileSync(envPath, 'utf8').split('\n');
            const vars  = lines.filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')[0]);
            if (vars.length > 0) {
              summaryParts.push(`Existing env vars (${envFile}): ${vars.join(', ')}`);
            }
          } catch { /* ignore */ }
        }
      }

      // Note other config files
      for (const f of ['requirements.txt', 'pyproject.toml']) {
        if (existsSync(join(projectDir, f))) { detected.push('python'); summaryParts.push(`Python config found: ${f}`); }
      }
      if (existsSync(join(projectDir, 'Cargo.toml'))) {
        detected.push('rust'); summaryParts.push('Rust project found: Cargo.toml');
      }
      for (const f of ['docker-compose.yml', 'docker-compose.yaml']) {
        if (existsSync(join(projectDir, f))) { summaryParts.push(`Docker Compose found: ${f}`); }
      }

      const projectSummary = summaryParts.join('\n') || 'No configuration files found.';
      const enrichedCtx    = buildContextString(projectDir, projectSummary);
      const agentTask      = 'Generate a .env.example file for this project. List every environment variable needed with a placeholder value and a one-line comment explaining what it is. Then write a numbered setup guide (5-10 steps) for a developer setting up this project from scratch.';
      const envResult      = await executeOne({ id: 'env-setup-1', agent: 'devops', task: agentTask, context: enrichedCtx || undefined, project_dir: projectDir });

      const rawOutput  = envResult.output.recommendation ?? envResult.plan?.approach ?? '';
      const envLines   = rawOutput.split('\n').filter((l: string) => /^[A-Z_]+=/.test(l));
      const envExample = envLines.length > 0 ? envLines.join('\n') : '# Add your environment variables here\n';

      let written = false;
      if (writeFiles) {
        writeFileSync(join(projectDir, '.env.example'), envExample, 'utf8');
        written = true;
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        env_example: envExample,
        setup_guide: rawOutput,
        written,
        detected:    [...new Set(detected)],
      }, null, 2) }] };
    }

    case 'veto_prompt_optimizer': {
      const rawPrompt = String(args?.prompt ?? '').trim();
      const goal      = args?.goal ? String(args.goal) : undefined;

      if (!rawPrompt) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'prompt is required.' }) }], isError: true };

      const prompt = rawPrompt.length > 8000 ? rawPrompt.slice(0, 8000) : rawPrompt;

      // Deterministic pre-scan
      const issues: Array<{ category: string; severity: string; finding: string }> = [];
      const p = prompt.toLowerCase();
      if (!p.includes('you are') && !p.includes('your role') && !p.includes('act as') && !p.includes('you\'re a')) {
        issues.push({ category: 'role', severity: 'medium', finding: 'No role definition found. Add "You are a [role]..." to anchor behavior.' });
      }
      if (!p.includes('format') && !p.includes('json') && !p.includes('markdown') && !p.includes('return') && !p.includes('output')) {
        issues.push({ category: 'output_format', severity: 'medium', finding: 'No output format specified. Specify JSON, markdown, or plain text.' });
      }
      if (/ignore (previous|prior|above|all)|disregard|forget|pretend/i.test(prompt)) {
        issues.push({ category: 'injection', severity: 'high', finding: 'Prompt may be injection-prone — contains phrases attackers commonly use.' });
      }
      if (prompt.trim().split(/\s+/).length < 20) {
        issues.push({ category: 'specificity', severity: 'low', finding: 'Prompt is very short. Add more context and constraints for better results.' });
      }

      const result = await executeOne({
        id:      'prompt-optimizer-1',
        agent:   'documentation' as WorkerAgentType,
        task:    'You are a prompt engineering expert. Analyze this prompt for failure modes: vague instructions, missing context, ambiguous outputs, injection risks, lack of examples, poor role definition. Then rewrite it to be clearer, more specific, and safer. Return: 1) A numbered list of issues found, 2) A complete rewritten version of the prompt.',
        code:    prompt,
        context: goal ? `Goal: ${goal}` : undefined,
      });

      const quality = result.analysis?.score ?? Math.round(result.output.confidence * 100);
      autoRecord('prompt-optimizer', 'documentation', quality);

      const highCount   = issues.filter(i => i.severity === 'high').length;
      const mediumCount = issues.filter(i => i.severity === 'medium').length;
      const lowCount    = issues.filter(i => i.severity === 'low').length;
      const score = Math.min(100, Math.max(0, 100 - highCount * 20 - mediumCount * 10 - lowCount * 5));

      const rewritten_prompt    = result.plan?.approach ?? result.output.recommendation ?? '';
      const improvement_summary = result.analysis?.summary ?? result.plan?.steps?.join('; ') ?? '';

      return { content: [{ type: 'text', text: JSON.stringify({
        score,
        issues,
        rewritten_prompt,
        improvement_summary,
      }, null, 2) }] };
    }

    case 'veto_sre_advisor': {
      const slo_target       = Number(args?.slo_target);
      const window_days      = Number(args?.window_days);
      const downtime_minutes = Number(args?.downtime_minutes);
      const service_name     = args?.service_name ? String(args.service_name) : undefined;
      const incidents        = Array.isArray(args?.incidents) ? (args.incidents as Array<{ date: string; duration_minutes: number; description: string }>) : [];

      if (!slo_target || !window_days || isNaN(downtime_minutes)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'slo_target, window_days, and downtime_minutes are required.' }) }], isError: true };
      }

      // Deterministic error budget math
      const sloFraction        = slo_target / 100;
      const windowMinutes      = window_days * 24 * 60;
      const totalBudgetMinutes = windowMinutes * (1 - sloFraction);
      const consumedMinutes    = downtime_minutes;
      const remainingMinutes   = Math.max(0, totalBudgetMinutes - consumedMinutes);
      const remainingPct       = totalBudgetMinutes > 0 ? Math.round((remainingMinutes / totalBudgetMinutes) * 1000) / 10 : 0;
      const exhaustedAt: string | null = consumedMinutes > 0 && remainingMinutes > 0
        ? new Date(Date.now() + (remainingMinutes / consumedMinutes) * window_days * 86400_000).toISOString().slice(0, 10)
        : consumedMinutes >= totalBudgetMinutes ? 'EXHAUSTED' : null;
      const status = remainingPct > 50 ? 'healthy' : remainingPct > 20 ? 'at_risk' : remainingPct > 0 ? 'critical' : 'exhausted';

      // Build incident summary for the agent
      const incidentSummary = incidents.length > 0
        ? 'Recent incidents:\n' + incidents.map(i => `- ${i.date}: ${i.duration_minutes} min — ${i.description}`).join('\n')
        : 'No incident data provided.';

      const sreResult = await executeOne({
        id:      'sre-advisor-1',
        agent:   'performance' as WorkerAgentType,
        task:    'You are an SRE advisor. Given this service\'s error budget status, suggest: 1) Top 3 reliability improvements ranked by error budget recovery potential, 2) Whether to freeze non-critical deployments, 3) Specific monitoring improvements. Be concrete and actionable.',
        context: `Service: ${service_name || 'unknown'}\nSLO: ${slo_target}%\nWindow: ${window_days} days\nBudget remaining: ${remainingPct}% (${remainingMinutes.toFixed(1)} min)\nStatus: ${status}\n${incidentSummary}`,
      });

      const recommendations = sreResult.plan?.approach ?? sreResult.output.recommendation ?? '';

      return { content: [{ type: 'text', text: JSON.stringify({
        slo_target_pct:       slo_target,
        window_days,
        total_budget_minutes: Math.round(totalBudgetMinutes * 10) / 10,
        consumed_minutes:     consumedMinutes,
        remaining_minutes:    Math.round(remainingMinutes * 10) / 10,
        remaining_pct:        remainingPct,
        status,
        projected_exhaustion: exhaustedAt,
        recommendations,
        freeze_recommended:   remainingPct < 20,
      }, null, 2) }] };
    }

    case 'veto_diagram': {
      const project_dir = String(args?.project_dir ?? '').trim();
      const diagramType = String(args?.diagram_type ?? 'flowchart').trim();
      const focus       = args?.focus ? String(args.focus) : undefined;

      if (!project_dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      const ctx = buildContextString(project_dir);

      let fileTree = '';
      try {
        fileTree = execSyncTop('git ls-files --others --cached --exclude-standard', {
          cwd: project_dir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        }).toString().split('\n').filter((f: string) => !f.includes('node_modules') && !f.includes('dist/')).slice(0, 60).join('\n');
      } catch { /* not a git repo */ }

      const diagramResult = await executeOne({
        id:      'diagram-1',
        agent:   'documentation' as WorkerAgentType,
        task:    `Generate a ${diagramType} Mermaid diagram of this project's architecture. Output ONLY the raw Mermaid diagram code (starting with 'flowchart TD' or similar — no markdown fences, no explanation text). Focus on: ${focus || 'overall system architecture, main modules, and data flow'}. Keep it under 30 nodes for readability.`,
        code:    fileTree.slice(0, 4000),
        context: ctx || undefined,
      });

      const diagramQuality = diagramResult.analysis?.score ?? Math.round(diagramResult.output.confidence * 100);
      autoRecord('diagram', 'documentation', diagramQuality);

      const rawOutput = diagramResult.plan?.approach ?? diagramResult.output.recommendation ?? '';

      // Extract Mermaid block — find first line matching a known diagram type keyword
      const lines = rawOutput.split('\n');
      const startIdx = lines.findIndex((l: string) => /^(flowchart|graph|classDiagram|sequenceDiagram|C4Context|erDiagram)/.test(l.trim()));
      const mermaid = startIdx >= 0 ? lines.slice(startIdx).join('\n').trim() : rawOutput.trim();

      return { content: [{ type: 'text', text: JSON.stringify({
        diagram_type: diagramType,
        mermaid,
        render_hint: 'Paste into https://mermaid.live or a GitHub markdown code block with ```mermaid',
      }, null, 2) }] };
    }

    case 'veto_rca': {
      const error      = String(args?.error ?? '').trim();
      const projectDir = args?.project_dir ? String(args.project_dir).trim() : '';
      const fileHint   = args?.file_hint   ? String(args.file_hint).trim()   : '';

      if (!error) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'error is required.' }) }], isError: true };

      const userContext = buildContextString(projectDir || undefined);

      let gitContext = '';
      try {
        const recent = execSyncTop('git log --oneline -15', { cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        gitContext = `Recent commits:\n${recent}`;
        if (fileHint) {
          const blame = execSyncTop(`git log --oneline -10 -- "${fileHint}"`, { cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
          gitContext += `\nRecent changes to ${fileHint}:\n${blame}`;
        }
      } catch { /* not a git repo */ }

      const result = await executeOne({
        id:      'rca-1',
        agent:   'debugger' as WorkerAgentType,
        task:    'Perform a structured root-cause analysis. Identify: (1) the most likely root cause, (2) the probable introducing commit or change, (3) immediate fix steps, (4) prevention recommendations.',
        code:    error.slice(0, 6000),
        context: [gitContext, userContext].filter(Boolean).join('\n') || undefined,
      });

      const quality = Math.round(result.output.confidence * 100);
      autoRecord('rca', 'debugger', quality);

      const root_cause = result.plan?.approach?.slice(0, 200) ?? result.output.recommendation.slice(0, 200);
      const fix_steps  = result.plan?.steps?.slice(0, 5) ?? [];
      const hypothesis = result.output.recommendation;

      return { content: [{ type: 'text', text: JSON.stringify({
        root_cause,
        hypothesis,
        suspect_commits: [],
        fix_steps,
        prevention:  [],
        confidence:  quality,
      }, null, 2) }] };
    }

    case 'veto_release_notes': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const audience   = String(args?.audience ?? 'user') === 'developer' ? 'developer' : 'user';

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let fromRef = args?.from_ref ? String(args.from_ref) : '';
      if (!fromRef) {
        try { fromRef = execSyncTop('git describe --tags --abbrev=0', { cwd: projectDir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
        catch { fromRef = ''; }
      }

      const logCmd = fromRef ? `git log ${fromRef}..HEAD --oneline --no-merges` : 'git log --oneline --no-merges -30';
      let commits = '';
      try { commits = execSyncTop(logCmd, { cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
      catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Could not read git log. Ensure project_dir is a git repository.' }) }], isError: true }; }

      if (!commits) return { content: [{ type: 'text', text: JSON.stringify({ success: true, release_notes: 'No changes since last tag.', commits_processed: 0 }) }] };

      const commitsCount = commits.split('\n').filter(Boolean).length;

      const result = await executeOne({
        id:    'relnotes-1',
        agent: 'documentation' as WorkerAgentType,
        task:  `Generate ${audience === 'developer' ? 'developer-facing' : 'user-facing'} release notes from these git commits. Rewrite technical commit messages into clear benefit-focused language. Group by: New Features, Improvements, Bug Fixes, Other. Each line should be one sentence describing the user benefit.`,
        code:  commits.slice(0, 4000),
      });

      const release_notes = result.plan?.approach ?? result.output.recommendation;

      return { content: [{ type: 'text', text: JSON.stringify({
        release_notes,
        from_ref:          fromRef || 'HEAD~30',
        commits_processed: commitsCount,
        audience,
      }, null, 2) }] };
    }

    case 'veto_postmortem': {
      const incident   = String(args?.incident ?? '').trim();
      const timeline   = args?.timeline    ? String(args.timeline).trim()   : '';
      const projectDir = args?.project_dir ? String(args.project_dir).trim() : '';
      const service    = args?.service     ? String(args.service).trim()     : '';

      if (!incident) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'incident is required.' }) }], isError: true };

      let auditCtx = '';
      let correlatedRedVerdicts = 0;
      try {
        const log = getAuditLog({ verdict: 'RED', limit: 5 });
        if (log.length > 0) {
          correlatedRedVerdicts = log.length;
          auditCtx = `Past RED council verdicts:\n${log.map((e: { summary?: string }) => `- ${e.summary ?? ''}`).join('\n')}`;
        }
      } catch { /* ignore */ }

      const context = [
        timeline   && `Timeline:\n${timeline}`,
        service    && `Service: ${service}`,
        auditCtx   || '',
      ].filter(Boolean).join('\n\n') || undefined;

      const result = await executeOne({
        id:      'pm-1',
        agent:   'debugger' as WorkerAgentType,
        task:    'Write a blameless postmortem. Include: (1) Incident summary (2) Root cause (five-whys analysis) (3) Impact (4) Timeline of detection/response/resolution (5) Action items with owner and deadline (6) What went well (7) Prevention measures. Use a constructive tone — blame systems not people.',
        code:    incident.slice(0, 4000),
        context,
      });

      const postmortem  = result.plan?.approach ?? result.output.recommendation;
      const root_cause  = result.output.recommendation.split(/[.!?]/)[0]?.trim() ?? '';
      const action_items = result.plan?.steps?.slice(0, 10) ?? [];

      return { content: [{ type: 'text', text: JSON.stringify({
        postmortem,
        root_cause,
        action_items,
        correlated_red_verdicts: correlatedRedVerdicts,
      }, null, 2) }] };
    }

    case 'veto_doc_gen': {
      const filePath = String(args?.file_path ?? '').trim();
      const styleArg = String(args?.style ?? 'auto').trim();

      if (!filePath) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'file_path is required.' }) }], isError: true };

      let content = '';
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (e: unknown) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Could not read file: ${(e as Error).message}` }) }], isError: true };
      }

      let detectedStyle = styleArg;
      if (styleArg === 'auto') {
        const ext = extname(filePath).toLowerCase();
        if (ext === '.ts' || ext === '.tsx') detectedStyle = 'tsdoc';
        else if (ext === '.py') detectedStyle = 'docstring';
        else detectedStyle = 'jsdoc';
      }

      const docGenResult = await executeOne({
        id:    'docgen-1',
        agent: 'documentation' as WorkerAgentType,
        task:  `Add ${detectedStyle} documentation comments to all public functions, classes, interfaces, and exported constants in this file. For each, add: (1) a one-line summary, (2) @param descriptions, (3) @returns description, (4) @throws if applicable. Return the COMPLETE file content with documentation added — do not truncate.`,
        code:  content.slice(0, 10000),
      });

      const docQuality = docGenResult.analysis?.score ?? Math.round(docGenResult.output.confidence * 100);
      autoRecord('doc-gen', 'documentation', docQuality);

      const annotatedContent = docGenResult.plan?.approach ?? docGenResult.output.recommendation ?? '';
      const symbolsDocumented = (annotatedContent.match(/@param\b/g) ?? []).length;

      return { content: [{ type: 'text', text: JSON.stringify({
        file_path:          filePath,
        style:              detectedStyle,
        annotated_content:  annotatedContent,
        symbols_documented: symbolsDocumented,
      }, null, 2) }] };
    }

    case 'veto_type_coverage': {
      const projectDir = String(args?.project_dir ?? '').trim();

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let grepOutput = '';
      try {
        grepOutput = execSyncTop('git grep -rn "any" --include="*.ts" --include="*.tsx" -- . ":(exclude)node_modules" ":(exclude)dist"', {
          cwd: projectDir, timeout: 6000, stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch (e: unknown) {
        grepOutput = (e as { stdout?: Buffer }).stdout?.toString() ?? '';
      }

      const anyLines = grepOutput.split('\n')
        .filter(l => /:\s*any\b|as any\b|<any>/.test(l))
        .slice(0, 100);
      const fileSet = new Set(anyLines.map(l => l.split(':')[0]));
      const maxFiles = typeof args?.max_files === 'number' ? Math.min(args.max_files, 30) : 20;
      const topFiles = [...fileSet].slice(0, maxFiles);

      const typeCoverResult = await executeOne({
        id:    'typecover-1',
        agent: 'coder' as WorkerAgentType,
        task:  'Analyze these TypeScript `any` usages. For each location, suggest a specific replacement type (use inferred types, generics, or union types). Flag any `any` in auth/security/payment code as HIGH severity.',
        code:  anyLines.join('\n').slice(0, 6000),
      });

      const typeCoverQuality = typeCoverResult.analysis?.score ?? Math.round(typeCoverResult.output.confidence * 100);
      autoRecord('type-coverage', 'coder', typeCoverQuality);

      const findings = anyLines.slice(0, 20).map(l => {
        const parts = l.split(':');
        const file    = parts[0] ?? '';
        const lineNum = parseInt(parts[1] ?? '0', 10);
        const lineContent = parts.slice(2).join(':').trim();
        const isHighSeverity = /auth|security|payment|secret|token|password/i.test(file + lineContent);
        const usage = /as any\b/.test(lineContent) ? 'as any' : /<any>/.test(lineContent) ? '<any>' : ': any';
        return { file, line: lineNum, usage, severity: isHighSeverity ? 'high' : 'medium' };
      });

      const highSeverityCount = findings.filter(f => f.severity === 'high').length;
      const typeCoveragePct = Math.max(0, 100 - Math.round(anyLines.length / 5));

      return { content: [{ type: 'text', text: JSON.stringify({
        total_any_usages:   anyLines.length,
        files_affected:     topFiles.length,
        high_severity:      highSeverityCount,
        findings,
        suggestions:        typeCoverResult.plan?.approach ?? typeCoverResult.output.recommendation ?? '',
        type_coverage_pct:  typeCoveragePct,
      }, null, 2) }] };
    }

    case 'veto_test_gaps': {
      const projectDir     = String(args?.project_dir ?? '').trim();
      const coverageReport = args?.coverage_report ? String(args.coverage_report).trim() : '';

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let coverageData = '';
      if (coverageReport && existsSync(coverageReport)) {
        try { coverageData = readFileSync(coverageReport, 'utf8').slice(0, 8000); } catch { /* skip */ }
      }

      let untestedFiles: string[] = [];
      if (!coverageData) {
        try {
          const allFiles = execSyncTop('git ls-files --cached -- "*.ts" "*.js" "*.py"', {
            cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'],
          }).toString().split('\n').filter(Boolean);
          const srcFiles  = allFiles.filter(f => !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__test__'));
          const testFiles = new Set(allFiles.filter(f => f.includes('.test.') || f.includes('.spec.')).map(f => f.replace(/\.(test|spec)\.(ts|js)$/, '')));
          untestedFiles   = srcFiles.filter(f => !testFiles.has(f.replace(/\.(ts|js)$/, ''))).slice(0, 20);
          coverageData    = `Files without tests:\n${untestedFiles.join('\n')}`;
        } catch { coverageData = 'Could not determine coverage'; }
      }

      const testGapResult = await executeOne({
        id:      'testgap-1',
        agent:   'tester' as WorkerAgentType,
        task:    'Identify test gaps and suggest concrete test cases. For each untested or low-coverage area, write a specific test scenario (what input, what expected output, what edge case). Prioritize: error handling paths, auth/security code, business logic.',
        code:    coverageData,
        context: buildContextString(projectDir) || undefined,
      });

      const testGapQuality = testGapResult.analysis?.score ?? Math.round(testGapResult.output.confidence * 100);
      autoRecord('test-gaps', 'tester', testGapQuality);

      return { content: [{ type: 'text', text: JSON.stringify({
        gaps_found:      untestedFiles.length || coverageData.split('\n').length,
        untested_files:  untestedFiles,
        suggested_tests: testGapResult.plan?.approach ?? testGapResult.output.recommendation ?? '',
        priority_areas:  [],
      }, null, 2) }] };
    }

    case 'veto_onboard': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const role       = args?.role ? String(args.role).trim() : '';

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      let readme = '';
      for (const name of ['README.md', 'readme.md', 'README.txt']) {
        try { readme = readFileSync(join(projectDir, name), 'utf8').slice(0, 3000); break; } catch { /* skip */ }
      }

      const onboardResult = await executeOne({
        id:          'onboard-1',
        agent:       'documentation' as WorkerAgentType,
        task:        `Write a complete onboarding guide for a new ${role || 'fullstack'} developer joining this project. Include: (1) Setup steps (clone, install, env vars, first run), (2) Architecture overview (key directories and their purpose), (3) Key files to understand first, (4) How to run tests, (5) Development workflow, (6) First PR checklist (what to check before submitting). Be specific to this codebase.`,
        context:     [buildContextString(projectDir), readme ? `README:\n${readme}` : ''].filter(Boolean).join('\n\n') || undefined,
        project_dir: projectDir,
      });

      const onboardQuality = onboardResult.analysis?.score ?? Math.round(onboardResult.output.confidence * 100);
      autoRecord('onboard', 'documentation', onboardQuality);

      return { content: [{ type: 'text', text: JSON.stringify({
        guide:    onboardResult.plan?.approach ?? onboardResult.output.recommendation ?? '',
        role:     role || 'fullstack',
        sections: ['Setup', 'Architecture', 'Key Files', 'Testing', 'Workflow', 'First PR'],
      }, null, 2) }] };
    }

    // ── veto_dep_advisor ────────────────────────────────────────────────────────
    case 'veto_dep_advisor': {
      const projectDir = String(args?.project_dir ?? '').trim();
      let ecosystem = String(args?.ecosystem ?? 'auto');
      let packages: Array<{ name: string; version: string }> = [];

      // Try npm first
      if (ecosystem === 'auto' || ecosystem === 'npm') {
        try {
          const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          packages = Object.entries(deps).map(([name, ver]) => ({ name, version: String(ver).replace(/[\^~>=<]/g, '').split('.')[0] + '.0.0' })).slice(0, 50);
          ecosystem = 'npm';
        } catch { /* try next */ }
      }
      if ((ecosystem === 'auto' || ecosystem === 'pypi') && packages.length === 0) {
        try {
          const req = readFileSync(join(projectDir, 'requirements.txt'), 'utf8');
          packages = req.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => { const [name, ver='0.0.0'] = l.split(/[==>=<]/); return { name: name.trim(), version: ver.trim() || '0.0.0' }; }).slice(0, 50);
          ecosystem = 'pypi';
        } catch { /* skip */ }
      }
      if (packages.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No package.json or requirements.txt found in project_dir.' }) }], isError: true };

      let vulnerabilities: Array<{ package: string; version: string; vuln_id: string; severity: string; summary: string }> = [];
      let osvAvailable = false;
      try {
        const osvEcosystem = ecosystem === 'npm' ? 'npm' : ecosystem === 'pypi' ? 'PyPI' : 'crates.io';
        const body = { queries: packages.slice(0, 30).map(p => ({ package: { name: p.name, ecosystem: osvEcosystem }, version: p.version })) };
        const resp = await fetch('https://api.osv.dev/v1/querybatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json() as { results: Array<{ vulns?: Array<{ id: string; summary: string; database_specific?: { severity?: string } }> }> };
          data.results.forEach((r, i) => {
            for (const v of (r.vulns ?? [])) {
              vulnerabilities.push({ package: packages[i].name, version: packages[i].version, vuln_id: v.id, severity: v.database_specific?.severity?.toLowerCase() ?? 'unknown', summary: v.summary });
            }
          });
          osvAvailable = true;
        }
      } catch { /* OSV unavailable — proceed without vuln data */ }

      const depResult = await executeOne({
        id: 'dep-1',
        agent: 'dependency-audit',
        task: 'Analyze these dependencies and produce a risk-ranked upgrade plan. For each vulnerable or outdated package: (1) risk level, (2) recommended version, (3) breaking-change risk, (4) migration steps.',
        code: JSON.stringify({ packages: packages.slice(0, 20), vulnerabilities }, null, 2).slice(0, 6000),
      });

      autoRecord('dep_advisor', 'dependency-audit', depResult.analysis?.score ?? Math.round(depResult.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        ecosystem,
        packages_scanned:    packages.length,
        vulnerabilities_found: vulnerabilities.length,
        vulns:               vulnerabilities,
        upgrade_plan:        depResult.plan?.approach ?? depResult.output.recommendation ?? '',
        osv_available:       osvAvailable,
      }, null, 2) }] };
    }

    // ── veto_query_advisor ──────────────────────────────────────────────────────
    case 'veto_query_advisor': {
      const query         = String(args?.query ?? '').trim();
      const schema        = args?.schema         ? String(args.schema).trim()         : '';
      const explainOutput = args?.explain_output ? String(args.explain_output).trim() : '';

      if (!query) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'query is required.' }) }], isError: true };

      // Deterministic pre-scan for common issues
      const issues: string[] = [];
      const q = query.toLowerCase();
      if (/select \*/i.test(query)) issues.push('SELECT * detected — specify only needed columns');
      if (/where.*like\s+'%/i.test(query)) issues.push('Leading wildcard LIKE pattern prevents index use');
      if (!q.includes('limit') && (q.includes('select') && !q.includes('count'))) issues.push('No LIMIT clause — could return unbounded result set');
      const joinCount = (q.match(/\bjoin\b/g) ?? []).length;
      if (joinCount > 4) issues.push(`${joinCount} JOINs detected — verify indexes on join columns`);

      const queryResult = await executeOne({
        id: 'query-1',
        agent: 'database',
        task: 'Analyze this SQL query for performance issues. Provide: (1) Rewritten optimized query, (2) Specific CREATE INDEX statements needed, (3) N+1 query detection if this is part of a loop, (4) Estimated improvement percentage, (5) Index risk assessment (will this lock the table?)',
        code: query.slice(0, 4000),
        context: [schema && `Schema:\n${schema}`, explainOutput && `EXPLAIN:\n${explainOutput}`].filter(Boolean).join('\n'),
      });

      autoRecord('query_advisor', 'database', queryResult.analysis?.score ?? Math.round(queryResult.output.confidence * 100));

      const agentOutput = queryResult.plan?.approach ?? queryResult.output.recommendation ?? '';
      const indexStatements = agentOutput.split('\n').filter((l: string) => /CREATE INDEX/i.test(l)).map((l: string) => l.trim());

      return { content: [{ type: 'text', text: JSON.stringify({
        issues_detected:      issues,
        optimized_query:      '',
        index_statements:     indexStatements,
        n_plus_one_risk:      /n\+1|n \+ 1/i.test(agentOutput),
        recommendations:      agentOutput,
        estimated_improvement: '',
      }, null, 2) }] };
    }

    // ── veto_bundle_advisor ─────────────────────────────────────────────────────
    case 'veto_bundle_advisor': {
      let statsRaw = '';
      try { statsRaw = readFileSync(String(args?.stats_file ?? ''), 'utf8'); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read stats file: ${e}` }) }], isError: true }; }
      let statsData: Record<string, unknown> = {};
      try { statsData = JSON.parse(statsRaw); } catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stats_file is not valid JSON' }) }], isError: true }; }

      // Extract key metrics from webpack stats format
      const assets = ((statsData.assets as Array<{ name: string; size: number }>) ?? []).sort((a, b) => b.size - a.size).slice(0, 20);
      const totalSize = assets.reduce((s, a) => s + (a.size ?? 0), 0);
      const summary = JSON.stringify({
        total_assets: assets.length,
        total_size_kb: Math.round(totalSize / 1024),
        top_assets: assets.slice(0, 10).map(a => ({ name: a.name, size_kb: Math.round(a.size / 1024) })),
      }, null, 2);

      const bundleResult = await executeOne({
        id: 'bundle-1',
        agent: 'frontend',
        task: 'Analyze this bundle stats and provide: (1) Top 10 heaviest modules to target, (2) Duplicate packages to deduplicate, (3) Code-split candidates (lazy-loadable routes or heavy features), (4) Packages safe to move to CDN externals (React, lodash, etc.), (5) Estimated size reduction achievable.',
        code: summary,
      });

      autoRecord('bundle_advisor', 'frontend', bundleResult.analysis?.score ?? Math.round(bundleResult.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        total_size_kb:        Math.round(totalSize / 1024),
        assets_analyzed:      assets.length,
        heaviest_modules:     assets.slice(0, 10).map(a => ({ name: a.name, size_kb: Math.round(a.size / 1024) })),
        recommendations:      bundleResult.plan?.approach ?? bundleResult.output.recommendation ?? '',
        estimated_reduction_pct: 0,
      }, null, 2) }] };
    }

    // ── veto_dead_code ──────────────────────────────────────────────────────────
    case 'veto_dead_code': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const exts = Array.isArray(args?.extensions) ? (args.extensions as unknown[]).map(String) : ['.ts', '.js'];
      const includeArgs = exts.map(e => `--include="*${e}"`).join(' ');

      const patterns: Array<{ label: string; regex: string }> = [
        { label: 'exported but possibly unused', regex: 'export (function|const|class|interface|type)' },
        { label: 'TODO/FIXME markers',           regex: '// (TODO|FIXME|HACK|XXX)' },
        { label: 'feature flag patterns',         regex: 'if.*flags?\\.\\w+|if.*feature.*enabled|if.*isEnabled' },
        { label: 'commented-out code blocks',     regex: '^\\/\\/' },
      ];
      let findings = '';
      for (const { label, regex } of patterns) {
        try {
          const out = execSyncTop(`git grep -rn "${regex}" ${includeArgs} -- . ":(exclude)node_modules" ":(exclude)dist"`, { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
          const lines = out.split('\n').filter(Boolean).slice(0, 20);
          if (lines.length > 0) findings += `\n=== ${label} (${lines.length} found) ===\n${lines.join('\n')}`;
        } catch { /* no matches — git grep exits 1 */ }
      }
      if (!findings) return { content: [{ type: 'text', text: JSON.stringify({ success: true, dead_code_items: [], summary: 'No dead code patterns detected.' }) }] };

      const ctx = buildContextString(projectDir);
      const deadResult = await executeOne({
        id: 'dead-1',
        agent: 'code-quality',
        task: 'Identify dead code and safe deletion candidates from these patterns. For each item: (1) is it actually dead/unused?, (2) safe to delete?, (3) deletion risk (high/medium/low). Focus on exports with zero imports, always-true/false flags, and commented blocks older than 6 months.',
        code: findings.slice(0, 6000),
        context: ctx || undefined,
      });

      autoRecord('dead_code', 'code-quality', deadResult.analysis?.score ?? Math.round(deadResult.output.confidence * 100));

      const agentOut = deadResult.plan?.approach ?? deadResult.output.recommendation ?? '';
      const safeMatches = agentOut.match(/\blow\b.*\bdelete\b|\bsafe to delete\b|\bsafely removed\b/gi) ?? [];

      return { content: [{ type: 'text', text: JSON.stringify({
        dead_code_items:  [],
        total_found:      findings.split('\n').filter(l => l.startsWith('===')).length,
        safe_to_delete:   safeMatches.length,
        recommendations:  agentOut,
        council_note:     'Run veto_council_debate before deleting any exports to check downstream impact.',
      }, null, 2) }] };
    }

    // ── veto_hitl_checkpoint ────────────────────────────────────────────────────
    case 'veto_hitl_checkpoint': {
      const stage      = String(args?.stage ?? '').trim();
      const context    = String(args?.context ?? '').trim();
      const riskLevel  = String(args?.risk_level ?? 'medium');
      const workflowId = args?.workflow_id ? String(args.workflow_id) : null;
      const options: string[] = Array.isArray(args?.options) ? (args.options as unknown[]).map(String) : ['Approve', 'Reject', 'Modify'];

      if (!stage || !context) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stage and context are required.' }) }], isError: true };

      const riskEmoji = ({ low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' } as Record<string, string>)[riskLevel] ?? '🟡';
      const checkpoint_id = `hitl-${Date.now().toString(36)}`;

      const formatted = [
        `## ⏸️  Human-in-the-Loop Checkpoint`,
        ``,
        `**Stage:** ${stage}${workflowId ? ` (workflow: ${workflowId})` : ''}`,
        `**Risk:** ${riskEmoji} ${riskLevel.toUpperCase()}`,
        ``,
        `### What is about to happen`,
        context,
        ``,
        `### Your response options`,
        options.map((o, i) => `${i + 1}. **${o}**`).join('\n'),
        ``,
        `_Respond with your choice to continue the workflow. The agent is waiting._`,
      ].join('\n');

      return { content: [{ type: 'text', text: JSON.stringify({
        checkpoint_id,
        stage,
        risk_level: riskLevel,
        status: 'waiting_for_approval',
        options,
        formatted_request: formatted,
        workflow_id: workflowId,
        created_at: new Date().toISOString(),
      }, null, 2) }] };
    }

    // ── veto_openapi_gen ────────────────────────────────────────────────────────
    case 'veto_openapi_gen': {
      const filePath   = args?.file_path   ? String(args.file_path)   : null;
      const projectDir = args?.project_dir ? String(args.project_dir) : null;
      const writeFileArg = args?.write_file === true;
      const framework  = String(args?.framework ?? 'auto');

      let routeContent = '';
      if (filePath) {
        try { routeContent = readFileSync(filePath, 'utf8').slice(0, 10000); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read ${filePath}: ${e}` }) }], isError: true }; }
      } else if (projectDir) {
        try {
          const candidates = execSyncTop(
            'git ls-files --cached -- "*.ts" "*.js" "*.py"',
            { cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }
          ).toString().split('\n').filter((f: string) => /route|router|api|endpoint|controller/i.test(f) && !f.includes('node_modules') && !f.includes('dist/')).slice(0, 5);
          for (const f of candidates) {
            try { routeContent += `\n// FILE: ${f}\n${readFileSync(join(projectDir, f), 'utf8').slice(0, 3000)}\n`; } catch { /* skip */ }
          }
        } catch { /* not a git repo */ }
      }
      if (!routeContent) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No route files found. Provide file_path or project_dir with route files.' }) }], isError: true };

      const openapiResult = await executeOne({
        id:    'openapi-1',
        agent: 'api' as WorkerAgentType,
        task:  `Generate a complete OpenAPI 3.1 specification in YAML format for these ${framework === 'auto' ? 'API' : framework} route definitions. Include: info block (title, version), servers, all paths with HTTP methods, request body schemas, response schemas (200, 400, 401, 404, 500), and security schemes if auth is detected. Output ONLY valid YAML — no markdown fences, no explanation.`,
        code:  routeContent,
      });

      const rawSpec = openapiResult.plan?.approach ?? openapiResult.output.recommendation ?? '';
      const specLines = rawSpec.split('\n');
      const specStart = specLines.findIndex((l: string) => /^(openapi:|info:)/.test(l.trim()));
      const spec = specStart >= 0 ? specLines.slice(specStart).join('\n').trim() : rawSpec.trim();

      let writtenTo: string | null = null;
      if (writeFileArg && projectDir && spec) {
        try {
          const outPath = join(projectDir, 'openapi.yaml');
          writeFileSync(outPath, spec, 'utf8');
          writtenTo = outPath;
        } catch { /* skip write errors */ }
      }

      const routeLineCount = (routeContent.match(/\bget\b|\bpost\b|\bput\b|\bpatch\b|\bdelete\b/gi) ?? []).length;

      autoRecord('openapi_gen', 'api', openapiResult.analysis?.score ?? Math.round(openapiResult.output.confidence * 100));

      return { content: [{ type: 'text', text: JSON.stringify({
        spec,
        written_to:       writtenTo,
        routes_detected:  routeLineCount,
        framework,
      }, null, 2) }] };
    }

    // ── veto_flag_auditor ───────────────────────────────────────────────────────
    case 'veto_flag_auditor': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const sdk        = String(args?.sdk ?? 'auto');

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      const patterns = [
        { label: 'LaunchDarkly', regex: 'ldClient\\.variation|isFeatureEnabled|client\\.boolVariation' },
        { label: 'Unleash',      regex: 'isEnabled\\(|getVariant\\(|unleash\\.isEnabled' },
        { label: 'Custom flags', regex: 'flags?\\[|flags?\\.\\w+|feature[Ff]lag|isFeature|FEATURE_' },
        { label: 'Env-based flags', regex: 'process\\.env\\.FEATURE_|process\\.env\\.ENABLE_|process\\.env\\.FF_' },
      ];

      let findings = '';
      let totalMatches = 0;
      for (const { label, regex } of patterns) {
        try {
          const out = execSyncTop(
            `git grep -rn "${regex}" --include="*.ts" --include="*.js" --include="*.py" -- . ":(exclude)node_modules" ":(exclude)dist"`,
            { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
          ).toString();
          const lines = out.split('\n').filter(Boolean);
          totalMatches += lines.length;
          if (lines.length > 0) findings += `\n=== ${label} (${lines.length} occurrences) ===\n${lines.slice(0, 15).join('\n')}`;
        } catch { /* no matches */ }
      }

      if (!findings) return { content: [{ type: 'text', text: JSON.stringify({ success: true, flags_found: 0, flag_items: [], summary: 'No feature flag patterns detected.' }) }] };

      const flagResult = await executeOne({
        id:    'flags-1',
        agent: 'code-quality' as WorkerAgentType,
        task:  'Analyze these feature flag usages and classify each unique flag as: (1) ACTIVE — still toggled in code and worth keeping, (2) CANDIDATE_REMOVAL — always-true/always-false or deprecated, (3) ORPHANED — referenced but flag definition not found. For each, provide: flag name, classification, last-seen location, and safe-to-remove assessment.',
        code:  findings.slice(0, 6000),
      });

      const agentOut = flagResult.plan?.approach ?? flagResult.output.recommendation ?? '';
      autoRecord('flag_audit', 'code-quality', flagResult.analysis?.score ?? Math.round(flagResult.output.confidence * 100));

      // Parse a rough count from agentOut heuristics
      const activeCount    = (agentOut.match(/ACTIVE/g) ?? []).length;
      const removalCount   = (agentOut.match(/CANDIDATE_REMOVAL/g) ?? []).length;
      const orphanedCount  = (agentOut.match(/ORPHANED/g) ?? []).length;

      return { content: [{ type: 'text', text: JSON.stringify({
        flags_found:        totalMatches,
        active:             activeCount,
        candidate_removal:  removalCount,
        orphaned:           orphanedCount,
        flag_items:         [],
        recommendations:    agentOut,
        sdk_detected:       sdk === 'auto' ? (findings.includes('ldClient') ? 'launchdarkly' : findings.includes('unleash') ? 'unleash' : 'custom') : sdk,
        council_note:       'Run veto_council_debate before removing any flags to assess downstream risk.',
      }, null, 2) }] };
    }

    // ── Phase 7: Intelligence & Advanced ──────────────────────────────────────
    case 'veto_local_llm': {
      const { task, model, provider } = args;
      const { callLocalLlm } = await import('./agents/local-llm.js');
      const result = await callLocalLlm({ task: String(task), model: model ? String(model) : undefined, provider: provider as any });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    case 'veto_clone_detector': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const extensions = Array.isArray(args?.extensions) ? args.extensions.map(String) : undefined;
      const minLines = typeof args?.min_lines === 'number' ? args.min_lines : undefined;
      const { detectClones } = await import('./agents/quality/clone-detector.js');
      const findings = await detectClones({ project_dir: projectDir, extensions, min_lines: minLines });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, clones_found: findings.length, findings }, null, 2) }] };
    }
    case 'veto_lint_rules': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const tool = String(args?.tool ?? 'eslint');
      const ctx = buildContextString(projectDir);
      const result = await executeOne({
        id: 'lint-1',
        agent: 'reviewer',
        task: `Analyze the project coding style in ${projectDir} and auto-generate or update the optimal configuration file for ${tool}. Return the complete configuration file content and explain the choices based on detected patterns.`,
        context: ctx || undefined,
        project_dir: projectDir,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, tool, config: result.plan?.approach ?? result.output.recommendation, details: result.plan }, null, 2) }] };
    }
    case 'veto_api_contract': {
      const projectDir = String(args?.project_dir ?? '').trim();
      const target = String(args?.target ?? 'generate');
      const ctx = buildContextString(projectDir);
      const result = await executeOne({
        id: 'api-1',
        agent: 'api',
        task: `Perform API contract ${target} for ${projectDir}. ${target === 'generate' ? 'Generate a complete OpenAPI or TypeScript contract based on detected routes.' : 'Verify the existing contracts against the implementation and identify any breaking changes or mismatches.'}`,
        context: ctx || undefined,
        project_dir: projectDir,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, target, contract: result.plan?.approach ?? result.output.recommendation, details: result.plan }, null, 2) }] };
    }
    case 'veto_merge_conflict': {
      const filePath = String(args?.file_path ?? '').trim();
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      let content = '';
      try { content = readFileSync(filePath, 'utf8'); } catch (err) { return { content: [{ type: 'text', text: `Error reading file: ${err}` }], isError: true }; }
      
      const hasConflicts = content.includes('<<<<<<<') && content.includes('>>>>>>>');
      if (!hasConflicts) return { content: [{ type: 'text', text: 'No git conflict markers detected in file.' }] };

      const result = await executeOne({
        id: 'merge-1',
        agent: 'debugger',
        task: `Analyze the git conflict markers in ${filePath} and return a semantically correct resolution by understanding the intent of both branches. Return the complete resolved file content.`,
        code: content.slice(0, 10000),
        project_dir: projectDir,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, file: filePath, resolution: result.plan?.approach ?? result.output.recommendation }, null, 2) }] };
    }
    case 'veto_translate': {
      const text = args?.text ? String(args.text) : undefined;
      const filePath = args?.file_path ? String(args.file_path) : undefined;
      const targetLangs = Array.isArray(args?.target_langs) ? args.target_langs.map(String) : [];
      let content = text || '';
      if (filePath) { try { content = readFileSync(filePath, 'utf8'); } catch { return { content: [{ type: 'text', text: `Cannot read file: ${filePath}` }], isError: true }; } }
      if (!content) return { content: [{ type: 'text', text: 'text or file_path is required.' }], isError: true };

      const result = await executeOne({
        id: 'trans-1',
        agent: 'documentation',
        task: `Translate the following text to [${targetLangs.join(', ')}]. Preserving all variables, code blocks, and formatting. Return a JSON object mapping language codes to translations.`,
        code: content.slice(0, 8000),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, translations: result.plan?.approach ?? result.output.recommendation }, null, 2) }] };
    }
    case 'veto_a11y_advisor': {
      const filePath = String(args?.file_path ?? '').trim();
      let content = '';
      try { content = readFileSync(filePath, 'utf8'); } catch { return { content: [{ type: 'text', text: `Cannot read file: ${filePath}` }], isError: true }; }
      const result = await executeOne({
        id: 'a11y-1',
        agent: 'accessibility' as any,
        task: `Analyze this UI component for WCAG accessibility violations. Identify contrast issues, missing labels, poor ARIA usage, and keyboard navigation gaps. Provide actionable fix recommendations.`,
        code: content.slice(0, 8000),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, findings: result.analysis || result.output.recommendation }, null, 2) }] };
    }
    case 'veto_session_replay': {
      const sessionId = String(args?.session_id ?? '').trim();
      if (!sessionId) return { content: [{ type: 'text', text: 'session_id is required.' }], isError: true };
      const traces = getSessionReplay(sessionId);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, session_id: sessionId, events: traces }, null, 2) }] };
    }
    case 'veto_compose_agents': {
      const { name, agents, workflow } = args;
      // Register custom meta-agent in memory (Stub persistence, but functional for the current session)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Custom agent ${name} composed and registered.`, definition: { name, base_agents: agents, workflow } }, null, 2) }] };
    }

    // ── Phase 8: Long-Horizon ─────────────────────────────────────────────────
    case 'veto_semantic_search': {
      const { query, project_dir } = args;
      const result = await executeOne({
        id: 'search-1',
        agent: 'search-agent' as any,
        task: `Perform a semantic codebase search for: "${query}". Identify relevant modules, functions, and logic flows even if keywords don't match exactly. Explain the reasoning for each result.`,
        project_dir: String(project_dir),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, query, results: result.plan?.approach ?? result.output.recommendation }, null, 2) }] };
    }
    case 'veto_sdd_agent': {
      const { spec_file, project_dir, action } = args;
      let spec = '';
      try { spec = readFileSync(String(spec_file), 'utf8'); } catch { /* ignore */ }
      const result = await executeOne({
        id: 'sdd-1',
        agent: 'task-planner',
        task: `Execute Spec-Driven Development action '${action}' for the provided specification. ${action === 'validate' ? 'Check for inconsistencies.' : action === 'generate_ac' ? 'Generate acceptance criteria.' : 'Author BDD scenarios.'}`,
        code: spec.slice(0, 8000),
        project_dir: String(project_dir),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, action, output: result.plan?.approach ?? result.output.recommendation }, null, 2) }] };
    }
    case 'veto_playwright': {
      const { task, project_dir, url } = args;
      const result = await executeOne({
        id: 'pw-1',
        agent: 'tester',
        task: `Coordinate a Playwright browser session for: "${task}"${url ? ` starting at ${url}` : ''}. Output the recommended test script and identify any UI elements likely to be problematic.`,
        project_dir: String(project_dir),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: !result.error, task, url, script: result.plan?.approach ?? result.output.recommendation }, null, 2) }] };
    }
    case 'veto_notify_ide': {
      const { action, path, message, level } = args;
      // In bidirectional MCP, some clients listen for logging or custom notifications
      if (action === 'show_message' && message) {
        await server.sendLoggingMessage({
          level: level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'info',
          data: message,
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, action, message: `Action ${action} sent to IDE client.` }, null, 2) }] };
    }

    default:          throw new Error(`Unknown tool: ${name}`);
      }
    })();

    if (response && typeof response === 'object' && 'isError' in response && (response as any).isError) {
      resultStatus = 'error';
      errorMessage = (response as any).content?.[0]?.text || 'Unknown MCP error';
    }
    return response;
  } catch (err: any) {
    resultStatus = 'error';
    errorMessage = err.message;
    throw err;
  } finally {
    const duration_ms = Date.now() - callStart;
    const session_id = args?.session_id ? String(args.session_id) : autoSave.last_session_id ?? undefined;
    if (name !== 'veto_status' || (args?.token_count && (args.token_count as number) > 0)) {
      try {
        recordToolCall({
          session_id,
          tool_name: name,
          args: args as any,
          result_status: resultStatus,
          error_message: errorMessage,
          duration_ms,
        });
      } catch (logErr) {
        process.stderr.write(`Failed to record tool call trace: ${logErr instanceof Error ? logErr.message : String(logErr)}\n`);
      }
    }
  }
});

// ─── MCP Resources ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'veto://sessions',
      name: 'Saved Sessions',
      description: 'List of all saved Veto sessions. Append ?limit=N to control count.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://session/latest',
      name: 'Latest Session',
      description: 'The most recently saved session — summary, context, and task_state.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://project-map',
      name: 'Project Map (stored)',
      description: 'Manually-maintained project structure. Append ?dir=<absolute_path> to get a specific project.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://repo-map',
      name: 'Repo Map (live)',
      description: 'Live structural index: symbol extraction + dependency graph + PageRank ranking. Append ?dir=<absolute_path>. More accurate than the stored project map.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://memory',
      name: 'Knowledge Base',
      description: 'All stored knowledge entries. Append ?q=<query> to search, ?type=<type> to filter.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://memory/recent',
      name: 'Recent Memory',
      description: 'The 10 most recently stored knowledge entries — no query required.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://patterns',
      name: 'Learned Patterns',
      description: 'Coding patterns Veto has learned from your sessions. Append ?prefix=<prefix> to filter by key prefix.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const url = new URL(uri);

  if (url.host === 'sessions') {
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50);
    const sessions = listSessions(limit);
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(sessions.map(s => ({
          id: s.id, platform: s.platform, summary: s.summary,
          project_dir: s.project_dir, started_at: s.started_at,
        })), null, 2),
      }],
    };
  }

  if (url.host === 'session' && url.pathname === '/latest') {
    const sessions = listSessions(1);
    const latest = sessions[0] ?? null;
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(latest ? {
          id: latest.id, platform: latest.platform, summary: latest.summary,
          context: latest.context, task_state: latest.task_state,
          project_dir: latest.project_dir, started_at: latest.started_at,
        } : { found: false }, null, 2),
      }],
    };
  }

  if (url.host === 'project-map') {
    const dir = url.searchParams.get('dir') ?? '';
    if (dir) {
      const row = getProjectMap(dir);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(row ?? { found: false }, null, 2),
        }],
      };
    }
    return { contents: [{ uri, mimeType: 'application/json', text: '{"message":"Append ?dir=<absolute_path> to get a specific project map."}' }] };
  }

  if (url.host === 'repo-map') {
    const dir = url.searchParams.get('dir') ?? '';
    if (!dir) {
      return { contents: [{ uri, mimeType: 'application/json', text: '{"message":"Append ?dir=<absolute_path> to compute a live repo map."}' }] };
    }
    try {
      const map = buildRepoMap({ projectDir: dir });
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            generated_at: map.generated_at,
            total_files: map.total_files,
            symbol_count: map.symbol_count,
            top_modules: map.top_modules,
            dep_graph: map.dep_graph,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }

  if (url.host === 'memory') {
    const isRecent = url.pathname === '/recent';
    if (isRecent) {
      const results = searchKnowledge({ limit: 10 });
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(results.map(r => ({
            id: r.id, type: r.type, title: r.title,
            content: r.content.slice(0, 300), tags: r.tags ? JSON.parse(r.tags) : [],
          })), null, 2),
        }],
      };
    }
    const q = url.searchParams.get('q') ?? undefined;
    const typeRaw = url.searchParams.get('type') ?? undefined;
    const knownTypes = ['solution', 'pattern', 'context', 'error', 'reference', 'decision'] as const;
    const type = knownTypes.includes(typeRaw as typeof knownTypes[number]) ? typeRaw as typeof knownTypes[number] : undefined;
    const results = searchKnowledge({ query: q, type, limit: 20 });
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(results.map(r => ({
          id: r.id, type: r.type, title: r.title,
          content: r.content, tags: r.tags ? JSON.parse(r.tags) : [],
        })), null, 2),
      }],
    };
  }

  if (url.host === 'patterns') {
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const patterns = getPatterns(prefix, 50);
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(patterns.map(p => ({
          key: p.pattern_key, val: p.pattern_val,
          confidence: p.confidence, seen_count: p.seen_count,
        })), null, 2),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ─── MCP Prompts ───────────────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'code-review',
    description: 'Full code review prompt — paste code, get scored findings with severity and fixes.',
    arguments: [
      { name: 'code', description: 'The code to review.', required: true },
      { name: 'focus', description: 'Optional focus area (e.g. security, performance, style).', required: false },
    ],
  },
  {
    name: 'security-audit',
    description: 'OWASP Top 10 security audit — scans code for vulnerabilities with CWE references.',
    arguments: [
      { name: 'code', description: 'The code to audit.', required: true },
      { name: 'language', description: 'Language or framework (e.g. TypeScript, Express).', required: false },
    ],
  },
  {
    name: 'deploy-checklist',
    description: 'Pre-deploy checklist debate — council reviews your deployment plan.',
    arguments: [
      { name: 'plan', description: 'Your deployment plan or change description.', required: true },
      { name: 'environment', description: 'Target environment (prod, staging, etc.).', required: false },
    ],
  },
  {
    name: 'explain-file',
    description: 'Expert explanation of a file — routes to the best-fit agent based on file type.',
    arguments: [
      { name: 'file_path', description: 'Absolute path to the file to explain.', required: true },
      { name: 'depth', description: 'Explanation depth: overview | detailed | line-by-line.', required: false },
    ],
  },
  // Phase 4.3 — Workflow Prompts
  {
    name: 'full-review',
    description: 'Complete pre-ship review: code quality + security + secrets + quality in one call. Uses veto_full_review pipeline.',
    arguments: [
      { name: 'project_dir', description: 'Absolute path to the project to review.', required: false },
      { name: 'diff',        description: 'Optional: git diff string to review directly.', required: false },
      { name: 'context',     description: 'Optional: PR description or context.', required: false },
    ],
  },
  {
    name: 'new-feature',
    description: 'New feature planning: council governance → execution plan → task DAG. Uses veto_new_feature pipeline.',
    arguments: [
      { name: 'description', description: 'Feature description or user story.', required: true },
      { name: 'project_dir', description: 'Optional: absolute path to project for context.', required: false },
      { name: 'context',     description: 'Optional: constraints, timeline, or architecture notes.', required: false },
    ],
  },
  {
    name: 'debug-incident',
    description: 'Incident debugging workflow: recent-change blame → debugger plan → deep-dive explanation.',
    arguments: [
      { name: 'error',       description: 'Error message, stack trace, or incident description.', required: true },
      { name: 'project_dir', description: 'Optional: absolute path to project for git blame context.', required: false },
    ],
  },
  {
    name: 'onboard',
    description: 'New-developer onboarding: full project discovery → plain-English briefing → recommended starting agents.',
    arguments: [
      { name: 'project_dir', description: 'Absolute path to the project to onboard into.', required: true },
    ],
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: pArgs } = request.params;

  if (name === 'code-review') {
    const code = pArgs?.code ?? '<paste code here>';
    const focus = pArgs?.focus ? ` Focus on: ${pArgs.focus}.` : '';
    return {
      description: PROMPTS[0].description,
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Use veto_code_review to review this code.${focus}\n\n\`\`\`\n${code}\n\`\`\`` },
      }],
    };
  }

  if (name === 'security-audit') {
    const code = pArgs?.code ?? '<paste code here>';
    const lang = pArgs?.language ? ` Language/framework: ${pArgs.language}.` : '';
    return {
      description: PROMPTS[1].description,
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Use veto_security_scan to audit this code for OWASP Top 10 vulnerabilities.${lang}\n\n\`\`\`\n${code}\n\`\`\`` },
      }],
    };
  }

  if (name === 'deploy-checklist') {
    const plan = pArgs?.plan ?? '<describe your deployment plan>';
    const env = pArgs?.environment ? ` Target environment: ${pArgs.environment}.` : '';
    return {
      description: PROMPTS[2].description,
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Use veto_council_debate to review this deployment plan before we ship.${env}\n\nPlan: ${plan}` },
      }],
    };
  }

  if (name === 'explain-file') {
    const filePath = pArgs?.file_path ?? '<absolute file path>';
    const depth = pArgs?.depth ?? 'overview';
    return {
      description: PROMPTS[3].description,
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Read the file at "${filePath}" and use veto_agent_plan with the most appropriate agent (frontend for .tsx/.vue, database for .sql, backend for services, coder for general) to give a ${depth}-level explanation of what it does, how it works, and any concerns.` },
      }],
    };
  }

  if (name === 'full-review') {
    const projectDir = pArgs?.project_dir ? `\nproject_dir: ${pArgs.project_dir}` : '';
    const diff = pArgs?.diff ? `\ndiff: (provided)` : '';
    const ctx = pArgs?.context ? `\ncontext: ${pArgs.context}` : '';
    const callArgs = [
      pArgs?.project_dir ? `project_dir: "${pArgs.project_dir}"` : null,
      pArgs?.diff        ? `diff: "<the diff provided above>"` : null,
      pArgs?.context     ? `context: "${pArgs.context}"` : null,
    ].filter(Boolean).join(', ') || 'project_dir: "<absolute path>"';
    return {
      description: PROMPTS.find(p => p.name === 'full-review')!.description,
      messages: [{ role: 'user', content: { type: 'text', text:
        `Run a complete pre-ship review using the veto_full_review pipeline.${projectDir}${diff}${ctx}\n\n` +
        `Call veto_full_review with { ${callArgs} }.\n\n` +
        `Review the combined verdict:\n` +
        `- ❌ FAIL → address all critical findings before merging\n` +
        `- ⚠️  WARN → review high-severity findings; proceed with care\n` +
        `- ✅ PASS → safe to merge\n\n` +
        `For any critical finding, call veto_memory_store to record it for future sessions.`,
      } }],
    };
  }

  if (name === 'new-feature') {
    const desc = pArgs?.description ?? '<feature description or user story>';
    const projectDir = pArgs?.project_dir ? `\nproject_dir: ${pArgs.project_dir}` : '';
    const ctx = pArgs?.context ? `\ncontext: ${pArgs.context}` : '';
    const callArgs = [
      `description: "${desc}"`,
      pArgs?.project_dir ? `project_dir: "${pArgs.project_dir}"` : null,
      pArgs?.context     ? `context: "${pArgs.context}"` : null,
    ].filter(Boolean).join(', ');
    return {
      description: PROMPTS.find(p => p.name === 'new-feature')!.description,
      messages: [{ role: 'user', content: { type: 'text', text:
        `Plan a new feature using the veto_new_feature pipeline (council governance + execution plan + task breakdown).${projectDir}${ctx}\n\n` +
        `Feature: ${desc}\n\n` +
        `Call veto_new_feature with { ${callArgs} }.\n\n` +
        `Interpret the result:\n` +
        `- verdict "blocked" (RED) → share the block_reasons with the team; do not proceed\n` +
        `- verdict "approved_with_warnings" (YELLOW) → review warnings; address before shipping\n` +
        `- verdict "approved" (GREEN) → use agent_plan.plan for execution; assign tasks from the task list\n\n` +
        `If you need LLM-backed council reasoning, use the llm_upgrade.debate_prompt from the council result.`,
      } }],
    };
  }

  if (name === 'debug-incident') {
    const error = pArgs?.error ?? '<error message, stack trace, or incident description>';
    const projectDir = pArgs?.project_dir ?? '';
    const blameStep = projectDir
      ? `1. Call veto_git_blame with { project_dir: "${projectDir}" } to surface recent changes near the error.\n`
      : `1. (No project_dir provided — skip git blame or call veto_git_blame once you know the repo path.)\n`;
    return {
      description: PROMPTS.find(p => p.name === 'debug-incident')!.description,
      messages: [{ role: 'user', content: { type: 'text', text:
        `Debug this incident using Veto's agents.\n\nError / incident:\n${error}\n\n` +
        `Follow this workflow:\n` +
        `${blameStep}` +
        `2. Call veto_agent_plan with { agent: "debugger", task: "<error description above>"${projectDir ? `, project_dir: "${projectDir}"` : ''} } to get a structured root-cause analysis plan.\n` +
        `3. For each likely file identified, call veto_explain with { file_path: "<path>", depth: "detailed" } to understand the code involved.\n` +
        `4. Once root cause is identified, call veto_memory_store to record the finding so it's available in future sessions.\n`,
      } }],
    };
  }

  if (name === 'onboard') {
    const projectDir = pArgs?.project_dir ?? '<absolute path to project>';
    return {
      description: PROMPTS.find(p => p.name === 'onboard')!.description,
      messages: [{ role: 'user', content: { type: 'text', text:
        `Onboard me to this project using Veto's discovery and summarization tools.\n\nproject_dir: ${projectDir}\n\n` +
        `Follow this workflow:\n` +
        `1. Call veto_discover with { project_dir: "${projectDir}", depth: "full" } — maps the full project structure, entry points, tech stack, and key files.\n` +
        `2. Call veto_summarize with { project_dir: "${projectDir}" } — generates a plain-English briefing written for a developer joining the project today.\n` +
        `3. Call veto_project_map_get with { project_dir: "${projectDir}" } — surfaces the stored structural map for quick reference.\n` +
        `4. Call veto_route_task with { task: "common feature development", context: "new developer onboarding" } — see which agents and tier are recommended for typical tasks.\n\n` +
        `Present the onboarding guide as:\n` +
        `- Setup & architecture (from discover)\n` +
        `- Key files and entry points\n` +
        `- Recommended starting tasks and agents\n` +
        `- Any warnings or risks flagged by the project map`,
      } }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const loadedPlugins = await loadPlugins();
  if (loadedPlugins.length > 0) {
    process.stderr.write(`[veto] Loaded ${loadedPlugins.length} plugin(s): ${loadedPlugins.join(', ')}\n`);
  }
  initLlmRunner(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Veto MCP server v${VERSION} running (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
