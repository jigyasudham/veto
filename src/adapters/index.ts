// Handoff engine — platform detection, session save+switch, continue restore

import { getRateStatus, trackRequest } from '../router/rate-monitor.js';
import { saveSession, listSessions, restoreSession } from '../memory/local.js';
import type { Platform } from '../router/rate-monitor.js';
import * as claude from './claude.js';
import * as gemini from './gemini.js';
import * as codex from './codex.js';

export type HandoffResult = {
  session_id: string;
  saved_at: string;
  from_platform: Platform;
  to_platform: Platform;
  reason: string;
  rate_status: ReturnType<typeof getRateStatus>;
  instructions: string;
  one_liner: string;
};

export type ContinueResult = {
  found: boolean;
  session_id?: string;
  platform?: string;
  active_client?: string;
  summary?: string;
  context?: unknown;
  task_state?: unknown;
  next_action?: string;
  project_dir?: string;
  token_count?: number;
  message: string;
  restored_at: string;
};

export type PlatformSetupResult = {
  platform: Platform;
  mcp_config: object;
  setup_steps: string[];
  rate_limit_signals: string[];
  continue_command: string;
  notes: string[];
};

// ─── Handoff ──────────────────────────────────────────────────────────────────

export function handoff(options: {
  summary?: string;
  context?: string;
  task_state?: string;
  from_platform?: Platform;
  to_platform?: Platform;
  token_count?: number;
  project_dir?: string;
}): HandoffResult {
  const rateStatus = getRateStatus();
  const from: Platform = options.from_platform ?? 'claude';

  // Pick the best available target platform
  const to: Platform = options.to_platform ?? selectTarget(from, rateStatus);

  const reason = rateStatus[from].status === 'critical'
    ? `${from} is at ${rateStatus[from].used_percent}% of daily limit`
    : rateStatus[from].status === 'warning'
    ? `${from} is at ${rateStatus[from].used_percent}% — switching proactively`
    : 'Manual platform switch requested';

  const { session_id, saved_at } = saveSession({
    platform: from,
    summary: options.summary ?? `Session handed off from ${from} to ${to}`,
    context: options.context,
    task_state: options.task_state,
    token_count: options.token_count ?? 0,
    project_dir: options.project_dir,
  });

  const instructions = buildInstructions(session_id, from, to, rateStatus);
  const one_liner = `Session saved (${session_id.slice(0, 8)}…). On ${to}: call veto_continue`;

  return {
    session_id,
    saved_at,
    from_platform: from,
    to_platform: to,
    reason,
    rate_status: rateStatus,
    instructions,
    one_liner,
  };
}

// ─── Continue ─────────────────────────────────────────────────────────────────

export function continueSession(sessionId?: string, active_client?: string): ContinueResult {
  const now = new Date().toISOString();

  if (sessionId) {
    const result = restoreSession(sessionId, active_client);
    if (!result.found || !result.session) {
      return { found: false, message: `No session found with ID: ${sessionId}`, restored_at: now };
    }
    return buildContinueResult(result.session, now);
  }

  // No ID given — find the most recent session
  const sessions = listSessions(1);
  if (sessions.length === 0) {
    return {
      found: false,
      message: 'No saved sessions found. Save a session first with veto_handoff or veto_session_save.',
      restored_at: now,
    };
  }

  const result = restoreSession(sessions[0].id, active_client);
  if (!result.found || !result.session) {
    return { found: false, message: 'Could not restore the most recent session.', restored_at: now };
  }

  return buildContinueResult(result.session, now);
}

function buildContinueResult(session: ReturnType<typeof listSessions>[0], now: string): ContinueResult {
  let context: unknown = null;
  let task_state: unknown = null;
  let next_action: string | undefined;

  try {
    context = session.context ? JSON.parse(session.context) : null;
  } catch { context = session.context; }

  try {
    let ts: unknown = session.task_state ? JSON.parse(session.task_state) : null;
    // saveSession double-stringifies when given a pre-serialised string — unwrap if needed
    if (typeof ts === 'string') { try { ts = JSON.parse(ts); } catch { /* keep as string */ } }
    task_state = ts;
    if (ts && typeof ts === 'object' && 'nextAction' in ts) {
      next_action = String((ts as Record<string, unknown>)['nextAction']);
    }
  } catch { task_state = session.task_state; }

  const message = [
    `Session restored from ${session.platform} (saved ${session.started_at.slice(0, 16)}).`,
    session.summary ? `\nSummary: ${session.summary}` : '',
    next_action ? `\nNext action: ${next_action}` : '',
    `\nContinue exactly where you left off. Nothing needs to be re-explained.`,
  ].filter(Boolean).join('');

  return {
    found: true,
    session_id: session.id,
    platform: session.platform,
    active_client: session.active_client ?? undefined,
    summary: session.summary ?? undefined,
    context,
    task_state,
    next_action,
    project_dir: session.project_dir ?? undefined,
    token_count: session.token_count,
    message,
    restored_at: now,
  };
}

// ─── Platform Setup ───────────────────────────────────────────────────────────

export function getPlatformSetup(platform: Platform, vetoServerPath: string): PlatformSetupResult {
  if (platform === 'claude') return claude.getSetup(vetoServerPath) as PlatformSetupResult;
  if (platform === 'gemini') return gemini.getSetup(vetoServerPath) as PlatformSetupResult;
  return codex.getSetup(vetoServerPath) as PlatformSetupResult;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function selectTarget(from: Platform, rateStatus: ReturnType<typeof getRateStatus>): Platform {
  const order: Platform[] = from === 'claude'
    ? ['gemini', 'codex']
    : from === 'gemini'
    ? ['codex', 'claude']
    : ['claude', 'gemini'];

  for (const p of order) {
    if (rateStatus[p].status !== 'critical') return p;
  }
  // All critical — pick the one with most headroom remaining
  return order.reduce((best, p) =>
    rateStatus[p].used_percent < rateStatus[best].used_percent ? p : best
  , order[0]);
}

function buildInstructions(
  sessionId: string,
  from: Platform,
  to: Platform,
  rateStatus: ReturnType<typeof getRateStatus>
): string {
  const toStatus = rateStatus[to];
  const lines: string[] = [
    `── Veto Handoff ──────────────────────────────────────────`,
    `From:     ${from.padEnd(8)} (${rateStatus[from].used_percent}% used)`,
    `To:       ${to.padEnd(8)} (${toStatus.used_percent}% used)`,
    `Session:  ${sessionId}`,
    ``,
    `On ${to}:`,
    `  1. Open a new terminal with ${to} CLI`,
    `  2. Veto is already running — same server, same memory`,
    `  3. Call:  veto_continue`,
    `     Veto restores full context automatically.`,
    `     Nothing needs to be re-explained.`,
    ``,
    `Or if you have the session ID:`,
    `  veto_continue { "session_id": "${sessionId}" }`,
    ``,
    `Rate resets at: ${rateStatus[from].resets_at.slice(0, 16)} UTC`,
    `─────────────────────────────────────────────────────────`,
  ];

  return lines.join('\n');
}
