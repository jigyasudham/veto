// Tracks token usage per platform per day against user-configured daily budgets.
// Token counts come from the AI's own token_count reports via veto_status calls.

import { randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';
import { getConfig } from '../memory/config.js';

export type Platform = 'claude' | 'gemini' | 'codex' | 'antigravity';

export type RateLimitEntry = {
  platform: Platform;
  requests_today: number;
  tokens_today: number;
  daily_token_budget: number;
  used_percent: number;
  resets_at: string;
  status: 'normal' | 'warning' | 'critical';
};

export type RateStatus = {
  claude: RateLimitEntry;
  gemini: RateLimitEntry;
  codex: RateLimitEntry;
  antigravity: RateLimitEntry;
  updated_at: string;
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
      'INSERT INTO rate_usage (id, platform, date_key, request_count, token_count) VALUES (?, ?, ?, ?, 0)'
    ).run(randomUUID(), platform, today, count);
  }
}

// Records the AI's reported token count for the current session. Uses MAX so
// the running total only moves forward within a session, and sums across sessions.
export function trackTokens(platform: Platform, tokens: number): void {
  if (tokens <= 0) return;
  const db = getDb();
  const today = getTodayKey();
  const existing = db.prepare(
    'SELECT id, token_count FROM rate_usage WHERE platform = ? AND date_key = ?'
  ).get(platform, today) as { id: string; token_count: number } | undefined;
  if (existing) {
    const updated = Math.max(existing.token_count, tokens);
    db.prepare(
      'UPDATE rate_usage SET token_count = ?, updated_at = ? WHERE id = ?'
    ).run(updated, new Date().toISOString(), existing.id);
  } else {
    db.prepare(
      'INSERT INTO rate_usage (id, platform, date_key, request_count, token_count) VALUES (?, ?, ?, 0, ?)'
    ).run(randomUUID(), platform, today, tokens);
  }
}

function getRow(platform: Platform): { request_count: number; token_count: number } {
  const db = getDb();
  return (db.prepare(
    'SELECT request_count, token_count FROM rate_usage WHERE platform = ? AND date_key = ?'
  ).get(platform, getTodayKey()) as { request_count: number; token_count: number } | undefined)
    ?? { request_count: 0, token_count: 0 };
}

function buildEntry(platform: Platform): RateLimitEntry {
  const { request_count, token_count } = getRow(platform);
  const daily_token_budget = getConfig().dailyTokenBudget[platform];
  const used_percent = Math.min(100, Math.round((token_count / daily_token_budget) * 100));
  let status: 'normal' | 'warning' | 'critical';
  if (used_percent >= 90) status = 'critical';
  else if (used_percent >= 70) status = 'warning';
  else status = 'normal';
  return {
    platform,
    requests_today: request_count,
    tokens_today: token_count,
    daily_token_budget,
    used_percent,
    resets_at: getNextResetISO(),
    status,
  };
}

export function getRateStatus(): RateStatus {
  return {
    claude: buildEntry('claude'),
    gemini: buildEntry('gemini'),
    codex: buildEntry('codex'),
    antigravity: buildEntry('antigravity'),
    updated_at: new Date().toISOString(),
  };
}

// Returns a fallback platform when the preferred one is at warning/critical level
export function getRoutingAdvice(preferred: Platform): Platform {
  const entry = buildEntry(preferred);
  if (entry.status === 'critical') {
    if (preferred === 'claude') return 'gemini';
    if (preferred === 'gemini') return 'antigravity';
    if (preferred === 'antigravity') return 'codex';
    return 'claude';
  }
  if (entry.status === 'warning' && preferred === 'claude') {
    // Tier 1+2 tasks shift to Gemini; caller decides based on tier
    return 'gemini';
  }
  return preferred;
}
