// Cross-platform session tools: save, restore, list, handoff, continue, replay.
// These persist and rehydrate the working context that lets a session move
// between AI clients (claude/gemini/codex). They touch the memory layer, the
// adapters (handoff/continue), and the shared runtime state (autoSave,
// active-project-dir). veto_session_save also uses the MCP server for sampling-
// based auto-summarization, which arrives via ctx.server.

import {
  saveSession, updateSession, restoreSession, listSessions, closeSession,
  resolveContextWindow, upsertContextUsage, getSessionReplay, normalizeProjectDir,
} from '../../memory/local.js';
import { trackTokens } from '../../router/index.js';
import type { Platform } from '../../router/index.js';
import { handoff, continueSession } from '../../adapters/index.js';
import { autoSummarizeSession } from '../../council/session-summarizer.js';
import { autoSave, getActiveProjectDir, setActiveProjectDir } from '../runtime.js';
import { detectHostPlatform } from '../../host.js';
import type { HandlerMap } from '../registry.js';

export const sessionHandlers: HandlerMap = {
  veto_session_save: async ({ args, server }) => {
    const sessionProjectDir = args?.project_dir ? normalizeProjectDir(String(args.project_dir)) : undefined;
    if (sessionProjectDir) setActiveProjectDir(sessionProjectDir);
    // The MCP handshake knows which CLI is hosting us; the arg is a self-report.
    // An explicit arg still wins (it is what the model believes it is), but the
    // default is now the real host rather than a hardcoded "claude".
    const hostPlatform = detectHostPlatform(server);
    const savePlatform = args?.platform ? String(args.platform) : (hostPlatform ?? 'claude');
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
    // Best-effort transcript capture (VERSION-3 item 6): archive + index this session's
    // host transcript for later recall, and surface the leak count / first-capture note.
    // Gated on opt-in + a supported host CLI; NEVER throws or blocks correctness.
    let transcriptOnSave: import('../../transcripts/on-save.js').OnSaveTranscript | null = null;
    try {
      const { captureOnSave, captureSourceFor } = await import('../../transcripts/on-save.js');
      // Capture is about WHICH HOST'S FILE to archive, so the handshake is
      // authoritative here even when the model declared something else.
      const captureSource = captureSourceFor(hostPlatform, savePlatform);
      if (captureSource) {
        transcriptOnSave = await captureOnSave({
          projectDir: sessionProjectDir,
          vetoSessionId: result.session_id,
          platform: captureSource,
        });
      }
    } catch { /* transcript capture is best-effort; never breaks save */ }

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
      ...(transcriptOnSave ? { transcript: transcriptOnSave } : {}),
    };
    if (result.continuation_prompt) responseObj.continuation_prompt = result.continuation_prompt;

    return { content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }] };
  },

  veto_session_restore: ({ args }) => {
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
    if (s.project_dir) setActiveProjectDir(s.project_dir);

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
  },

  veto_sessions_list: ({ args }) => {
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
  },

  veto_handoff: ({ args }) => {
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
    if (getActiveProjectDir()) {
      const sessions = listSessions(1);
      if (sessions[0] && sessions[0].id !== result.session_id) closeSession(sessions[0].id);
    }
    return { content: [{ type: 'text', text: result.instructions + '\n\n' + JSON.stringify({ session_id: result.session_id, to_platform: result.to_platform, saved_at: result.saved_at, reason: result.reason }, null, 2) }] };
  },

  veto_continue: ({ args }) => {
    const resuming_as = args?.resuming_as ? String(args.resuming_as) : undefined;
    const result = continueSession(args?.session_id ? String(args.session_id) : undefined, resuming_as);
    if (!result.found) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: result.message }, null, 2) }], isError: true };
    }
    if (result.project_dir) setActiveProjectDir(result.project_dir);
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
  },

  veto_session_replay: async ({ args }) => {
    // Transcript recall (VERSION-3 item 6). Phase 2 — expand to exact masked lines.
    if (args?.expand && typeof args.expand === 'object') {
      try {
        const { recallExpand } = await import('../../transcripts/recall.js');
        const e = args.expand as Record<string, unknown>;
        const res = recallExpand({
          eventId: e.event_id ? String(e.event_id) : undefined,
          archiveId: e.archive_id ? String(e.archive_id) : undefined,
          sourceSessionId: e.source_session_id ? String(e.source_session_id) : undefined,
          segmentIndex: typeof e.segment_index === 'number' ? e.segment_index : undefined,
          fromSeq: typeof e.from_seq === 'number' ? e.from_seq : undefined,
          toSeq: typeof e.to_seq === 'number' ? e.to_seq : undefined,
          raw: e.raw === true,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], ...(res.ok ? {} : { isError: true }) };
      } catch (err) {
        return { content: [{ type: 'text', text: `recall expand failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
    // Phase 1 — query the transcript archive (TOC + BM25 hits).
    if (args?.query) {
      try {
        const { recallQuery } = await import('../../transcripts/recall.js');
        const projectDir = args.project_dir ? normalizeProjectDir(String(args.project_dir)) : (getActiveProjectDir() ?? undefined);
        const res = recallQuery({
          query: String(args.query),
          projectDir: projectDir ?? undefined,
          sourceSessionId: args.source_session_id ? String(args.source_session_id) : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `recall query failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
    // Legacy — chronological tool-call trace by veto session id.
    const sessionId = String(args?.session_id ?? '').trim();
    if (!sessionId) return { content: [{ type: 'text', text: 'Pass session_id (event trace), or query / expand (transcript recall).' }], isError: true };
    const traces = getSessionReplay(sessionId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, session_id: sessionId, events: traces }, null, 2) }] };
  },
};
