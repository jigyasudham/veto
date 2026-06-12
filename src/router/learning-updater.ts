// Records routing outcomes to SQLite and adjusts tier thresholds from historical quality data

import { randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';
import { getConfig } from '../memory/config.js';

export type LearningStats = {
  total_tasks: number;
  tier_breakdown: Record<number, { count: number; avg_quality: number }>;
  suggested_thresholds: { tier1_max: number; tier2_max: number };
};

export type AgentPerformanceStat = {
  agent: string;
  task_count: number;
  avg_quality: number;
  avg_tokens: number;
  low_quality_count: number;
  needs_attention: boolean;
};

export type TaskTypeBreakdown = {
  task_type: string;
  count: number;
  avg_complexity: number;
  avg_quality: number;
  dominant_tier: number;
  under_tiered: boolean;
};

export type CouncilInsight = {
  verdict: string;
  task_snippet: string;
  debated_at: string;
  days_to_debug: number | null;
  related_decision: string | null;
};

export type LearnedThresholds = {
  tier1_max: number;
  tier2_max: number;
  source: 'learned' | 'default';
  data_points: number;
};

// ─── Record ───────────────────────────────────────────────────────────────────

export function recordOutcome(
  taskType: string,
  complexity: number,
  modelTier: 1 | 2 | 3,
  agent: string,
  outputQuality: number,
  tokensUsed = 0,
  fileExt?: string,
): { auto_applied: boolean; total: number } {
  const db = getDb();
  db.prepare(
    `INSERT INTO learning_data (id, task_type, complexity, model_tier, output_quality, tokens_used, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), taskType, complexity, modelTier, outputQuality, tokensUsed, agent);

  // Predictive routing: track agent quality per file extension and task type keyword
  if (agent && agent !== 'dynamic' && outputQuality > 0) {
    const now = new Date().toISOString();
    const upsert = (key: string) => {
      const existing = db.prepare('SELECT id, pattern_val, confidence, seen_count FROM patterns WHERE pattern_key = ?').get(key) as
        { id: string; pattern_val: string; confidence: number; seen_count: number } | undefined;
      if (existing) {
        // running average quality as confidence (0–1)
        const newConf = ((existing.confidence * existing.seen_count) + (outputQuality / 100)) / (existing.seen_count + 1);
        db.prepare('UPDATE patterns SET confidence = ?, seen_count = ?, updated_at = ? WHERE pattern_key = ?')
          .run(Math.min(1, newConf), existing.seen_count + 1, now, key);
      } else {
        db.prepare('INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), key, agent, outputQuality / 100, 1, now);
      }
    };

    if (fileExt) upsert(`file_agent:${fileExt.toLowerCase()}:${agent}`);
    const keyword = taskType.toLowerCase().split(/[\s_-]/)[0];
    if (keyword) upsert(`task_agent:${keyword}:${agent}`);
  }

  // Auto-apply learned thresholds every 20 outcomes (default on; disable via
  // config auto_apply_learning=false). Closes the learning loop so no manual
  // veto_learning_apply is required. A watermark (count at last apply) is used
  // instead of `total % 20` — the modulo never fires when the DB already held
  // outcomes before this feature existed, or after a manual apply desyncs the cadence.
  const total = (db.prepare('SELECT COUNT(*) as c FROM learning_data').get() as { c: number }).c;
  let auto_applied = false;
  if (total >= 20 && getConfig().auto_apply_learning !== false) {
    const row = db.prepare('SELECT pattern_val FROM patterns WHERE pattern_key = ?').get('router.last_apply_count') as { pattern_val: string } | undefined;
    const lastApplied = row ? parseInt(row.pattern_val, 10) : 0;
    if (total - lastApplied >= 20) {
      auto_applied = applyLearnedThresholds().applied;
    }
  }
  return { auto_applied, total };
}

// ─── Predictive Agent Recommendation ─────────────────────────────────────────

export function getRecommendedAgent(taskType: string, fileExt?: string): string | null {
  const db = getDb();

  // Try file extension match first (more specific)
  if (fileExt) {
    const rows = db.prepare(
      `SELECT pattern_key, pattern_val, confidence, seen_count FROM patterns
       WHERE pattern_key LIKE ? AND seen_count >= 3
       ORDER BY confidence DESC LIMIT 1`
    ).all(`file_agent:${fileExt.toLowerCase()}:%`) as Array<{ pattern_key: string; pattern_val: string; confidence: number; seen_count: number }>;
    if (rows.length > 0 && rows[0].confidence >= 0.7) return rows[0].pattern_val;
  }

  // Fall back to task keyword match
  const keyword = taskType.toLowerCase().split(/[\s_-]/)[0];
  if (keyword) {
    const rows = db.prepare(
      `SELECT pattern_key, pattern_val, confidence, seen_count FROM patterns
       WHERE pattern_key LIKE ? AND seen_count >= 3
       ORDER BY confidence DESC LIMIT 1`
    ).all(`task_agent:${keyword}:%`) as Array<{ pattern_key: string; pattern_val: string; confidence: number; seen_count: number }>;
    if (rows.length > 0 && rows[0].confidence >= 0.7) return rows[0].pattern_val;
  }

  return null;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function getLearningStats(): LearningStats {
  const db = getDb();
  const rows = db.prepare(
    `SELECT model_tier, COUNT(*) as count, AVG(output_quality) as avg_quality
     FROM learning_data GROUP BY model_tier`
  ).all() as Array<{ model_tier: number; count: number; avg_quality: number }>;

  const total_tasks = rows.reduce((sum, r) => sum + r.count, 0);
  const tier_breakdown: Record<number, { count: number; avg_quality: number }> = {};
  for (const r of rows) {
    tier_breakdown[r.model_tier] = {
      count: r.count,
      avg_quality: Math.round((r.avg_quality ?? 0) * 100) / 100,
    };
  }

  const thresholds = computeSuggestedThresholds(tier_breakdown);
  return { total_tasks, tier_breakdown, suggested_thresholds: thresholds };
}

export function getAgentPerformanceStats(): AgentPerformanceStat[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT agent,
           COUNT(*) as task_count,
           AVG(output_quality) as avg_quality,
           AVG(tokens_used) as avg_tokens,
           SUM(CASE WHEN output_quality < 60 THEN 1 ELSE 0 END) as low_quality_count
    FROM learning_data
    WHERE agent IS NOT NULL
    GROUP BY agent
    ORDER BY avg_quality ASC
  `).all() as Array<{
    agent: string; task_count: number; avg_quality: number;
    avg_tokens: number; low_quality_count: number;
  }>;

  return rows.map(r => ({
    agent: r.agent,
    task_count: r.task_count,
    avg_quality: Math.round(r.avg_quality * 10) / 10,
    avg_tokens: Math.round(r.avg_tokens),
    low_quality_count: r.low_quality_count,
    needs_attention: r.avg_quality < 70 || (r.low_quality_count / r.task_count) > 0.25,
  }));
}

export function getTaskTypeBreakdown(): TaskTypeBreakdown[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT task_type,
           COUNT(*) as count,
           AVG(complexity) as avg_complexity,
           AVG(output_quality) as avg_quality,
           model_tier as dominant_tier
    FROM learning_data
    GROUP BY task_type, model_tier
    HAVING COUNT(*) = (
      SELECT MAX(c) FROM (
        SELECT COUNT(*) as c FROM learning_data l2
        WHERE l2.task_type = learning_data.task_type
        GROUP BY l2.model_tier
      )
    )
    ORDER BY count DESC
    LIMIT 50
  `).all() as Array<{
    task_type: string; count: number; avg_complexity: number;
    avg_quality: number; dominant_tier: number;
  }>;

  return rows.map(r => {
    // Under-tiered: task scored high quality but at a tier below what complexity suggests
    const expectedTier = r.avg_complexity <= 30 ? 1 : r.avg_complexity <= 70 ? 2 : 3;
    const under_tiered = r.dominant_tier < expectedTier && r.avg_quality < 70;
    return {
      task_type: r.task_type,
      count: r.count,
      avg_complexity: Math.round(r.avg_complexity),
      avg_quality: Math.round(r.avg_quality * 10) / 10,
      dominant_tier: r.dominant_tier,
      under_tiered,
    };
  });
}

export function getCouncilInsights(): CouncilInsight[] {
  const db = getDb();

  // Correlate council approvals (GREEN/YELLOW) with debugging sessions that came after
  const rows = db.prepare(`
    SELECT co.verdict, co.task, co.debated_at,
           d.decision as related_decision, d.made_at as decision_at
    FROM council_outcomes co
    LEFT JOIN decisions d ON d.session_id = co.session_id
      AND d.decision LIKE '%debug%' OR d.decision LIKE '%fix%' OR d.decision LIKE '%bug%'
    WHERE co.verdict IN ('GREEN', 'YELLOW')
    ORDER BY co.debated_at DESC
    LIMIT 30
  `).all() as Array<{
    verdict: string; task: string; debated_at: string;
    related_decision: string | null; decision_at: string | null;
  }>;

  return rows.map(r => {
    let days_to_debug: number | null = null;
    if (r.decision_at) {
      const debated = new Date(r.debated_at).getTime();
      const decided = new Date(r.decision_at).getTime();
      days_to_debug = Math.round((decided - debated) / (1000 * 60 * 60 * 24));
    }
    return {
      verdict: r.verdict,
      task_snippet: r.task.substring(0, 80),
      debated_at: r.debated_at,
      days_to_debug,
      related_decision: r.related_decision,
    };
  });
}

// ─── Threshold Computation ────────────────────────────────────────────────────

function computeSuggestedThresholds(
  tier_breakdown: Record<number, { count: number; avg_quality: number }>
): { tier1_max: number; tier2_max: number } {
  const t1 = tier_breakdown[1];
  const t2 = tier_breakdown[2];
  const t3 = tier_breakdown[3];

  let tier1_max = 30;
  let tier2_max = 70;

  // Tier 2 consistently great → can handle more tasks, raise Tier 1 ceiling slightly
  if (t2 && t2.count >= 20 && t2.avg_quality >= 88) tier1_max = 35;
  // Tier 2 quality poor → tighten Tier 1 ceiling (fewer tasks escape to T2)
  if (t2 && t2.count >= 10 && t2.avg_quality < 65) tier1_max = 25;

  // Tier 3 consistently great → can push harder tasks to T3, lower T2 ceiling
  if (t3 && t3.count >= 10 && t3.avg_quality >= 88) tier2_max = 65;
  // Tier 3 quality poor → be more conservative, raise T2 ceiling (keep more in T2)
  if (t3 && t3.count >= 10 && t3.avg_quality < 65) tier2_max = 75;

  // Tier 1 quality poor → lower its ceiling (fewer tasks stay at T1)
  if (t1 && t1.count >= 10 && t1.avg_quality < 65) tier1_max = Math.max(20, tier1_max - 5);

  return { tier1_max, tier2_max };
}

// ─── Apply ────────────────────────────────────────────────────────────────────

export function applyLearnedThresholds(): { applied: boolean; thresholds: { tier1_max: number; tier2_max: number }; data_points: number; reason: string } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM learning_data').get() as { c: number }).c;

  // Need at least 20 data points before adjusting
  if (total < 20) {
    return {
      applied: false,
      thresholds: { tier1_max: 30, tier2_max: 70 },
      data_points: total,
      reason: `Not enough data yet. Need 20 task outcomes, have ${total}. Record outcomes via veto_record_outcome.`,
    };
  }

  const stats = getLearningStats();
  const { tier1_max, tier2_max } = stats.suggested_thresholds;

  // Persist to patterns table so the router picks them up on next call.
  // seen_count tracks data_points at apply time; the watermark key records
  // the outcome count so recordOutcome knows when 20 new outcomes have landed.
  const now = new Date().toISOString();
  for (const [key, val] of [['router.tier1_max', String(tier1_max)], ['router.tier2_max', String(tier2_max)], ['router.last_apply_count', String(total)]]) {
    const existing = db.prepare('SELECT id FROM patterns WHERE pattern_key = ?').get(key) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE patterns SET pattern_val = ?, seen_count = ?, updated_at = ? WHERE pattern_key = ?').run(val, total, now, key);
    } else {
      db.prepare('INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), key, val, 1.0, total, now);
    }
  }

  return {
    applied: true,
    thresholds: { tier1_max, tier2_max },
    data_points: total,
    reason: `Thresholds updated from ${total} task outcomes. Default was 30/70; learned is ${tier1_max}/${tier2_max}.`,
  };
}

export function getLearnedThresholds(): LearnedThresholds {
  const db = getDb();
  const t1row = db.prepare('SELECT pattern_val, seen_count FROM patterns WHERE pattern_key = ?').get('router.tier1_max') as { pattern_val: string; seen_count: number } | undefined;
  const t2row = db.prepare('SELECT pattern_val, seen_count FROM patterns WHERE pattern_key = ?').get('router.tier2_max') as { pattern_val: string; seen_count: number } | undefined;

  if (!t1row || !t2row) {
    return { tier1_max: 30, tier2_max: 70, source: 'default', data_points: 0 };
  }

  return {
    tier1_max: parseInt(t1row.pattern_val, 10),
    tier2_max: parseInt(t2row.pattern_val, 10),
    source: 'learned',
    data_points: t1row.seen_count,
  };
}

export function getSuggestedThresholds(): { tier1_max: number; tier2_max: number } {
  return getLearningStats().suggested_thresholds;
}

// ─── Routing Feedback Loop ────────────────────────────────────────────────────
// Opt-in only. Must be explicitly enabled via setFeedbackEnabled(true).
// Entries expire after FEEDBACK_TTL_DAYS — old signals are automatically ignored.

const FEEDBACK_TTL_DAYS = 30;

export function isFeedbackEnabled(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT pattern_val FROM patterns WHERE pattern_key = ?').get('routing.feedback_enabled') as { pattern_val: string } | undefined;
  return row?.pattern_val === 'true';
}

export function setFeedbackEnabled(enabled: boolean): void {
  const db = getDb();
  const now = new Date().toISOString();
  const val = enabled ? 'true' : 'false';
  const existing = db.prepare('SELECT id FROM patterns WHERE pattern_key = ?').get('routing.feedback_enabled') as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE patterns SET pattern_val = ?, updated_at = ? WHERE pattern_key = ?').run(val, now, 'routing.feedback_enabled');
  } else {
    db.prepare('INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at) VALUES (?, ?, ?, 1, 1, ?)')
      .run(randomUUID(), 'routing.feedback_enabled', val, now);
  }
}

export type RoutingFeedbackEntry = {
  id: string;
  task_hash: string;
  task_snippet: string;
  complexity: number;
  model_tier: number;
  agent: string | null;
  outcome: 'accepted' | 'overridden' | 'pending';
  quality: number | null;
  session_id: string | null;
  recorded_at: string;
  expires_at: string;
};

export function recordRoutingFeedback(opts: {
  task: string;
  complexity: number;
  model_tier: 1 | 2 | 3;
  agent?: string;
  session_id?: string;
}): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + FEEDBACK_TTL_DAYS * 86_400_000).toISOString();
  const task_hash = opts.task.toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  db.prepare(`
    INSERT INTO routing_feedback (id, task_hash, task_snippet, complexity, model_tier, agent, outcome, session_id, recorded_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, task_hash, opts.task.slice(0, 100), opts.complexity, opts.model_tier, opts.agent ?? null, opts.session_id ?? null, now, expiresAt);
  return id;
}

export type RoutingFeedbackStats = {
  enabled: boolean;
  total: number;
  active: number;
  expired: number;
  by_outcome: Record<string, number>;
  by_tier: Record<number, { count: number; avg_quality: number | null }>;
  ttl_days: number;
  next_expiry: string | null;
};

export function getRoutingFeedbackStats(): RoutingFeedbackStats {
  const db = getDb();
  const now = new Date().toISOString();
  const enabled = isFeedbackEnabled();

  const total   = (db.prepare('SELECT COUNT(*) as n FROM routing_feedback').get() as { n: number }).n;
  const active  = (db.prepare('SELECT COUNT(*) as n FROM routing_feedback WHERE expires_at > ?').get(now) as { n: number }).n;
  const expired = total - active;

  const outcomeRows = db.prepare(
    'SELECT outcome, COUNT(*) as n FROM routing_feedback WHERE expires_at > ? GROUP BY outcome'
  ).all(now) as Array<{ outcome: string; n: number }>;
  const by_outcome = Object.fromEntries(outcomeRows.map(r => [r.outcome, r.n]));

  const tierRows = db.prepare(
    'SELECT model_tier, COUNT(*) as n, AVG(quality) as avg_q FROM routing_feedback WHERE expires_at > ? GROUP BY model_tier'
  ).all(now) as Array<{ model_tier: number; n: number; avg_q: number | null }>;
  const by_tier: Record<number, { count: number; avg_quality: number | null }> = {};
  for (const r of tierRows) {
    by_tier[r.model_tier] = { count: r.n, avg_quality: r.avg_q != null ? Math.round(r.avg_q) : null };
  }

  const nextRow = db.prepare(
    'SELECT expires_at FROM routing_feedback WHERE expires_at > ? ORDER BY expires_at ASC LIMIT 1'
  ).get(now) as { expires_at: string } | undefined;

  return { enabled, total, active, expired, by_outcome, by_tier, ttl_days: FEEDBACK_TTL_DAYS, next_expiry: nextRow?.expires_at ?? null };
}

export function resetRoutingFeedback(): { deleted_feedback: number; reset_thresholds: boolean } {
  const db = getDb();
  const fbResult = db.prepare('DELETE FROM routing_feedback').run() as { changes: number };
  const t1 = db.prepare("DELETE FROM patterns WHERE pattern_key = 'router.tier1_max'").run() as { changes: number };
  const t2 = db.prepare("DELETE FROM patterns WHERE pattern_key = 'router.tier2_max'").run() as { changes: number };
  db.prepare("DELETE FROM patterns WHERE pattern_key = 'router.last_apply_count'").run();
  return { deleted_feedback: fbResult.changes, reset_thresholds: t1.changes > 0 || t2.changes > 0 };
}

export function listRoutingFeedback(limit = 20): RoutingFeedbackEntry[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM routing_feedback ORDER BY recorded_at DESC LIMIT ?'
  ).all(limit) as RoutingFeedbackEntry[];
}
