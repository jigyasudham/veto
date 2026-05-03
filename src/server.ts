#!/usr/bin/env node
// Veto MCP Server — Phase 1 skeleton
// Exposes: veto_status, veto_session_save, veto_session_restore, veto_sessions_list

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
  saveSession, restoreSession, listSessions, getDbPath, saveCouncilOutcome,
  storeKnowledge, searchKnowledge, deleteKnowledge,
  updateProjectMap, getProjectMap,
  upsertPattern, getPatterns,
} from './memory/local.js';
import { exportMemory, importMemory, getLocalDbSize } from './memory/sync.js';
import { runDebate } from './council/index.js';
import { routeTask, getRateStatus, recordOutcome, getLearningStats, applyLearnedThresholds, getAgentPerformanceStats, getTaskTypeBreakdown, getCouncilInsights, getRecommendedAgent } from './router/index.js';
import type { AgentType, Platform } from './router/index.js';
import { executeParallel, executeOne } from './agents/executor.js';
import type { AgentTask, WorkerAgentType } from './agents/types.js';
import { handoff, continueSession, getPlatformSetup } from './adapters/index.js';
import { startWatch, pollWatch, stopWatch, listWatches } from './watcher/index.js';
import { runPipeline } from './workflow/pipeline.js';
import type { PipelineStep } from './workflow/pipeline.js';
import { loadPlugins, listPlugins } from './plugins/loader.js';
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';

const VERSION = '1.0.0';

// Tracks the project_dir of the most recently active session in this process.
// Used as a fallback when memory_store/memory_search are called without an explicit project_dir,
// so memories are automatically scoped to the current project.
let activeProjectDir: string | null = null;

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

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'veto_status',
      description: 'Returns Veto server status, version, and database info.',
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
          token_count: {
            type: 'number',
            description: 'Approximate tokens used this session.',
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
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'veto_status': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'running',
                version: VERSION,
                server: 'veto',
                phase: 8,
                capabilities: ['session_save', 'session_restore', 'router', 'rate_monitor', 'council_debate', 'agent_plan', 'code_review', 'security_scan', 'secrets_scan', 'parallel_exec', 'memory_store', 'memory_search', 'project_map', 'pattern_store', 'memory_export', 'memory_import', 'learning_stats', 'learning_apply', 'record_outcome', 'handoff', 'continue', 'platform_setup'],
                db_path: getDbPath(),
                uptime_ms: process.uptime() * 1000,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_session_save': {
      const sessionProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
      if (sessionProjectDir) activeProjectDir = sessionProjectDir;
      const result = saveSession({
        summary: String(args?.summary ?? ''),
        context: String(args?.context ?? ''),
        task_state: args?.task_state ? String(args.task_state) : undefined,
        platform: args?.platform ? String(args.platform) : 'claude',
        project_dir: sessionProjectDir,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Session saved. Use this ID to restore on any AI platform.',
                ...result,
              },
              null,
              2
            ),
          },
        ],
      };
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

      const result = await runDebate({
        task,
        context: args?.context ? String(args.context) : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
      });

      const outcomeId = saveCouncilOutcome({
        session_id: args?.session_id ? String(args.session_id) : undefined,
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
      });

      return {
        content: [
          {
            type: 'text',
            text: result.formatted_output + '\n\n' + JSON.stringify(
              {
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
              },
              null,
              2
            ),
          },
        ],
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
        const { execSync: execSyncDiff } = await import('node:child_process');
        try {
          diff = execSyncDiff('git diff HEAD --no-color', {
            cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
          }).toString().trim();
          if (!diff) {
            diff = execSyncDiff('git diff --cached --no-color', {
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

      // Run code-review, security-scan, secrets-scan in parallel across the full diff
      const context = buildContextString(projectDir, userContext);
      const [reviewResult, secResult, secretsResult] = await Promise.all([
        executeOne({ id: 'diff-review', agent: 'reviewer', task: 'Review this git diff for code quality issues', code: diff, context }),
        executeOne({ id: 'diff-sec', agent: 'security-scanner', task: 'Scan this git diff for security vulnerabilities', code: diff, context }),
        executeOne({ id: 'diff-secrets', agent: 'secrets', task: 'Scan this git diff for exposed secrets or credentials', code: diff }),
      ]);

      // Derive overall verdict
      const hasBlocking = (reviewResult.analysis?.critical_count ?? 0) > 0
        || (secResult.analysis?.critical_count ?? 0) > 0
        || (secretsResult.analysis?.critical_count ?? 0) > 0;
      const hasWarnings = (reviewResult.analysis?.high_count ?? 0) > 0
        || (secResult.analysis?.high_count ?? 0) > 0;
      const verdict = hasBlocking ? 'fail' : hasWarnings ? 'warn' : 'pass';
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: results.length,
            total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
            results: results.map(r => ({
              id: r.id,
              agent: r.agent,
              duration_ms: r.duration_ms,
              error: r.error,
              output: { ...(r.plan ?? r.analysis), structured: r.output },
            })),
          }, null, 2),
        }],
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
      const result = handoff({
        summary,
        context,
        task_state: args?.task_state ? String(args.task_state) : undefined,
        from_platform: args?.from_platform ? String(args.from_platform) as Platform : 'claude',
        to_platform: args?.to_platform ? String(args.to_platform) as Platform : undefined,
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
      });
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
      const result: Record<string, unknown> = {
        total_outcomes: stats.total_tasks,
        tier_breakdown: stats.tier_breakdown,
        current_thresholds: { tier1_max: 30, tier2_max: 70, note: 'defaults — call veto_learning_apply to update from data' },
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
