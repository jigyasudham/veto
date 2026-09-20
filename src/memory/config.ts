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

// Harvest-and-Share is separate from transcript capture. It is OFF until the
// user explicitly accepts the wider cross-project and cross-vendor disclosure.
export type LessonsConfig = {
  enabled: boolean;
  consent_version: number;
  consent_at: string | null;
  cross_project: boolean;
  cross_vendor: boolean;
  /**
   * Whether saving a session also re-reads each AI's memory. On by default:
   * recording notes by hand is the thing that never happens. Turning it off
   * leaves consent and every `veto lessons` command working, so a problem in
   * the field is one setting away from being stopped (council 534e2bd5).
   */
  harvest_on_save: boolean;
  /** When saving a session first harvested; the one-time note is shown once. */
  first_harvest_at: string | null;
};

// Consent v2 covers the trial only: reading notes and logging what would have
// been shared. Its disclosure PROMISES to ask again before any note is given to
// an AI (owner, 2026-09-20), so the release that starts delivery must bump this
// to 3, which pauses sharing until each user accepts the new disclosure.
export const LESSONS_CONSENT_VERSION = 2;
export const DEFAULT_LESSONS: LessonsConfig = {
  enabled: false,
  consent_version: 0,
  consent_at: null,
  cross_project: false,
  cross_vendor: false,
  harvest_on_save: true,
  first_harvest_at: null,
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
  lessons: LessonsConfig;
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

function normalizeLessons(raw: Partial<LessonsConfig> | undefined): LessonsConfig {
  return {
    enabled: raw?.enabled === true,
    consent_version: typeof raw?.consent_version === 'number' ? raw.consent_version : 0,
    consent_at: typeof raw?.consent_at === 'string' ? raw.consent_at : null,
    cross_project: raw?.cross_project === true,
    cross_vendor: raw?.cross_vendor === true,
    harvest_on_save: raw?.harvest_on_save !== false,
    first_harvest_at: typeof raw?.first_harvest_at === 'string' ? raw.first_harvest_at : null,
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
      lessons: { ...DEFAULT_LESSONS },
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
      lessons: normalizeLessons(raw.lessons),
    };
  } catch {
    return {
      dailyTokenBudget: { ...DEFAULT_BUDGETS },
      billing_mode: 'subscription',
      auto_apply_learning: true,
      compact_tools: false,
      transcripts: { ...DEFAULT_TRANSCRIPTS },
      lessons: { ...DEFAULT_LESSONS },
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
    lessons: partial.lessons ?? current.lessons,
  };
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** Explicit v2 opt-in. No version upgrade can silently enable sharing. */
export function enableLessonsSharing(): LessonsConfig {
  const lessons: LessonsConfig = {
    enabled: true,
    consent_version: LESSONS_CONSENT_VERSION,
    consent_at: new Date().toISOString(),
    cross_project: true,
    cross_vendor: true,
    // Turning sharing on keeps the switch the user last chose, so a machine
    // that had harvest-on-save off does not silently get it back.
    harvest_on_save: getConfig().lessons.harvest_on_save,
    first_harvest_at: getConfig().lessons.first_harvest_at,
  };
  setConfig({ lessons });
  return lessons;
}

export function disableLessonsSharing(): void {
  const current = getConfig().lessons;
  setConfig({ lessons: { ...current, enabled: false, cross_project: false, cross_vendor: false } });
}

/** True once, the first time a save harvests, so the user is told it happens. */
export function firstHarvestOnSave(): boolean {
  const current = getConfig().lessons;
  if (current.first_harvest_at) return false;
  setConfig({ lessons: { ...current, first_harvest_at: new Date().toISOString() } });
  return true;
}

/** Whether a session save should also re-read each AI's memory. */
export function isHarvestOnSaveEnabled(config: LessonsConfig = getConfig().lessons): boolean {
  return isLessonsSharingEnabled(config) && config.harvest_on_save !== false;
}

export function isLessonsSharingEnabled(config: LessonsConfig = getConfig().lessons): boolean {
  return config.enabled
    && config.consent_version === LESSONS_CONSENT_VERSION
    && config.cross_project
    && config.cross_vendor;
}
