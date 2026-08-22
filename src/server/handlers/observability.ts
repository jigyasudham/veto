// Observability + status tools: health, metrics, usage/budget, audit log,
// context status, rate status, autosave status. They read the memory layer,
// router, config, and the shared runtime state (autoSave, serverHealth, VERSION).

import { statSync } from 'node:fs';
import {
  getContextUsage, getContextStatus, getHealthStats, getUsageStatus,
  getUsageLogs, getAuditLog, getMetrics, getDbPath, CONTEXT_WINDOWS,
  listSessions, getPatterns, getLatestCouncilOutcome,
} from '../../memory/local.js';
import { getRateStatus } from '../../router/index.js';
import { getConfig, setConfig } from '../../memory/config.js';
import { hostClient, detectHostPlatform } from '../../host.js';
import { autoSave, serverHealth, VERSION } from '../runtime.js';
import type { HandlerMap } from '../registry.js';

export const observabilityHandlers: HandlerMap = {
  veto_autosave_status: () => {
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
  },

  veto_rate_status: () => ({
    content: [{ type: 'text', text: JSON.stringify(getRateStatus(), null, 2) }],
  }),

  veto_context_status: ({ args }) => {
    const session_id = String(args?.session_id ?? '');
    if (!session_id) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'session_id is required.' }) }], isError: true };
    }
    const status = getContextStatus(session_id);
    if (!status) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `No session found: ${session_id}` }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...status }, null, 2) }] };
  },

  veto_usage_status: ({ args }) => {
    if (args?.set_budget && typeof args.set_budget === 'object') {
      const b = args.set_budget as Record<string, unknown>;
      const current = getConfig().dailyTokenBudget;
      setConfig({
        dailyTokenBudget: {
          claude: typeof b.claude === 'number' ? b.claude : current.claude,
          gemini: typeof b.gemini === 'number' ? b.gemini : current.gemini,
          codex:  typeof b.codex  === 'number' ? b.codex  : current.codex,
          antigravity: typeof b.antigravity === 'number' ? b.antigravity : current.antigravity,
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
            antigravity: rateStatus.antigravity.tokens_today,
          },
          budget_used_pct: {
            claude: rateStatus.claude.used_percent,
            gemini: rateStatus.gemini.used_percent,
            codex:  rateStatus.codex.used_percent,
            antigravity: rateStatus.antigravity.used_percent,
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
  },

  veto_audit_log: ({ args }) => {
    const events = getAuditLog({
      session_id: args?.session_id ? String(args.session_id) : undefined,
      verdict:    args?.verdict    ? String(args.verdict)    : undefined,
      since:      args?.since      ? String(args.since)      : undefined,
      limit:      typeof args?.limit === 'number' ? args.limit : 20,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, count: events.length, events }, null, 2) }] };
  },

  veto_health: ({ server }) => {
    const stats = getHealthStats();
    // Which CLI is hosting Veto, from the MCP handshake rather than a self-report.
    // Surfaced here because "capture archived nothing" is usually "Veto is not in
    // the CLI you think it is", and that is otherwise invisible.
    // Resolve FIRST: this also populates the cached identity when oninitialized
    // has not run, so reading the raw name before it would report null.
    const resolved = detectHostPlatform(server);
    const client = hostClient();
    const host = {
      client: client?.name ?? null,
      client_version: client?.version ?? null,
      resolved_platform: resolved,
      transcript_capture_supported: resolved !== null,
    };
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
          status: serverHealth.errorCount > 10 ? 'degraded' : 'healthy',
          uptime_seconds: Math.round((Date.now() - serverHealth.startTime) / 1000),
          db_path: getDbPath(),
          db_size_bytes,
          db_size_human,
          error_count_since_start: serverHealth.errorCount,
          last_error: serverHealth.lastError,
          context_windows: CONTEXT_WINDOWS,
          host,
          ...stats,
        }, null, 2),
      }],
    };
  },

  veto_metrics: () => {
    const metrics = getMetrics();
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...metrics }, null, 2) }] };
  },

  // One read-only call returning everything an editor HUD / CLI statusline shows.
  // Same fields the statusline composes — built for veto-vscode so editors can
  // stop reading internal tables directly.
  veto_snapshot: ({ args }) => {
    const top = Math.min(Math.max(typeof args?.top === 'number' ? args.top : 5, 1), 20);

    const sessionRow = listSessions(1)[0];
    const session = sessionRow ? {
      id: sessionRow.id,
      platform: sessionRow.platform ?? null,
      active_client: sessionRow.active_client ?? null,
      summary: sessionRow.summary ?? null,
      token_count: sessionRow.token_count ?? 0,
      project_dir: sessionRow.project_dir ?? null,
      started_at: sessionRow.started_at ?? null,
    } : null;

    const council = getLatestCouncilOutcome(); // { verdict, recommended, task, debated_at } | null

    // Top learned patterns, excluding router.* thresholds and composed_agent:* defs
    // (config/JSON, not learning scores) — mirrors the statusline's router segment.
    const routerTop = getPatterns(undefined, 50)
      .filter(p => !p.pattern_key.startsWith('router.') && !p.pattern_key.startsWith('composed_agent:'))
      .slice(0, top)
      .map(p => ({
        pattern_key: p.pattern_key,
        pattern_val: p.pattern_val,
        confidence: p.confidence,
        seen_count: p.seen_count,
      }));

    const rs = getRateStatus();
    const rate = (['claude', 'gemini', 'codex', 'antigravity'] as const).map(platform => ({
      platform,
      tokens_today: rs[platform].tokens_today,
      used_percent: rs[platform].used_percent,
      status: rs[platform].status,
    }));

    const stats = getHealthStats();
    const health = {
      status: serverHealth.errorCount > 10 ? 'degraded' : 'healthy',
      uptime_seconds: Math.round((Date.now() - serverHealth.startTime) / 1000),
      version: VERSION,
      total_sessions: stats.total_sessions,
      total_patterns: stats.total_patterns,
      total_council_outcomes: stats.total_council_outcomes,
      avg_council_latency_ms: stats.avg_council_latency_ms,
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          session,
          council,
          routerTop,
          rate,
          memoryCount: stats.total_memories,
          health,
        }, null, 2),
      }],
    };
  },
};
