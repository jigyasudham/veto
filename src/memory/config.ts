import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type VetoConfig = {
  dailyTokenBudget: {
    claude: number;
    gemini: number;
    codex: number;
    antigravity: number;
  };
  billing_mode: 'subscription' | 'api';
  // When true (default), the router auto-applies learned tier thresholds every
  // 20 recorded outcomes — no manual veto_learning_apply needed.
  auto_apply_learning: boolean;
};

const CONFIG_PATH = join(homedir(), '.veto', 'config.json');

export const DEFAULT_BUDGETS: VetoConfig['dailyTokenBudget'] = {
  claude:  500_000,
  gemini: 1_000_000,
  codex:   200_000,
  antigravity: 1_000_000,
};

export function getConfig(): VetoConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { dailyTokenBudget: { ...DEFAULT_BUDGETS }, billing_mode: 'subscription', auto_apply_learning: true };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<VetoConfig>;
    return {
      dailyTokenBudget: {
        claude:  raw.dailyTokenBudget?.claude  ?? DEFAULT_BUDGETS.claude,
        gemini:  raw.dailyTokenBudget?.gemini  ?? DEFAULT_BUDGETS.gemini,
        codex:   raw.dailyTokenBudget?.codex   ?? DEFAULT_BUDGETS.codex,
        antigravity: raw.dailyTokenBudget?.antigravity ?? DEFAULT_BUDGETS.antigravity,
      },
      billing_mode: raw.billing_mode === 'api' ? 'api' : 'subscription',
      auto_apply_learning: raw.auto_apply_learning !== false, // default true
    };
  } catch {
    return { dailyTokenBudget: { ...DEFAULT_BUDGETS }, billing_mode: 'subscription', auto_apply_learning: true };
  }
}

export function setConfig(partial: Partial<VetoConfig>): void {
  const current = getConfig();
  const next: VetoConfig = {
    ...current,
    ...partial,
    dailyTokenBudget: {
      ...current.dailyTokenBudget,
      ...(partial.dailyTokenBudget ?? {}),
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
}
