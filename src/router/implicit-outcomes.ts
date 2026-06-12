// Mines quality signals from the tool-call trace log so the learning loop gets
// feedback without the host AI manually calling veto_record_outcome. Handlers
// already record optimistic outcomes at call time; what they can't see is
// failure after the fact. Two negative signals are mined here:
//   errors  — a traced call that returned an error result
//   retries — the same analysis tool re-run in the same session within a short
//             window, which usually means the first answer didn't satisfy
// A watermark in the patterns table keeps mining incremental and idempotent.

import { randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';
import { recordOutcome } from './learning-updater.js';

const WATERMARK_KEY = 'learning.mine_watermark';
const RETRY_WINDOW_MS = 10 * 60 * 1000;
const ERROR_QUALITY = 30;
const RETRY_QUALITY = 55;
const BATCH_LIMIT = 500;

// Only agent-backed analysis tools, where an error or a rapid re-run reflects
// on the agent's output quality. Status/memory/session tools are excluded —
// they are legitimately called repeatedly.
const TOOL_AGENT_MAP: Record<string, string> = {
  veto_code_review: 'reviewer',
  veto_diff_review: 'reviewer',
  veto_full_review: 'code-quality',
  veto_security_scan: 'security-scanner',
  veto_secrets_scan: 'secrets',
  veto_council_debate: 'council',
  veto_rca: 'debugger',
  veto_dead_code: 'code-quality',
  veto_dep_advisor: 'dependency-audit',
  veto_test_gaps: 'tester',
  veto_clone_detector: 'code-quality',
};

type TraceRow = {
  id: string;
  session_id: string | null;
  tool_name: string;
  result_status: string;
  recorded_at: string;
};

export type MineResult = { mined: number; errors: number; retries: number };

export function mineImplicitOutcomes(): MineResult {
  const db = getDb();
  const toolNames = Object.keys(TOOL_AGENT_MAP);
  const wmRow = db.prepare('SELECT pattern_val FROM patterns WHERE pattern_key = ?').get(WATERMARK_KEY) as { pattern_val: string } | undefined;
  const since = wmRow?.pattern_val ?? '1970-01-01 00:00:00';

  const placeholders = toolNames.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, session_id, tool_name, result_status, recorded_at
     FROM tool_call_trace_log
     WHERE recorded_at > ? AND tool_name IN (${placeholders})
     ORDER BY recorded_at ASC
     LIMIT ${BATCH_LIMIT}`
  ).all(since, ...toolNames) as TraceRow[];

  if (rows.length === 0) return { mined: 0, errors: 0, retries: 0 };

  let errors = 0;
  let retries = 0;

  // Error signal — every traced failure of an agent-backed tool.
  for (const row of rows) {
    if (row.result_status === 'error') {
      recordOutcome(row.tool_name, 50, 2, TOOL_AGENT_MAP[row.tool_name], ERROR_QUALITY);
      errors++;
    }
  }

  // Retry signal — successive successful runs of the same tool in the same
  // session inside the window: every run except the last gets marked down.
  const groups = new Map<string, TraceRow[]>();
  for (const row of rows) {
    if (row.result_status !== 'success') continue;
    const key = `${row.session_id ?? 'no-session'}::${row.tool_name}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length - 1; i++) {
      const gap = new Date(group[i + 1].recorded_at + 'Z').getTime() - new Date(group[i].recorded_at + 'Z').getTime();
      if (gap >= 0 && gap <= RETRY_WINDOW_MS) {
        recordOutcome(group[i].tool_name, 50, 2, TOOL_AGENT_MAP[group[i].tool_name], RETRY_QUALITY);
        retries++;
      }
    }
  }

  // Advance the watermark to the newest processed row.
  const newest = rows[rows.length - 1].recorded_at;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM patterns WHERE pattern_key = ?').get(WATERMARK_KEY) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE patterns SET pattern_val = ?, updated_at = ? WHERE pattern_key = ?').run(newest, now, WATERMARK_KEY);
  } else {
    db.prepare('INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at) VALUES (?, ?, ?, 1, 1, ?)')
      .run(randomUUID(), WATERMARK_KEY, newest, now);
  }

  return { mined: errors + retries, errors, retries };
}
