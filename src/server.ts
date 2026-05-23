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
  upsertContextUsage, getContextUsage,
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
import { readFileSync, statSync } from 'node:fs';
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

Recommended start sequence:
  1. veto_status — confirm server is running and check token usage
  2. veto_discover or veto_summarize — orient to the codebase before touching files
  3. veto_route_task — pick the right agent before heavy analysis
  4. veto_diff_review or veto_council_debate — validate before shipping
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
  veto_workflow:          { readOnlyHint: false, destructiveHint: false },
  veto_ci_gate:           { readOnlyHint: false, destructiveHint: false },
  veto_usage_status:      { readOnlyHint: false, destructiveHint: false },
  // destructive — permanent deletes or config overwrites
  veto_memory_delete:     { readOnlyHint: false, destructiveHint: true },
  veto_memory_import:     { readOnlyHint: false, destructiveHint: true },
  veto_platform_setup:    { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
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

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      if (rawTasks.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'tasks array is required and must not be empty.' }) }], isError: true };
      }
      const parallelProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const tasks: AgentTask[] = rawTasks.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ''),
        agent: String(t.agent ?? '') as WorkerAgentType,
        task: String(t.task ?? ''),
        code: t.code ? String(t.code) : undefined,
        context: t.context ? String(t.context) : undefined,
        project_dir: t.project_dir ? String(t.project_dir) : parallelProjectDir,
      }));
      const results = await executeParallel(tasks);

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
      }));
      const result = await runPipeline(steps, args?.project_dir ? String(args.project_dir) : undefined);

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

      if (!description) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };
      }

      const hash = createHash('sha256').update(description).digest('hex').slice(0, 16);
      const cached = getTaskPlan(hash);
      if (cached) {
        const plan = JSON.parse(cached.plan_json);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, plan_id: cached.id, cached: true, ...plan }, null, 2) }] };
      }

      const ctx = project_dir ? buildContextString(project_dir) : '';
      const planResult = await executeOne({ id: 'task-parse-1', agent: 'task-planner', task: `Parse this project description into a structured task breakdown with dependencies and complexity scores (max ${max_tasks} tasks):\n\n${description}`, context: ctx || undefined, project_dir });

      // Build structured task DAG from planner output
      const steps: string[] = planResult.plan?.steps ?? [];

      // Agent keyword map — pick the most relevant agent based on step keywords
      const agentKeywords: Array<{ keywords: RegExp; agent: string }> = [
        { keywords: /test|spec|coverage|assert|unit|integration/i,           agent: 'tester' },
        { keywords: /secur|auth|jwt|oauth|permission|role|encrypt|hash/i,    agent: 'auth' },
        { keywords: /database|schema|migrat|sql|query|index|table/i,         agent: 'database' },
        { keywords: /api|endpoint|rest|graphql|route|openapi/i,              agent: 'api' },
        { keywords: /ui|component|frontend|react|vue|svelte|html|css|style/i,agent: 'frontend' },
        { keywords: /docker|deploy|ci|cd|pipeline|container|k8s|infra/i,     agent: 'devops' },
        { keywords: /refactor|clean|restructure|rename|extract/i,            agent: 'refactor' },
        { keywords: /review|audit|quality|lint|check/i,                      agent: 'reviewer' },
        { keywords: /debug|fix|bug|error|crash|trace|diagnos/i,              agent: 'debugger' },
        { keywords: /document|readme|comment|jsdoc|wiki/i,                   agent: 'documentation' },
        { keywords: /perform|optim|speed|cache|profil|latency/i,             agent: 'performance' },
        { keywords: /migrat|upgrade|version|port|convert/i,                  agent: 'migration' },
      ];

      function pickAgent(step: string): string {
        for (const { keywords, agent } of agentKeywords) {
          if (keywords.test(step)) return agent;
        }
        return 'coder';
      }

      // Complexity scoring: longer, more-keyword-dense steps = higher complexity
      function scoreStep(step: string): number {
        const words = step.split(/\s+/).length;
        const hasComplexWords = /integrat|architect|design|implement|optim|migrat|refactor/i.test(step);
        const base = Math.min(7, Math.max(2, Math.round(words / 3)));
        return hasComplexWords ? Math.min(10, base + 2) : base;
      }

      // Dependency inference: look for explicit "after", "before", "requires", "depends" keywords
      function inferDeps(step: string, allSteps: string[], idx: number): string[] {
        const lower = step.toLowerCase();
        if (/^(deploy|test|release|publish|document)/i.test(step.trim()) && idx > 0) {
          return [`task-${idx}`];
        }
        if (/after.{0,30}(setup|init|instal|creat|build)/i.test(lower) && idx > 0) {
          return [`task-${idx}`];
        }
        return idx > 0 && /integrat|connect|wire|link/i.test(lower) ? [`task-${idx}`] : [];
      }

      const tasks = steps.slice(0, max_tasks).map((step, i) => {
        const complexity = scoreStep(step);
        const agent = pickAgent(step);
        const deps = inferDeps(step, steps, i);
        const priority = i === 0 ? 'critical' : complexity >= 7 ? 'high' : complexity >= 5 ? 'medium' : 'low';
        const estimated_hours = complexity <= 3 ? 1 : complexity <= 6 ? 2 : complexity <= 8 ? 4 : 8;
        return { id: `task-${i + 1}`, title: step, complexity, priority, depends_on: deps, suggested_agent: agent, estimated_hours };
      });

      const plan = {
        summary: description.slice(0, 100),
        total_tasks: tasks.length,
        total_complexity: tasks.reduce((s, t) => s + t.complexity, 0),
        critical_path: tasks.map(t => t.id),
        parallelisable_groups: tasks.length > 2 ? [tasks.slice(1, Math.ceil(tasks.length / 2)).map(t => t.id)] : [],
        tasks,
        duration_estimate: planResult.plan?.duration_estimate ?? 'unknown',
      };

      autoRecord(description, 'task-planner', Math.round(planResult.output.confidence * 100));
      const plan_id = saveTaskPlan(JSON.stringify(plan), hash, project_dir);

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, plan_id, ...plan }, null, 2) }] };
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

    default:
      throw new Error(`Unknown tool: ${name}`);
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
