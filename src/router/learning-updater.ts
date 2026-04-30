// Records routing outcomes to SQLite and adjusts tier thresholds from historical quality data

import { randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';

export type LearningStats = {
  total_tasks: number;
  tier_breakdown: Record<number, { count: number; avg_quality: number }>;
  suggested_thresholds: { tier1_max: number; tier2_max: number };
};

export function recordOutcome(
  taskType: string,
  complexity: number,
  modelTier: 1 | 2 | 3,
  agent: string,
  outputQuality: number,
  tokensUsed = 0
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO learning_data (id, task_type, complexity, model_tier, output_quality, tokens_used, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), taskType, complexity, modelTier, outputQuality, tokensUsed, agent);
}

export function getLearningStats(): LearningStats {
  const db = getDb();

  const rows = db.prepare(
    `SELECT model_tier, COUNT(*) as count, AVG(output_quality) as avg_quality
     FROM learning_data
     GROUP BY model_tier`
  ).all() as Array<{ model_tier: number; count: number; avg_quality: number }>;

  const total_tasks = rows.reduce((sum, r) => sum + r.count, 0);

  const tier_breakdown: Record<number, { count: number; avg_quality: number }> = {};
  for (const r of rows) {
    tier_breakdown[r.model_tier] = {
      count: r.count,
      avg_quality: Math.round((r.avg_quality ?? 0) * 100) / 100,
    };
  }

  // If Tier 2 consistently scores above 90% quality, some tasks could be Tier 1
  const t2avg = tier_breakdown[2]?.avg_quality ?? 0.8;
  const t3avg = tier_breakdown[3]?.avg_quality ?? 0.8;
  const tier1_max = t2avg > 90 ? 35 : 30;
  const tier2_max = t3avg > 90 ? 75 : 70;

  return { total_tasks, tier_breakdown, suggested_thresholds: { tier1_max, tier2_max } };
}

export function getSuggestedThresholds(): { tier1_max: number; tier2_max: number } {
  return getLearningStats().suggested_thresholds;
}
