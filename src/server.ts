#!/usr/bin/env node
// Veto MCP Server — 89 tools, LLM council + auto-learning router

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
import { log, errMsg } from './log.js';
import { readGitDiff, runTripleScan, handleAgenticWorker } from './server/scan-core.js';
import type { HandlerMap } from './server/registry.js';
import { workerHandlers } from './server/handlers/workers.js';
import { memoryHandlers } from './server/handlers/memory.js';
import { observabilityHandlers } from './server/handlers/observability.js';
import { sessionHandlers } from './server/handlers/session.js';
import { learningHandlers } from './server/handlers/learning.js';
import { watchHandlers } from './server/handlers/watch.js';
import { devtoolsHandlers } from './server/handlers/devtools.js';
import { advisorHandlers } from './server/handlers/advisors.js';
import { generatorHandlers } from './server/handlers/generators.js';
import { gitHandlers } from './server/handlers/git.js';
import {
  VERSION, getActiveProjectDir, setActiveProjectDir, serverHealth,
  autoSave, maybeAutoSave, autoStoreCritical, parsePrdIntoTasks, buildTaskPlan,
} from './server/runtime.js';
import {
  saveSession, restoreSession, listSessions, closeSession, getDbPath, saveCouncilOutcome,
  storeKnowledge, searchKnowledge, deleteKnowledge,
  updateProjectMap, getProjectMap,
  upsertPattern, getPatterns,
  getContextStatus, fetchAndCacheDocs, saveTaskPlan, getTaskPlan,
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
import { routeTask, getRateStatus, trackTokens, recordOutcome, getRecommendedAgent } from './router/index.js';
import { getConfig, setConfig } from './memory/config.js';
import type { AgentType, Platform } from './router/index.js';
import { executeParallel, executeOne, initLlmRunner } from './agents/executor.js';
import { buildAgenticAgentPrompt, parseAgenticAgentResponses } from './agents/llm-runner.js';
import type { AgentPlan, AgentResult, AgentTask, WorkerAgentType, AgenticAgentPrompt } from './agents/types.js';
import { handoff, continueSession, getPlatformSetup } from './adapters/index.js';
import type { SetupPlatform } from './adapters/index.js';
import { runPipeline } from './workflow/pipeline.js';
import type { PipelineStep } from './workflow/pipeline.js';
import { loadPlugins } from './plugins/loader.js';
import { fetchPrDiff } from './github/pr-fetcher.js';
import { discoverProject } from './discover.js';
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync as execSyncTop } from 'node:child_process';

const server = new Server({ name: 'veto', version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

const TOOL_ANNOTATIONS: Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }> = {
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
  veto_docs_fetch:       { readOnlyHint: true,  openWorldHint: true },
  veto_pr_review:        { readOnlyHint: true,  openWorldHint: true },
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
  veto_memory_delete:     { readOnlyHint: false, destructiveHint: true },
  veto_memory_import:     { readOnlyHint: false, destructiveHint: true },
  veto_platform_setup:    { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
  veto_doc_gen:           { readOnlyHint: true },
  veto_type_coverage:     { readOnlyHint: true },
  veto_test_gaps:         { readOnlyHint: true },
  veto_onboard:           { readOnlyHint: true },
  veto_dep_advisor:       { readOnlyHint: true, openWorldHint: true },
  veto_query_advisor:     { readOnlyHint: true },
  veto_bundle_advisor:    { readOnlyHint: true },
  veto_dead_code:         { readOnlyHint: true },
  veto_hitl_checkpoint:   { readOnlyHint: true },
  veto_openapi_gen:       { readOnlyHint: false, destructiveHint: false },
  veto_flag_auditor:      { readOnlyHint: true },
  veto_local_llm:         { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  veto_clone_detector:    { readOnlyHint: true },
  veto_lint_rules:        { readOnlyHint: false, destructiveHint: false },
  veto_api_contract:      { readOnlyHint: false, destructiveHint: false },
  veto_merge_conflict:    { readOnlyHint: false, destructiveHint: false },
  veto_translate:         { readOnlyHint: false, destructiveHint: false },
  veto_a11y_advisor:      { readOnlyHint: true },
  veto_session_replay:    { readOnlyHint: true },
  veto_compose_agents:    { readOnlyHint: false, destructiveHint: false },
  veto_semantic_search:   { readOnlyHint: true },
  veto_sdd_agent:         { readOnlyHint: false, destructiveHint: false },
  veto_notify_ide:        { readOnlyHint: true },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string; inputSchema: object }>;
  return { tools: tools.map(t => ({ ...t, annotations: TOOL_ANNOTATIONS[t.name] ?? {} })) };
});


// ─── Tool handler registry ────────────────────────────────────────────────────
// Migrated, per-domain handlers live in src/server/handlers/*. Anything not yet
// in the registry falls through to the switch below. Both paths share the
// dispatch wrapper (trace logging, error handling) untouched.
const TOOL_REGISTRY: HandlerMap = {
  ...workerHandlers,
  ...memoryHandlers,
  ...observabilityHandlers,
  ...sessionHandlers,
  ...learningHandlers,
  ...watchHandlers,
  ...devtoolsHandlers,
  ...advisorHandlers,
  ...generatorHandlers,
  ...gitHandlers,
};

// Exported so the dispatch can be unit-tested without connecting stdio. Registered
// on the server below; tests call callTool() directly with a synthetic request.
export async function callTool(request: any) {
  const { name, arguments: args } = request.params;
  const callStart = Date.now();
  let resultStatus: 'success' | 'error' = 'success';
  let errorMessage: string | undefined;

  try {
    const response = await (async () => {
      const registered = TOOL_REGISTRY[name];
      if (registered) return await registered({ request, args: request.params.arguments || {}, server });
      switch (name) {
    case 'veto_status': {
      const args = (request.params.arguments || {}) as any;
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
                billing_mode: getConfig().billing_mode,
                ...(getConfig().billing_mode === 'api' ? { billing_warning: 'API billing detected — MCP Sampling calls count toward your token usage. Zero extra cost applies to subscription plans only.' } : {}),
                ...(autoSaveResult?.triggered ? { auto_save: { triggered: true, session_id: autoSaveResult.session_id, usage_pct: autoSaveResult.usage_pct } } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }


    case 'veto_route_task': {
      const args = (request.params.arguments || {}) as any;
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


    case 'veto_council_debate': {
      const args = (request.params.arguments || {}) as any;
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
      const args = (request.params.arguments || {}) as any;
      const agentType = String(args?.agent ?? '') as any;
      const task = String(args?.task ?? '').trim();
      return await handleAgenticWorker('veto_agent_plan', args, agentType, task);
    }


    case 'veto_diff_review': {
      const args = (request.params.arguments || {}) as any;
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      // Resolve diff — use provided or read from git
      let diff = args?.diff ? String(args.diff).trim() : '';
      if (!diff) diff = readGitDiff(projectDir);

      if (!diff) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No diff provided and no git changes detected. Pass diff or point to a project_dir with uncommitted changes.' }) }], isError: true };
      }

      // Parse changed files from diff header lines
      const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
      const diffChunks = diff.split(/^diff --git /m).filter(Boolean);

      const context = buildContextString(projectDir, userContext);
      const scanResult = await runTripleScan(diff, context, true, args?.agent_outputs as any);
      if ('mode' in scanResult && scanResult.mode === 'agentic_loop') return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
      if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult) }] };
      const { reviewResult, secResult, secretsResult, verdict } = scanResult as any;
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



    case 'veto_execute_parallel': {
      const args = (request.params.arguments || {}) as any;
      const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const llmBacked = args?.llm_backed !== false;
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


    case 'veto_platform_setup': {
      const args = (request.params.arguments || {}) as any;
      const platform = String(args?.platform ?? '').trim() as SetupPlatform;
      const vetoServerPath = String(args?.veto_server_path ?? '').trim();
      if (!platform || !vetoServerPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'platform and veto_server_path are required.' }) }], isError: true };
      }
      const setup = getPlatformSetup(platform, vetoServerPath);
      return { content: [{ type: 'text', text: JSON.stringify(setup, null, 2) }] };
    }

    case 'veto_workflow': {
      const args = (request.params.arguments || {}) as any;
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
            const resp = await server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: question } }], maxTokens: 200 } as any);
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


    // ── Phase 13: Developer Intelligence ──────────────────────────────────────

    case 'veto_docs_fetch': {
      const args = (request.params.arguments || {}) as any;
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


        case 'veto_task_parse': {
      const args = (request.params.arguments || {}) as any;
      const description = String(args?.description ?? '').trim();
      const project_dir = args?.project_dir ? String(args.project_dir) : undefined;
      const max_tasks = typeof args?.max_tasks === 'number' ? Math.min(args.max_tasks, 50) : 20;
      if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };
      
      const agentResponse = args?.agent_responses?.planner;
      if (agentResponse) {
         const results = parseAgenticAgentResponses([{ id: 'planner', agent: 'task-planner', task: description }], { planner: agentResponse });
         const r = results[0];
         if (r.plan) {
            const plan = parsePrdIntoTasks(description, r.plan, max_tasks);
            saveTaskPlan(description, JSON.stringify(plan));
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
         }
      }

      // Try sampling
      try {
        const result = await executeOne({ id: 'planner', agent: 'task-planner', task: description, project_dir, llm_backed: true });
        if (result.llm_backed && result.plan && !result.error) {
           const plan = parsePrdIntoTasks(description, result.plan, max_tasks);
           saveTaskPlan(description, JSON.stringify(plan));
           return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
        }
        if (result.llm_upgrade) {
           return { content: [{ type: 'text', text: JSON.stringify({ llm_backed: false, llm_upgrade: result.llm_upgrade }, null, 2) }] };
        }
      } catch { /* fallback */ }

      const plan = await buildTaskPlan(description, project_dir, max_tasks);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
    }

    // ── Phase 14: Observability & Safety ──────────────────────────────────────




    // ── Phase 15: CI/CD & Distribution ────────────────────────────────────────

    case 'veto_ci_gate': {
      const args = (request.params.arguments || {}) as any;
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

      const scanResult = await runTripleScan(diff, fullContext);
      if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
      const { reviewResult: codeResult, secResult, secretsResult, verdict } = scanResult;
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
      const args = (request.params.arguments || {}) as any;
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

      const scanResult = await runTripleScan(diff, prContext);
      if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
      const { reviewResult, secResult, secretsResult, verdict } = scanResult;
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
      const args = (request.params.arguments || {}) as any;
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


    case 'veto_benchmark': {
      const args = (request.params.arguments || {}) as any;
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
      recordOutcome('benchmark', 50, 2, 'council', qMap[debateA.final_verdict] ?? 50);
      recordOutcome('benchmark', 50, 2, 'council', qMap[debateB.final_verdict] ?? 50);

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


    // ── Named Pipelines (Phase 4.2) ──────────────────────────────────────────────

        case 'veto_full_review': {
      const args = (request.params.arguments || {}) as any;
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      let diff = args?.diff ? String(args.diff).trim() : '';
      if (!diff) diff = readGitDiff(projectDir);
      if (!diff) return { content: [{ type: 'text', text: 'No diff provided and git diff failed. Provide a diff or project_dir.' }], isError: true };

      const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
      const context = buildContextString(projectDir, userContext);

      const [scanResult, qualityResult] = await Promise.all([
        runTripleScan(diff, context) as any,
        executeOne({ id: 'quality-1', agent: 'code-quality', task: 'Assess overall code quality and maintainability of these changes', code: diff.slice(0, 8000), context }),
      ]);

      if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
      const { reviewResult, secResult, secretsResult, verdict: scanVerdict } = scanResult;

      const qualityScore = qualityResult.analysis?.score ?? Math.round(qualityResult.output.confidence * 100);
      const verdict = (scanVerdict === 'fail' || qualityScore < 40) ? 'fail'
                    : (scanVerdict === 'warn' || qualityScore < 70) ? 'warn' : 'pass';

      const issues: string[] = [];
      if (verdict === 'fail') {
        if ((reviewResult.analysis?.critical_count ?? 0) > 0) issues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
        if ((secResult.analysis?.critical_count ?? 0) > 0) issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
        if ((secretsResult.analysis?.findings?.length ?? 0) > 0) issues.push('Secrets: exposed credentials detected');
        if (qualityScore < 40) issues.push(`Quality: Score ${qualityScore}/100 is below the critical threshold`);
      }

      if (issues.length > 0) {
        autoStoreCritical(`Full review failed: ${changedFiles.slice(0, 2).join(', ')}`, issues, projectDir, ['full-review']);
      }

      recordOutcome('full-review', 50, 2, 'code-quality', qualityScore);

      return { content: [{ type: 'text', text: JSON.stringify({
        verdict,
        score: qualityScore,
        scans: {
          code_review: { score: reviewResult.analysis?.score ?? null, verdict: reviewResult.analysis?.verdict ?? null, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0, findings: reviewResult.analysis?.findings ?? [] },
          security:    { score: secResult.analysis?.score ?? null, verdict: secResult.analysis?.verdict ?? null, critical: secResult.analysis?.critical_count ?? 0, high: secResult.analysis?.high_count ?? 0, findings: secResult.analysis?.findings ?? [] },
          secrets:     { verdict: secretsResult.analysis?.verdict ?? null, findings: secretsResult.analysis?.findings ?? [] },
        },
        findings: [
          `Quality: ${qualityScore}/100 (${verdict})`,
          `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} (score ${reviewResult.analysis?.score ?? '?'}/100)`,
          `Security: ${secResult.analysis?.verdict ?? 'n/a'} — ${secResult.analysis?.critical_count ?? 0} critical, ${secResult.analysis?.high_count ?? 0} high`,
          `Secrets: ${(secretsResult.analysis?.findings?.length ?? 0) > 0 ? '🔴 Exposed credentials detected' : '✅ Clean'}`,
        ],
        files_changed: changedFiles,
      }, null, 2) }] };
    }

    case 'veto_pre_commit': {
      const args = (request.params.arguments || {}) as any;
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;

      if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

      const diff = readGitDiff(projectDir, true);
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
      recordOutcome('pre-commit', 50, 2, 'secrets',  hasSecrets ? 0 : 100);
      recordOutcome('pre-commit', 50, 2, 'reviewer', reviewResult.analysis?.score ?? Math.round(reviewResult.output.confidence * 100));

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
      const args = (request.params.arguments || {}) as any;
      const description = String(args?.description ?? '').trim();
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const userContext = args?.context ? String(args.context) : undefined;
      const agentResponses = args?.agent_responses as any;

      if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };

      // Step 1: Governance
      const debateInput = { task: description, context: userContext, project_dir: projectDir, strictness: 'standard' as const };
      let debateResult;
      if (agentResponses?.council) {
         debateResult = runFromAgentResponses(debateInput, parseAgentResponses(JSON.stringify(agentResponses.council), description)!);
      } else {
         debateResult = await runLlmDebate(server, debateInput);
      }

      if (debateResult.final_verdict === 'RED') {
        return { content: [{ type: 'text', text: JSON.stringify({ pipeline: 'new_feature', verdict: 'blocked', council: debateResult }, null, 2) }] };
      }

      // Step 2: Planning
      let planResult;
      if (agentResponses?.planner) {
         planResult = parseAgenticAgentResponses([{ id: 'planner', agent: 'task-planner', task: description }], { planner: agentResponses.planner })[0];
      } else {
         planResult = await executeOne({ id: 'planner', agent: 'task-planner', task: description, project_dir: projectDir, llm_backed: true });
      }

      if (planResult.llm_upgrade || (debateResult as any).llm_upgrade) {
         return {
           content: [{
             type: 'text',
             text: JSON.stringify({
               llm_backed: false,
               llm_upgrade: {
                 council: (debateResult as any).llm_upgrade,
                 planner: planResult.llm_upgrade,
               }
             }, null, 2)
           }]
         };
      }

      // Step 3: Tasks
      const tasks = parsePrdIntoTasks(description, planResult.plan!, 10);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, pipeline: 'new_feature', council: debateResult, plan: planResult.plan, tasks }, null, 2) }] };
    }

    case 'veto_delegate': {
      const args = (request.params.arguments || {}) as any;
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

      recordOutcome(task, 50, 2, agentId, Math.round(result.output.confidence * 100));

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

    // ── Phase 7: Intelligence & Advanced ──────────────────────────────────────
    default:          throw new Error(`Unknown tool: ${name}`);
      }
    })();

    if (response && typeof response === 'object' && 'isError' in response && (response as any).isError) {
      resultStatus = 'error';
      errorMessage = (response as any).content?.[0]?.text || 'Unknown MCP error';
      log.warn('tool returned an error result', { tool: name, error: errorMessage });
    }
    return response;
  } catch (err: any) {
    resultStatus = 'error';
    errorMessage = errMsg(err);
    log.error('tool call threw', { tool: name, error: errorMessage });
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
        log.warn('failed to record tool call trace', { tool: name, error: errMsg(logErr) });
      }
    }
  }
}

server.setRequestHandler(CallToolRequestSchema, callTool);

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

// Only connect stdio when run as the entrypoint — importing this module (e.g. in
// tests) registers handlers without starting the transport.
const isEntrypoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    log.error('fatal: server failed to start', { error: errMsg(err) });
    process.exit(1);
  });
}
