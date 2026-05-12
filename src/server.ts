#!/usr/bin/env node
// Veto MCP Server — 45 tools, 16 phases, self-learning router

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
import {
  saveSession, restoreSession, listSessions, closeSession, getDbPath, saveCouncilOutcome,
  storeKnowledge, searchKnowledge, deleteKnowledge,
  updateProjectMap, getProjectMap,
  upsertPattern, getPatterns,
  getContextStatus, fetchAndCacheDocs, saveTaskPlan,
  getUsageStatus, getAuditLog, getHealthStats, CONTEXT_WINDOWS,
  logUsage, getUsageLogs,
} from './memory/local.js';
import { exportMemory, importMemory, getLocalDbSize } from './memory/sync.js';
import { runDebate } from './council/index.js';
import { routeTask, getRateStatus, trackTokens, recordOutcome, getLearningStats, getLearnedThresholds, applyLearnedThresholds, getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights, getRecommendedAgent } from './router/index.js';
import { getConfig, setConfig } from './memory/config.js';
import type { AgentType, Platform } from './router/index.js';
import { executeParallel, executeOne } from './agents/executor.js';
import type { AgentTask, WorkerAgentType } from './agents/types.js';
import { handoff, continueSession, getPlatformSetup } from './adapters/index.js';
import { startWatch, pollWatch, stopWatch, listWatches } from './watcher/index.js';
import { runPipeline } from './workflow/pipeline.js';
import type { PipelineStep } from './workflow/pipeline.js';
import { loadPlugins, listPlugins } from './plugins/loader.js';
import { fetchPrDiff } from './github/pr-fetcher.js';
import { discoverProject } from './discover.js';
import { readFileSync, statSync } from 'node:fs';
import { extname, basename, join, dirname } from 'node:path';
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
}
const autoSave = {
  threshold_pct: 70,
  cooldown_ms: 5 * 60 * 1000, // 5 min between auto-saves
  last_save_at: null as string | null,
  last_session_id: null as string | null,
  cached: null as AutoSaveCache | null,
};

function maybeAutoSave(token_count: number, platform: string): { triggered: boolean; session_id?: string; usage_pct?: number } {
  if (!autoSave.cached) return { triggered: false };
  const window_size = CONTEXT_WINDOWS[platform] ?? 200_000;
  const usage_pct = Math.round((token_count / window_size) * 100);
  if (usage_pct < autoSave.threshold_pct) return { triggered: false };
  if (autoSave.last_save_at) {
    const elapsed = Date.now() - new Date(autoSave.last_save_at).getTime();
    if (elapsed < autoSave.cooldown_ms) return { triggered: false };
  }
  const result = saveSession({ ...autoSave.cached, token_count, platform });
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
  const tools = [
    {
      name: 'veto_status',
      description: 'Returns Veto server status, version, and database info. Pass token_count to trigger auto-save if context usage crosses 70%.',
      inputSchema: {
        type: 'object',
        properties: {
          token_count: {
            type: 'number',
            description: 'Current session token count. If provided and context usage ≥ 70%, Veto auto-saves the last known session context in the background.',
          },
          platform: {
            type: 'string',
            description: 'AI platform (claude, gemini, codex). Used to select the correct context window for threshold calculation. Defaults to "claude".',
            enum: ['claude', 'gemini', 'codex'],
          },
        },
        required: [],
      },
    },
    {
      name: 'veto_autosave_status',
      description: 'Returns the current auto-save state: whether a context is cached, the threshold, the last auto-save time, and the session ID.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_session_save',
      description:
        'Saves the current session context to SQLite for later restoration across AI platforms.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A brief summary of what was accomplished this session.',
          },
          context: {
            type: 'string',
            description: 'Key context to restore (decisions, current task, file list, etc.).',
          },
          task_state: {
            type: 'string',
            description: 'Current task state — what is done and what is next.',
          },
          platform: {
            type: 'string',
            description: 'AI platform used (claude, gemini, codex). Defaults to "claude".',
            enum: ['claude', 'gemini', 'codex'],
          },
          project_dir: {
            type: 'string',
            description: 'Absolute path to the current project directory.',
          },
          connection_type: {
            type: 'string',
            description: 'How you are connected to this AI — "subscription" (Claude Pro, Gemini Advanced) or "api" (API key). Used for usage tracking.',
            enum: ['subscription', 'api'],
          },
          token_count: {
            type: 'number',
            description: 'Approximate tokens used this session. Veto uses this for context window monitoring.',
          },
        },
        required: ['summary', 'context'],
      },
    },
    {
      name: 'veto_session_restore',
      description:
        'Restores a previously saved session by ID. Use veto_sessions_list to find IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'UUID of the session to restore.',
          },
          resuming_as: {
            type: 'string',
            description: 'The AI client resuming this session (e.g. "claude", "gemini", "codex"). Recorded as active_client.',
            enum: ['claude', 'gemini', 'codex'],
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'veto_sessions_list',
      description: 'Lists the most recent saved sessions (up to 10).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of sessions to return (default 10, max 50).',
          },
        },
        required: [],
      },
    },
    {
      name: 'veto_route_task',
      description:
        'Scores a task for complexity (0-100) and returns the optimal tier, model recommendation, and rate status. Use before any substantial task to let the router decide which model to use.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task description to score and route.',
          },
          agent_type: {
            type: 'string',
            description: 'Optional agent type — some agents are tier-locked regardless of score.',
            enum: [
              'lead-developer', 'system-architect', 'security-scanner',
              'devil-advocate', 'decision-engine', 'risk-assessor',
              'coder', 'tester', 'reviewer', 'database', 'documentation',
              'file-manager', 'git-agent', 'search-agent', 'secrets', 'reporter',
              'dynamic',
            ],
          },
          files_affected: {
            type: 'number',
            description: 'Number of files the task will touch (influences complexity score).',
          },
          force_council: {
            type: 'boolean',
            description: 'Set true to force a Tier 3 / council-required routing.',
          },
          context: {
            type: 'string',
            description: 'Current context text — router will return a compression plan.',
          },
          preferred_platform: {
            type: 'string',
            description: 'Preferred AI platform. Router may override if rate-limited.',
            enum: ['claude', 'gemini', 'codex'],
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'veto_rate_status',
      description: 'Returns current request counts and rate limit status for all AI platforms tracked by Veto.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_council_debate',
      description:
        'Runs the Veto Council — 5 specialist agents (Lead Dev, PM, Architect, UX, Devil\'s Advocate) debate your task in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict before any code is written. Call this before architecture decisions, security-sensitive work, database migrations, or any task the router scores above 71.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task or decision to debate. Be specific — include approach, tech stack, and constraints.',
          },
          context: {
            type: 'string',
            description: 'Optional: additional context such as codebase state, prior decisions, or constraints.',
          },
          project_dir: {
            type: 'string',
            description: 'Optional: absolute path to the project directory. Veto will auto-read package.json, git diff, and stack info to give the council real project context.',
          },
          session_id: {
            type: 'string',
            description: 'Optional: session ID to associate this council outcome with an active session.',
          },
          max_tokens: {
            type: 'number',
            description: 'Optional: token budget for this operation. Veto estimates output tokens and warns in the response if the estimate exceeds this limit. Logged to usage_log for tracking.',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'veto_agent_plan',
      description: 'Gets a domain-expert execution plan from a specific worker agent. Returns approach, ordered steps, checklist, patterns, and pitfalls for the task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'The worker agent to consult.',
            enum: ['coder','reviewer','tester','debugger','refactor','database','api','frontend','backend','devops','performance','migration','security-scanner','auth','privacy','secrets','dependency-audit','penetration','context-manager','decision-logger','project-mapper','pattern-learner','knowledge-base','researcher','tech-advisor','cost-analyzer','competitor-analyzer','risk-assessor','estimator','ethics-bias','code-quality','documentation','accessibility','compatibility','error-handling','task-planner','task-coordinator','file-manager','git-agent','search-agent','reporter','automation'],
          },
          task: { type: 'string', description: 'The task for the agent to plan.' },
          context: { type: 'string', description: 'Optional additional context.' },
          project_dir: { type: 'string', description: 'Optional: absolute path to the project directory. Auto-injects package.json, git diff, and stack info into the agent context.' },
        },
        required: ['agent', 'task'],
      },
    },
    {
      name: 'veto_code_review',
      description: 'Runs the Code Reviewer agent on provided code. Returns scored findings (complexity, error handling, magic numbers, nesting, dead code) with severity and fixes.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to review.' },
          context: { type: 'string', description: 'Optional: file name, module description, or review focus.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'veto_diff_review',
      description: 'Reviews a git diff — runs code review, security scan, and secrets scan in parallel across all changed files. Returns a structured verdict (pass/warn/fail), per-file findings, and a CI-ready summary. Pass diff directly or let Veto read it from project_dir automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          diff: { type: 'string', description: 'The git diff to review. If omitted, Veto runs git diff HEAD in project_dir.' },
          project_dir: { type: 'string', description: 'Absolute project path. Used to auto-read git diff if diff is not provided, and to inject codebase context.' },
          context: { type: 'string', description: 'Optional: PR description, ticket number, or focus area.' },
        },
        required: [],
      },
    },
    {
      name: 'veto_security_scan',
      description: 'Runs the Security Scanner (OWASP Top 10) on provided code. Returns vulnerabilities with severity, CWE/OWASP category, and remediation steps.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to scan.' },
          context: { type: 'string', description: 'Optional: language, framework, or specific concerns.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'veto_secrets_scan',
      description: 'Scans text or code for exposed credentials — API keys, tokens, passwords, connection strings, private keys. Returns findings with masked values and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text or code to scan for secrets.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'veto_execute_parallel',
      description: 'Runs multiple worker agents simultaneously via Promise.all. Use to get domain expert input from several agents in one round-trip — e.g. coder + tester + security-scanner all planning the same feature together.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'List of agent tasks to run in parallel.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique ID for this task (use any string).' },
                agent: { type: 'string', description: 'Worker agent type.' },
                task: { type: 'string', description: 'Task description for this agent.' },
                code: { type: 'string', description: 'Optional code to analyze (triggers analyze() instead of plan()).' },
                context: { type: 'string', description: 'Optional additional context.' },
                project_dir: { type: 'string', description: 'Optional: per-task project dir override.' },
              },
              required: ['id', 'agent', 'task'],
            },
          },
          project_dir: { type: 'string', description: 'Optional: project directory applied to all tasks (per-task project_dir overrides this). Auto-injects codebase context.' },
          max_tokens: {
            type: 'number',
            description: 'Optional: token budget for this parallel execution. Veto estimates combined output tokens and warns if the estimate exceeds this limit. Logged to usage_log.',
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'veto_memory_store',
      description: 'Stores a knowledge entry (solution, pattern, error, reference, or decision) in the local knowledge base for retrieval across sessions. Search before storing to avoid duplicates.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Precise, searchable title. Bad: "Fixed bug". Good: "Fix: Node sqlite fails on Windows without --experimental-sqlite".' },
          content: { type: 'string', description: 'Self-contained content: problem → root cause → solution. Future agents must understand it without original context.' },
          type: {
            type: 'string',
            description: 'Entry type.',
            enum: ['solution', 'pattern', 'context', 'error', 'reference', 'decision'],
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Search tags (3–5 recommended). Examples: ["typescript", "auth", "jwt"].' },
          project_dir: { type: 'string', description: 'Absolute project path. Include for project-specific knowledge; omit for general programming knowledge.' },
          session_id: { type: 'string', description: 'Optional: associate this knowledge entry with an active session.' },
          relevance: { type: 'number', description: 'Initial relevance score 0.0–1.0 (default 1.0).' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'veto_memory_search',
      description: 'Searches the local knowledge base for entries matching a query. Call at the start of every task to find prior solutions before solving from scratch.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms (full-text search on title and content).' },
          type: {
            type: 'string',
            description: 'Filter by entry type.',
            enum: ['solution', 'pattern', 'context', 'error', 'reference', 'decision'],
          },
          project_dir: { type: 'string', description: 'Filter to a specific project directory.' },
          limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
        },
        required: [],
      },
    },
    {
      name: 'veto_memory_delete',
      description: 'Deletes a knowledge entry by ID. Use to remove stale or duplicate entries found via veto_memory_search.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The knowledge entry ID (from veto_memory_search results).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'veto_project_map_update',
      description: 'Updates the project structure map for a directory. Call after creating, deleting, or moving files. The map enables fast codebase navigation without filesystem scans.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute path to the project root.' },
          structure: { type: 'string', description: 'JSON string representing the directory tree. Example: {"src/":{"agents/":["coder.ts","reviewer.ts"],"router/":["index.ts"]}}' },
          key_modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'The 10–20 most important files with their roles. Example: ["src/server.ts (MCP entry point)", "src/router/index.ts (task router)"].',
          },
          tech_stack: {
            type: 'array',
            items: { type: 'string' },
            description: 'Frameworks and key libraries. Example: ["TypeScript", "Node.js 22", "Express", "SQLite"].',
          },
        },
        required: ['project_dir', 'structure'],
      },
    },
    {
      name: 'veto_project_map_get',
      description: 'Returns the stored project structure map for a directory. Use to navigate the codebase without scanning the filesystem.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute path to the project root.' },
        },
        required: ['project_dir'],
      },
    },
    {
      name: 'veto_pattern_store',
      description: 'Stores or updates a coding pattern observed in the codebase. Patterns are keyed by category.pattern-name and confidence increases with repeated observation.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern_key: { type: 'string', description: 'Pattern identifier in category.pattern-name format. Example: "code.async-pattern" or "naming.variable-case".' },
          pattern_val: { type: 'string', description: 'The observed pattern value. Example: "async/await with try/catch, no raw Promise chains".' },
          confidence: { type: 'number', description: 'Confidence score 0.0–1.0 (default 1.0). Increases automatically on repeated observation.' },
        },
        required: ['pattern_key', 'pattern_val'],
      },
    },
    {
      name: 'veto_patterns_list',
      description: 'Returns stored coding patterns. Filter by prefix to get patterns in a specific category (e.g. prefix="naming." for all naming conventions).',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional prefix filter. Example: "code." or "naming." or "testing.".' },
          limit: { type: 'number', description: 'Max patterns to return (default 20).' },
        },
        required: [],
      },
    },
    {
      name: 'veto_memory_export',
      description: 'Exports all local memory (sessions, knowledge, patterns, decisions, project maps) to a portable JSON file. Copy the file to another machine and run veto_memory_import there to resume work. No external services required.',
      inputSchema: {
        type: 'object',
        properties: {
          output_path: {
            type: 'string',
            description: 'Where to write the export file. Defaults to ~/.veto/veto-export.json. Use a path on shared storage (Dropbox, OneDrive, USB) to make transfer easy.',
          },
        },
        required: [],
      },
    },
    {
      name: 'veto_memory_import',
      description: 'Imports memory from a JSON file exported by veto_memory_export on another machine. Merges into local SQLite using INSERT OR IGNORE — existing local rows are never overwritten. Call veto_sessions_list after import to confirm sessions arrived.',
      inputSchema: {
        type: 'object',
        properties: {
          input_path: {
            type: 'string',
            description: 'Path to the export JSON file. Defaults to ~/.veto/veto-export.json.',
          },
        },
        required: [],
      },
    },
    {
      name: 'veto_record_outcome',
      description: 'Records a task outcome (quality score) to feed the self-learning router. Call after completing any task. After 20+ outcomes, call veto_learning_apply to update tier thresholds.',
      inputSchema: {
        type: 'object',
        properties: {
          task_type: { type: 'string', description: 'Short consistent label for the task category (e.g. "write-unit-tests", "fix-auth-bug"). Use the same label for similar tasks to enable pattern detection.' },
          complexity: { type: 'number', description: 'The complexity score from veto_route_task (0–100).' },
          model_tier: { type: 'number', description: 'The tier that was actually used (1, 2, or 3).', enum: [1, 2, 3] },
          output_quality: { type: 'number', description: 'Output quality score 0–100. 90–100=excellent, 70–89=good, 50–69=acceptable, 30–49=poor, 0–29=failed.' },
          agent: { type: 'string', description: 'The worker agent type used (optional but useful for agent performance tracking).' },
          tokens_used: { type: 'number', description: 'Approximate tokens used (optional).' },
          file_ext: { type: 'string', description: 'File extension of the primary file worked on (e.g. ".ts", ".sql", ".tsx"). Enables predictive agent routing — next time you work on the same extension, veto_route_task will recommend the best agent.' },
        },
        required: ['task_type', 'complexity', 'model_tier', 'output_quality'],
      },
    },
    {
      name: 'veto_learning_stats',
      description: 'Returns the self-learning router dashboard: tier distribution, per-agent quality stats, suggested threshold adjustments, and council insights. Use to understand how the router is performing and where to improve.',
      inputSchema: {
        type: 'object',
        properties: {
          include_agent_stats: { type: 'boolean', description: 'Include per-agent quality breakdown (default true).' },
          include_task_types: { type: 'boolean', description: 'Include per-task-type breakdown (default false, verbose).' },
          include_council_insights: { type: 'boolean', description: 'Include council decision → debugging correlation (default false).' },
        },
        required: [],
      },
    },
    {
      name: 'veto_learning_apply',
      description: 'Applies learned tier thresholds to the router based on recorded task outcomes. Requires at least 20 recorded outcomes. The router immediately uses the new thresholds on the next veto_route_task call.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_handoff',
      description: 'Saves the current session and returns step-by-step instructions to continue on another AI platform (Gemini or Codex). Call this when Claude is approaching its rate limit. The receiving platform calls veto_continue to restore full context instantly.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What was accomplished this session — one or two sentences.' },
          context: { type: 'string', description: 'Key context the next platform needs: active decisions, file paths, constraints.' },
          task_state: { type: 'string', description: 'Current task state — what is done, what is in progress, what is next.' },
          from_platform: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'Platform handing off (default: claude).' },
          to_platform: { type: 'string', enum: ['gemini', 'codex', 'claude'], description: 'Target platform. If omitted, Veto picks the platform with the most headroom.' },
          project_dir: { type: 'string', description: 'Absolute path to the current project directory.' },
          token_count: { type: 'number', description: 'Approximate tokens used this session.' },
        },
        required: ['summary', 'context'],
      },
    },
    {
      name: 'veto_continue',
      description: 'Restores the most recent session on any platform. Call this immediately after switching platforms — Veto returns the full context, summary, and next action. Nothing needs to be re-explained.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Optional. Session ID from veto_handoff. If omitted, the most recent saved session is restored.' },
          resuming_as: { type: 'string', description: 'The AI client resuming this session (e.g. "gemini"). Recorded as active_client so you can track which tool is currently working on it.', enum: ['claude', 'gemini', 'codex'] },
        },
        required: [],
      },
    },
    {
      name: 'veto_platform_setup',
      description: 'Returns the exact MCP config and setup steps to connect a specific AI platform to this Veto server.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'The platform to get setup instructions for.' },
          veto_server_path: { type: 'string', description: 'Absolute path to the built veto server (dist/server.js).' },
        },
        required: ['platform', 'veto_server_path'],
      },
    },
    {
      name: 'veto_watch',
      description: 'Starts a file watcher on a project directory. Returns a watch_id. Call veto_watch_poll to collect file-change events with recommended agents. Call veto_watch_stop when done.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute path to the project directory to watch.' },
        },
        required: ['project_dir'],
      },
    },
    {
      name: 'veto_watch_poll',
      description: 'Polls for file-change events from an active watcher. Returns accumulated events since last poll (events are cleared on read). Each event includes the file, recommended agent, and suggested veto tool to call.',
      inputSchema: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: 'The watch_id returned by veto_watch.' },
        },
        required: ['watch_id'],
      },
    },
    {
      name: 'veto_watch_stop',
      description: 'Stops an active file watcher.',
      inputSchema: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: 'The watch_id returned by veto_watch.' },
        },
        required: ['watch_id'],
      },
    },
    {
      name: 'veto_workflow',
      description: 'Runs a sequential agent pipeline with optional pass/fail gates between steps. Each step runs a worker agent; if a gate score is set and the step confidence falls below it, the pipeline stops. Returns per-step results plus an overall verdict (passed/partial/failed).',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered pipeline steps.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Step identifier.' },
                agent: { type: 'string', description: 'Worker agent type.' },
                task: { type: 'string', description: 'Task description for this step.' },
                code: { type: 'string', description: 'Optional code to analyze.' },
                context: { type: 'string', description: 'Optional context.' },
                gate: { type: 'number', description: 'Optional minimum confidence % (0–100) required to proceed to the next step.' },
              },
              required: ['id', 'agent', 'task'],
            },
          },
          project_dir: { type: 'string', description: 'Optional project directory — auto-injects codebase context into all steps.' },
        },
        required: ['steps'],
      },
    },
    {
      name: 'veto_explain',
      description: 'Reads a file and returns an expert explanation from the most appropriate agent (auto-detected from file extension and name). Pass depth to control detail level.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to explain.' },
          depth: { type: 'string', enum: ['overview', 'detailed', 'line-by-line'], description: 'Explanation depth. Default: overview.' },
          context: { type: 'string', description: 'Optional additional context about what you want explained.' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'veto_plugins',
      description: 'Lists all custom agents loaded from ~/.veto/agents/. Drop a .js file there that exports plan(task, context?) to register a new agent available in veto_agent_plan and veto_execute_parallel.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    // ── Phase 13: Developer Intelligence ──────────────────────────────────────
    {
      name: 'veto_docs_fetch',
      description: 'Fetches current, version-accurate documentation for any npm, PyPI, or crates.io package and returns it for injection into agent context. Eliminates hallucinated APIs. Results are cached for 24 hours.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: { type: 'string', description: 'Package name (e.g. "react", "requests", "serde").' },
          ecosystem:    { type: 'string', enum: ['npm', 'pypi', 'crates'], description: 'Package ecosystem.' },
          version:      { type: 'string', description: 'Specific version. Defaults to latest.' },
          max_chars:    { type: 'number', description: 'Max characters to return (default 8000). Higher = more complete docs, more tokens.' },
        },
        required: ['package_name', 'ecosystem'],
      },
    },
    {
      name: 'veto_context_status',
      description: 'Returns the context window usage for a saved session — tokens used, % of platform limit consumed, and whether to compress or hand off before the window fills.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID to check.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'veto_task_parse',
      description: 'Parses a plain-English project description or PRD into a structured task DAG with dependencies, complexity scores, priorities, and suggested agent assignments. Feeds directly into veto_workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Project description, PRD, or feature brief to parse into tasks.' },
          project_dir:  { type: 'string', description: 'Optional project directory for codebase context injection.' },
          max_tasks:    { type: 'number', description: 'Maximum number of tasks to generate (default 20).' },
        },
        required: ['description'],
      },
    },
    // ── Phase 14: Observability & Safety ──────────────────────────────────────
    {
      name: 'veto_usage_status',
      description: 'Live AI usage dashboard. Shows tokens consumed today, requests per platform, subscription vs API usage split, 7-day history, and warnings when approaching limits.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_audit_log',
      description: 'Queryable log of every council verdict, decision, and session event. Filter by session, agent, verdict, or date. Essential for tracing what happened and why.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Filter to a specific session.' },
          verdict:    { type: 'string', description: 'Filter by council verdict (GREEN, YELLOW, RED).' },
          since:      { type: 'string', description: 'ISO date — only return events after this time.' },
          limit:      { type: 'number', description: 'Max events to return (default 20, max 100).' },
        },
        required: [],
      },
    },
    {
      name: 'veto_health',
      description: 'Returns a live health snapshot of the Veto server — DB size, session/memory/pattern counts, uptime, error count, and average council latency.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    // ── Phase 15: CI/CD & Distribution ────────────────────────────────────────
    {
      name: 'veto_ci_gate',
      description: 'CI/CD pipeline gate. Runs code review + security scan + secrets scan on a git diff and returns a structured pass/warn/fail verdict with exit code. Ready for GitHub Actions and GitLab CI.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute project path. Veto reads git diff HEAD automatically.' },
          diff:        { type: 'string', description: 'Optional: pass a diff string directly instead of reading from project_dir.' },
          context:     { type: 'string', description: 'Optional: PR description or ticket number for context.' },
          fail_on:     { type: 'string', enum: ['warn', 'fail'], description: 'Whether WARN counts as a failure (exit code 1). Default: "fail" — only FAIL exits non-zero.' },
        },
        required: ['project_dir'],
      },
    },
    {
      name: 'veto_pr_review',
      description: 'Fetches a GitHub PR diff and runs the full Veto triple-scan (code review + security + secrets). Returns a structured verdict and ready-to-post GitHub review comments. Set GITHUB_TOKEN env var for private repos.',
      inputSchema: {
        type: 'object',
        properties: {
          pr_url:  { type: 'string', description: 'Full GitHub PR URL. e.g. https://github.com/owner/repo/pull/123' },
          context: { type: 'string', description: 'Optional: PR description or ticket number for extra context.' },
          fail_on: { type: 'string', enum: ['warn', 'fail'], description: 'Whether WARN counts as a failure. Default: "fail".' },
        },
        required: ['pr_url'],
      },
    },
    // ── Phase 16: Workspace Discovery & Summarization ─────────────────────────
    {
      name: 'veto_discover',
      description: 'Scans a project directory and builds a rich context map: git state, tech stack, file structure, dependencies, and key config files. Stores the result in Veto memory so agents always have accurate project context. Call this once per project or after major structural changes.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute path to the project directory to scan.' },
          depth: { type: 'string', enum: ['quick', 'standard', 'full'], description: 'Scan depth. quick: git + package metadata only. standard: + file tree up to 3 levels (default). full: + contents of key config files.' },
          store: { type: 'boolean', description: 'Whether to store the discovery in Veto memory as a project map. Default: true.' },
        },
        required: ['project_dir'],
      },
    },
    {
      name: 'veto_summarize',
      description: 'Generates a concise expert briefing of a project, directory, or file. Use at the start of a session to orient yourself on unfamiliar code. Returns bullet-point summary, key components, tech stack, and entry points. Faster and higher-level than veto_explain.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string', description: 'Absolute path to a project directory to summarize.' },
          file_path:   { type: 'string', description: 'Absolute path to a single file to summarize. If both project_dir and file_path are given, file_path takes precedence.' },
          focus:       { type: 'string', description: 'Optional focus area: e.g. "security", "APIs", "data flow", "architecture". Narrows the summary.' },
          format:      { type: 'string', enum: ['brief', 'detailed'], description: 'brief: 4–6 bullet points (default). detailed: paragraph-level prose.' },
        },
        required: [],
      },
    },
  ];
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
  return { reviewResult, secResult, secretsResult, verdict };
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'veto_status': {
      const statusTokenCount = typeof args?.token_count === 'number' ? args.token_count : null;
      const statusPlatform = args?.platform ? String(args.platform) : 'claude';
      if (statusTokenCount !== null && statusTokenCount > 0) {
        trackTokens(statusPlatform as Platform, statusTokenCount);
      }
      const autoSaveResult = statusTokenCount !== null ? maybeAutoSave(statusTokenCount, statusPlatform) : null;
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
            note: 'Auto-save fires when veto_status is called with token_count ≥ threshold_pct% of context window.',
          }, null, 2),
        }],
      };
    }

    case 'veto_session_save': {
      const sessionProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      if (sessionProjectDir) activeProjectDir = sessionProjectDir;
      const savePlatform = args?.platform ? String(args.platform) : 'claude';
      const saveSummary = String(args?.summary ?? '');
      const saveContext = String(args?.context ?? '');
      const saveTaskState = args?.task_state ? String(args.task_state) : undefined;
      const result = saveSession({
        summary: saveSummary,
        context: saveContext,
        task_state: saveTaskState,
        platform: savePlatform,
        connection_type: args?.connection_type ? String(args.connection_type) : 'subscription',
        project_dir: sessionProjectDir,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
      });
      // Cache for auto-save: future veto_status calls with high token_count will re-save this context
      autoSave.cached = { summary: saveSummary, context: saveContext, task_state: saveTaskState, platform: savePlatform, project_dir: sessionProjectDir };
      autoSave.last_save_at = result.saved_at;
      autoSave.last_session_id = result.session_id;

      const responseObj: Record<string, unknown> = {
        success: true,
        message: result.context_warning
          ? `⚠️ Context at ${result.usage_pct}% — consider handing off soon.`
          : 'Session saved. Use this ID to restore on any AI platform.',
        session_id: result.session_id,
        saved_at: result.saved_at,
        usage_pct: result.usage_pct,
        context_warning: result.context_warning,
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                session_id: s.id,
                created_by: s.platform,
                active_client: s.active_client ?? s.platform,
                last_resumed_at: s.last_resumed_at,
                started_at: s.started_at,
                ended_at: s.ended_at,
                project_dir: s.project_dir,
                summary: s.summary,
                context: s.context ? JSON.parse(s.context) : null,
                task_state: s.task_state ? JSON.parse(s.task_state) : null,
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
      const sessions = listSessions(limit);

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

      const debateStart = Date.now();
      const result = runDebate({
        task,
        context: args?.context ? String(args.context) : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
      });
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

      const responsePayload = {
        outcome_id: outcomeId,
        final_verdict: result.final_verdict,
        block_reasons: result.block_reasons,
        warnings: result.warnings,
        recommended: result.recommended,
        debated_at: result.debated_at,
        votes: {
          lead_dev: result.votes.lead_dev.verdict,
          pm: result.votes.pm.verdict,
          architect: result.votes.architect.verdict,
          ux: result.votes.ux.verdict,
          devil: result.votes.devil.verdict,
          legal: result.votes.legal.verdict,
          security: result.votes.security.verdict,
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
      return { content: [{ type: 'text', text: JSON.stringify({ ...(result.plan ?? result.analysis), output: result.output }, null, 2) }] };
    }

    case 'veto_code_review': {
      const code = String(args?.code ?? '').trim();
      if (!code) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'code is required.' }) }], isError: true };
      }
      const result = await executeOne({ id: 'review-1', agent: 'reviewer', task: 'review this code', code, context: args?.context ? String(args.context) : undefined });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
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
      const result = await executeOne({ id: 'scan-1', agent: 'security-scanner', task: 'scan this code for security issues', code, context: args?.context ? String(args.context) : undefined });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis, null, 2) }] };
    }

    case 'veto_secrets_scan': {
      const text = String(args?.text ?? '').trim();
      if (!text) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'text is required.' }) }], isError: true };
      }
      const result = await executeOne({ id: 'secrets-1', agent: 'secrets', task: 'scan for exposed credentials', code: text });
      if (result.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }) }], isError: true };
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

      const parallelPayload: Record<string, unknown> = {
        count: results.length,
        total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
        results: results.map(r => ({
          id: r.id,
          agent: r.agent,
          duration_ms: r.duration_ms,
          error: r.error,
          output: { ...(r.plan ?? r.analysis), structured: r.output },
        })),
      };

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
      const structure = String(args?.structure ?? '').trim();
      if (!project_dir || !structure) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir and structure are required.' }) }], isError: true };
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
      const platform = String(args?.platform ?? '').trim() as Platform;
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
      const result = exportMemory(args?.output_path ? String(args.output_path) : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_memory_import': {
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'veto_explain': {
      const filePath = String(args?.file_path ?? '').trim();
      if (!filePath) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'file_path is required.' }) }], isError: true };

      let fileContent: string;
      try {
        fileContent = readFileSync(filePath, 'utf8');
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read file: ${filePath}` }) }], isError: true };
      }

      const ext = extname(filePath).toLowerCase();
      const name_ = basename(filePath).toLowerCase();
      const depth = String(args?.depth ?? 'overview');

      // auto-detect best agent
      let agent: WorkerAgentType = 'coder';
      if (['.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) agent = 'frontend';
      else if (['.sql', '.prisma'].includes(ext) || name_.includes('schema')) agent = 'database';
      else if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(name_)) agent = 'tester';
      else if (['.yaml', '.yml', '.toml', '.dockerfile'].includes(ext) || name_ === 'dockerfile') agent = 'devops';
      else if (name_.includes('auth') || name_.includes('login') || name_.includes('jwt') || name_.includes('token')) agent = 'auth';
      else if (name_.includes('security') || name_.includes('crypt')) agent = 'security-scanner';
      else if (['.ts', '.js', '.mjs'].includes(ext)) agent = 'coder';

      const userContext = args?.context ? String(args.context) : undefined;
      const task = `Explain this ${ext} file at ${depth} depth. File: ${basename(filePath)}${userContext ? `. Focus: ${userContext}` : ''}`;

      const result = await executeOne({ id: 'explain-1', agent, task, code: fileContent, project_dir: undefined });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          file: filePath, agent_used: agent, depth,
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

      const hash = createHash('sha256').update(description).digest('hex').slice(0, 16);
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

      if (discoverStore) {
        updateProjectMap({
          project_dir: result.project_dir,
          structure: { ecosystems: result.ecosystems, key_files: result.key_files, file_count_by_ext: result.file_counts, total_files: result.total_files, scanned_at: result.scanned_at },
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

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, stored: discoverStore, ...result }, null, 2) }] };
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
      description: 'List of all saved Veto sessions across AI platforms.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://project-map',
      name: 'Project Map',
      description: 'Stored project structure maps. Append ?dir=<absolute_path> to filter by project.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://memory',
      name: 'Knowledge Base',
      description: 'All stored knowledge entries. Append ?q=<query> to search.',
      mimeType: 'application/json',
    },
    {
      uri: 'veto://patterns',
      name: 'Learned Patterns',
      description: 'Coding patterns Veto has learned from your sessions.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const url = new URL(uri);

  if (url.host === 'sessions') {
    const sessions = listSessions(50);
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

  if (url.host === 'memory') {
    const q = url.searchParams.get('q') ?? undefined;
    const results = searchKnowledge({ query: q, limit: 20 });
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
    const patterns = getPatterns(undefined, 50);
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Veto MCP server v${VERSION} running (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
