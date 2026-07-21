import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// Per-machine transcript-capture settings (VERSION-3 item 6). Capture is OFF
// until the user runs `veto transcripts enable`; enabling records the consent
// version + timestamp here. `dir: ''` means "use the platform default" — the
// effective path is resolved in src/transcripts/config.ts so this stays dumb
// storage with no platform logic.
export type TranscriptsConfig = {
  enabled: boolean;
  dir: string;
  retention_days: number;
  consent_version: number; // 0 = never consented
  consent_at: string | null;
  first_capture_at: string | null; // set on first real capture; drives the one-time note
};

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
  // When true, ListTools advertises only the compact surface (core tools +
  // veto_find_tools/veto_call) instead of all 89 schemas. Env VETO_COMPACT
  // overrides. All tools remain directly callable in both modes.
  compact_tools: boolean;
  transcripts: TranscriptsConfig;
};

// VETO_CONFIG_PATH overrides the config location (tests isolate here, mirroring
// VETO_TEST_DB). Read per-call so the override applies even after this module
// has already been imported transitively.
function configPath(): string {
  return process.env.VETO_CONFIG_PATH ?? join(homedir(), '.veto', 'config.json');
}

// Local planning heuristics, NOT provider quotas. Veto has no visibility into
// real subscription limits — these only drive the warning/critical coloring in
// rate status. Users set their own numbers in ~/.veto/config.json.
export const DEFAULT_BUDGETS: VetoConfig['dailyTokenBudget'] = {
  claude:  500_000,
  gemini: 1_000_000,
  codex:   200_000,
  antigravity: 1_000_000,
};

export const DEFAULT_TRANSCRIPTS: TranscriptsConfig = {
  enabled: false,
  dir: '',
  retention_days: 180,
  consent_version: 0,
  consent_at: null,
  first_capture_at: null,
};

function normalizeTranscripts(raw: Partial<TranscriptsConfig> | undefined): TranscriptsConfig {
  return {
    enabled: raw?.enabled === true,
    dir: typeof raw?.dir === 'string' ? raw.dir : '',
    retention_days: typeof raw?.retention_days === 'number' && raw.retention_days > 0
      ? raw.retention_days
      : DEFAULT_TRANSCRIPTS.retention_days,
    consent_version: typeof raw?.consent_version === 'number' ? raw.consent_version : 0,
    consent_at: typeof raw?.consent_at === 'string' ? raw.consent_at : null,
    first_capture_at: typeof raw?.first_capture_at === 'string' ? raw.first_capture_at : null,
  };
}

export function getConfig(): VetoConfig {
  if (!existsSync(configPath())) {
    return {
      dailyTokenBudget: { ...DEFAULT_BUDGETS },
      billing_mode: 'subscription',
      auto_apply_learning: true,
      compact_tools: false,
      transcripts: { ...DEFAULT_TRANSCRIPTS },
    };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<VetoConfig>;
    return {
      dailyTokenBudget: {
        claude:  raw.dailyTokenBudget?.claude  ?? DEFAULT_BUDGETS.claude,
        gemini:  raw.dailyTokenBudget?.gemini  ?? DEFAULT_BUDGETS.gemini,
        codex:   raw.dailyTokenBudget?.codex   ?? DEFAULT_BUDGETS.codex,
        antigravity: raw.dailyTokenBudget?.antigravity ?? DEFAULT_BUDGETS.antigravity,
      },
      billing_mode: raw.billing_mode === 'api' ? 'api' : 'subscription',
      auto_apply_learning: raw.auto_apply_learning !== false, // default true
      compact_tools: raw.compact_tools === true, // default false
      transcripts: normalizeTranscripts(raw.transcripts),
    };
  } catch {
    return {
      dailyTokenBudget: { ...DEFAULT_BUDGETS },
      billing_mode: 'subscription',
      auto_apply_learning: true,
      compact_tools: false,
      transcripts: { ...DEFAULT_TRANSCRIPTS },
    };
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
    transcripts: partial.transcripts ?? current.transcripts,
  };
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}
