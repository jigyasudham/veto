// Core server tools: status/heartbeat (with token tracking + auto-save trigger),
// task routing, platform setup instructions, package-docs fetch, and project
// discovery. These touch the router, memory layer, config, adapters, and the
// shared runtime (autoSave/VERSION).

import { statSync } from 'node:fs';
import {
  getDbPath, resolveContextWindow, upsertContextUsage, fetchAndCacheDocs,
  updateProjectMap, storeKnowledge,
} from '../../memory/local.js';
import { getConfig } from '../../memory/config.js';
import { routeTask, trackTokens, recordOutcome, getRecommendedAgent } from '../../router/index.js';
import type { AgentType, Platform } from '../../router/index.js';
import { getPlatformSetup } from '../../adapters/index.js';
import type { SetupPlatform } from '../../adapters/index.js';
import { discoverProject } from '../../discover.js';
import { buildRepoMap } from '../../repo-map/index.js';
import { VERSION, autoSave, maybeAutoSave } from '../runtime.js';
import type { HandlerMap } from '../registry.js';

export const coreHandlers: HandlerMap = {
  veto_status: async ({ args }) => {
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
    // Transcript capture disk usage (VERSION-3 item 6) — only when opted in.
    let transcriptsInfo: Record<string, unknown> | undefined;
    try {
      const { isCaptureEnabled, captureStatus } = await import('../../transcripts/config.js');
      if (isCaptureEnabled()) {
        const { transcriptsDiskUsage } = await import('../../transcripts/manage.js');
        const cs = captureStatus();
        const du = transcriptsDiskUsage();
        transcriptsInfo = { enabled: true, archives: du.archives, disk_bytes: du.totalBytes, retention_days: cs.retention_days, dir: cs.dir };
      }
    } catch { /* transcripts optional */ }
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
              ...(transcriptsInfo ? { transcripts: transcriptsInfo } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  },

  veto_route_task: ({ args }) => {
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
  },

  veto_platform_setup: ({ args }) => {
    const platform = String(args?.platform ?? '').trim() as SetupPlatform;
    const vetoServerPath = String(args?.veto_server_path ?? '').trim();
    if (!platform || !vetoServerPath) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'platform and veto_server_path are required.' }) }], isError: true };
    }
    const setup = getPlatformSetup(platform, vetoServerPath);
    return { content: [{ type: 'text', text: JSON.stringify(setup, null, 2) }] };
  },

  veto_docs_fetch: async ({ args }) => {
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
  },

  veto_discover: ({ args }) => {
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
  },
};
