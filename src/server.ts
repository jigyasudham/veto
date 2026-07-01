#!/usr/bin/env node
// Veto MCP Server — 92 tools, LLM council + auto-learning router

// Suppress node:sqlite experimental warning — it would corrupt the MCP stdio protocol
process.removeAllListeners('warning');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { isCompactMode, getCompactToolList, findTools } from './tools/compact.js';
import { log, errMsg } from './log.js';
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
import { reviewHandlers } from './server/handlers/review.js';
import { coreHandlers } from './server/handlers/core.js';
import { agentHandlers } from './server/handlers/agents.js';
import { councilHandlers } from './server/handlers/council.js';
import { VERSION, autoSave } from './server/runtime.js';
import { listSessions, searchKnowledge, getProjectMap, getPatterns, recordToolCall } from './memory/local.js';
import { buildRepoMap } from './repo-map/index.js';
import { initLlmRunner } from './agents/executor.js';
import { loadPlugins } from './plugins/loader.js';
import { statuslineSetupInstruction } from './cli/statusline.js';
import { versionUpdateInstruction } from './server/update-check.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Startup nudges surfaced to the agent via the MCP `instructions` field (computed once
// at startup, non-blocking). Two independent tips, each self-resolving:
//   • versionUpdateInstruction() — a newer Veto is on npm; restart to pick it up.
//   • statuslineSetupInstruction() — until the user enables the Veto status line.
// Neither can be an interactive stdio prompt (the stdio channel is JSON-RPC), so we
// hand the offer to the agent, which relays it to the user.
const instructions = [versionUpdateInstruction(), statuslineSetupInstruction()]
  .filter(Boolean)
  .join('\n\n') || undefined;

const server = new Server(
  { name: 'veto', version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} }, ...(instructions ? { instructions } : {}) },
);

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
  veto_decisions:         { readOnlyHint: false, destructiveHint: false },
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
  veto_dep_verify:        { readOnlyHint: true, openWorldHint: true },
  veto_query_advisor:     { readOnlyHint: true },
  veto_bundle_advisor:    { readOnlyHint: true },
  veto_dead_code:         { readOnlyHint: true },
  veto_hitl_checkpoint:   { readOnlyHint: true },
  veto_openapi_gen:       { readOnlyHint: false, destructiveHint: false },
  veto_flag_auditor:      { readOnlyHint: true },
  veto_drift_check:       { readOnlyHint: true },
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
  veto_find_tools:        { readOnlyHint: true },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = isCompactMode()
    ? getCompactToolList()
    : (TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string; inputSchema: object }>);
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
  ...reviewHandlers,
  ...coreHandlers,
  ...agentHandlers,
  ...councilHandlers,
};

// Meta-tools for compact mode: catalog search + indirect invocation. Defined
// here (not in a handler module) because veto_call needs the merged registry.
// Callable in full mode too, but only advertised when compact mode is on.
TOOL_REGISTRY['veto_find_tools'] = ({ args }) => {
  const query = String(args?.query ?? '').trim();
  if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
  const limit = typeof args?.limit === 'number' ? args.limit : 5;
  const tools = findTools(query, limit);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        matches: tools.length,
        tools,
        usage: 'Invoke a result with veto_call { tool: "<name>", args: {...} } following its inputSchema.',
      }, null, 2),
    }],
  };
};

TOOL_REGISTRY['veto_call'] = async ({ args, server: srv }) => {
  const toolName = String(args?.tool ?? '').trim();
  if (!toolName) return { content: [{ type: 'text', text: 'tool is required.' }], isError: true };
  if (toolName === 'veto_call' || toolName === 'veto_find_tools') {
    return { content: [{ type: 'text', text: `${toolName} cannot be invoked through veto_call.` }], isError: true };
  }
  const handler = TOOL_REGISTRY[toolName];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${toolName}. Use veto_find_tools to discover valid names.` }], isError: true };
  }
  const innerArgs = args?.args && typeof args.args === 'object' ? args.args : {};
  return await handler({ request: { params: { name: toolName, arguments: innerArgs } }, args: innerArgs, server: srv });
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
      throw new Error(`Unknown tool: ${name}`);
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

// Experimental streamable-HTTP mode (veto-server --http [port]). Stateless
// (no session IDs — the direction of the July 2026 spec) with plain JSON
// responses. Binds 127.0.0.1 unless VETO_HTTP_HOST is set: an MCP server
// silently reachable from the network is exactly the "Shadow MCP" pattern
// enterprises are now scanning for, so exposure must be a deliberate choice.
async function startHttp(port: number) {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createServer } = await import('node:http');

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);

  const host = process.env.VETO_HTTP_HOST || '127.0.0.1';
  const httpServer = createServer((req, res) => {
    if (!(req.url ?? '').startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is /mcp.' }));
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : undefined;
          await transport.handleRequest(req, res, body);
        } catch (err) {
          log.error('http request failed', { error: errMsg(err) });
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
          }
        }
      });
    } else {
      transport.handleRequest(req, res).catch((err: unknown) => {
        log.error('http request failed', { error: errMsg(err) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  process.stderr.write(`Veto MCP server v${VERSION} running (streamable HTTP, http://${host}:${port}/mcp)\n`);
}

async function main() {
  const loadedPlugins = await loadPlugins();
  if (loadedPlugins.length > 0) {
    process.stderr.write(`[veto] Loaded ${loadedPlugins.length} plugin(s): ${loadedPlugins.join(', ')}\n`);
  }
  initLlmRunner(server);

  const httpFlag = process.argv.indexOf('--http');
  if (httpFlag !== -1) {
    const port = parseInt(process.argv[httpFlag + 1] ?? '', 10) || 3939;
    await startHttp(port);
    return;
  }

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
