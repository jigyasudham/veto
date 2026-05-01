// Tracks request counts per platform per day, exposes routing advice
// Veto cannot read actual API rate limits — it tracks its own routed requests
// and lets users configure their daily limits in patterns table

import { randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';

export type Platform = 'claude' | 'gemini' | 'codex';

export type RateLimitEntry = {
  platform: Platform;
  requests_today: number;
  daily_limit: number;
  used_percent: number;
  resets_at: string;
  status: 'normal' | 'warning' | 'critical';
};

export type RateStatus = {
  claude: RateLimitEntry;
  gemini: RateLimitEntry;
  codex: RateLimitEntry;
  updated_at: string;
};

const DEFAULT_LIMITS: Record<Platform, number> = {
  claude: 100,
  gemini: 200,
  codex: 150,
};

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getNextResetISO(): string {
  const reset = new Date();
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

export function trackRequest(platform: Platform, count = 1): void {
  const db = getDb();
  const today = getTodayKey();

  const existing = db.prepare(
    'SELECT id, request_count FROM rate_usage WHERE platform = ? AND date_key = ?'
  ).get(platform, today) as { id: string; request_count: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE rate_usage SET request_count = ?, updated_at = ? WHERE id = ?'
    ).run(existing.request_count + count, new Date().toISOString(), existing.id);
  } else {
    db.prepare(
      'INSERT INTO rate_usage (id, platform, date_key, request_count) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), platform, today, count);
  }
}

function getRequestCount(platform: Platform): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT request_count FROM rate_usage WHERE platform = ? AND date_key = ?'
  ).get(platform, getTodayKey()) as { request_count: number } | undefined;
  return row?.request_count ?? 0;
}

function buildEntry(platform: Platform): RateLimitEntry {
  const requests_today = getRequestCount(platform);
  const daily_limit = DEFAULT_LIMITS[platform];
  const used_percent = Math.min(100, Math.round((requests_today / daily_limit) * 100));
  let status: 'normal' | 'warning' | 'critical';
  if (used_percent >= 90) status = 'critical';
  else if (used_percent >= 70) status = 'warning';
  else status = 'normal';
  return { platform, requests_today, daily_limit, used_percent, resets_at: getNextResetISO(), status };
}

export function getRateStatus(): RateStatus {
  return {
    claude: buildEntry('claude'),
    gemini: buildEntry('gemini'),
    codex: buildEntry('codex'),
    updated_at: new Date().toISOString(),
  };
}

// Returns a fallback platform when the preferred one is at warning/critical level
export function getRoutingAdvice(preferred: Platform): Platform {
  const entry = buildEntry(preferred);
  if (entry.status === 'critical') {
    if (preferred === 'claude') return 'gemini';
    if (preferred === 'gemini') return 'codex';
    return 'claude';
  }
  if (entry.status === 'warning' && preferred === 'claude') {
    // Tier 1+2 tasks shift to Gemini; caller decides based on tier
    return 'gemini';
  }
  return preferred;
}
