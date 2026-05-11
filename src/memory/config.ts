import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type VetoConfig = {
  dailyTokenBudget: {
    claude: number;
    gemini: number;
    codex: number;
  };
};

const CONFIG_PATH = join(homedir(), '.veto', 'config.json');

export const DEFAULT_BUDGETS: VetoConfig['dailyTokenBudget'] = {
  claude:  500_000,
  gemini: 1_000_000,
  codex:   200_000,
};

export function getConfig(): VetoConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { dailyTokenBudget: { ...DEFAULT_BUDGETS } };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<VetoConfig>;
    return {
      dailyTokenBudget: {
        claude:  raw.dailyTokenBudget?.claude  ?? DEFAULT_BUDGETS.claude,
        gemini:  raw.dailyTokenBudget?.gemini  ?? DEFAULT_BUDGETS.gemini,
        codex:   raw.dailyTokenBudget?.codex   ?? DEFAULT_BUDGETS.codex,
      },
    };
  } catch {
    return { dailyTokenBudget: { ...DEFAULT_BUDGETS } };
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
