// Observability + status tools: health, metrics, usage/budget, audit log,
// context status, rate status, autosave status. They read the memory layer,
// router, config, and the shared runtime state (autoSave, serverHealth, VERSION).

import { statSync } from 'node:fs';
import {
  getContextUsage, getContextStatus, getHealthStats, getUsageStatus,
  getUsageLogs, getAuditLog, getMetrics, getDbPath, CONTEXT_WINDOWS,
} from '../../memory/local.js';
import { getRateStatus } from '../../router/index.js';
import { getConfig, setConfig } from '../../memory/config.js';
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

  veto_health: () => {
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
          status: serverHealth.errorCount > 10 ? 'degraded' : 'healthy',
          uptime_seconds: Math.round((Date.now() - serverHealth.startTime) / 1000),
          db_path: getDbPath(),
          db_size_bytes,
          db_size_human,
          error_count_since_start: serverHealth.errorCount,
          last_error: serverHealth.lastError,
          context_windows: CONTEXT_WINDOWS,
          ...stats,
        }, null, 2),
      }],
    };
  },

  veto_metrics: () => {
    const metrics = getMetrics();
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...metrics }, null, 2) }] };
  },
};
