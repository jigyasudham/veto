// Transcript-capture consent & config (VERSION-3 item 6, Step 1).
//
// Capture is OFF until `veto transcripts enable` is run. Enabling records the
// current consent version + timestamp; a later bump of CONSENT_VERSION forces a
// re-consent (the disclosure materially changed). All settings persist in the
// shared ~/.veto/config.json under `transcripts` — no DB table, so Step 1
// touches neither veto.db nor the (not-yet-created) sidecar transcripts.db.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfig, setConfig, type TranscriptsConfig } from '../memory/config.js';

// Bump when the consent disclosure materially changes → users are re-prompted.
export const CONSENT_VERSION = 1;

export const DEFAULT_RETENTION_DAYS = 180;

/**
 * Platform-appropriate, NON-cloud-synced data dir for transcript archives.
 * Deliberately not ~/.veto: on consumer Windows that can be redirected into
 * OneDrive. %LOCALAPPDATA% / Application Support / $XDG_DATA_HOME are local.
 */
export function defaultTranscriptsDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'veto', 'transcripts');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'veto', 'transcripts');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'veto', 'transcripts');
}

/** The effective archive dir: user override when set, else the platform default. */
export function effectiveTranscriptsDir(cfg: TranscriptsConfig = getConfig().transcripts): string {
  return cfg.dir && cfg.dir.trim() ? cfg.dir : defaultTranscriptsDir();
}

/** True only when capture is enabled AND consent matches the current version. */
export function isCaptureEnabled(cfg: TranscriptsConfig = getConfig().transcripts): boolean {
  return cfg.enabled && cfg.consent_version === CONSENT_VERSION;
}

/** Enabled under an older consent version → capture is paused pending re-consent. */
export function needsReconsent(cfg: TranscriptsConfig = getConfig().transcripts): boolean {
  return cfg.enabled && cfg.consent_version !== CONSENT_VERSION;
}

export type EnableResult = {
  dir: string;
  retention_days: number;
  consent_version: number;
  reconsented: boolean;
};

/** Turn capture ON and record consent (version + timestamp). Idempotent. */
export function enableCapture(): EnableResult {
  const current = getConfig().transcripts;
  const reconsented = current.enabled && current.consent_version !== CONSENT_VERSION;
  const retention_days = current.retention_days > 0 ? current.retention_days : DEFAULT_RETENTION_DAYS;
  const next: TranscriptsConfig = {
    ...current,
    enabled: true,
    retention_days,
    consent_version: CONSENT_VERSION,
    consent_at: new Date().toISOString(),
  };
  setConfig({ transcripts: next });
  return { dir: effectiveTranscriptsDir(next), retention_days, consent_version: CONSENT_VERSION, reconsented };
}

/** Turn capture OFF. The consent record is retained as an audit trail. */
export function disableCapture(): void {
  const current = getConfig().transcripts;
  setConfig({ transcripts: { ...current, enabled: false } });
}

/**
 * Returns a one-time note the FIRST time a real capture happens, then null
 * forever after (records first_capture_at). Lets the save response tell the user
 * capture is working without nagging on every save.
 */
export function firstCaptureNote(): string | null {
  const current = getConfig().transcripts;
  if (current.first_capture_at) return null;
  setConfig({ transcripts: { ...current, first_capture_at: new Date().toISOString() } });
  return 'Veto archived this session to your local transcript store (opt-in, on this machine only). '
    + 'Recall past detail later with veto_session_replay; manage with `veto transcripts`.';
}

export type CaptureStatus = {
  enabled: boolean;
  effective: boolean; // enabled AND consent current
  needsReconsent: boolean;
  dir: string;
  usingDefaultDir: boolean;
  retention_days: number;
  consent_version: number | null; // null = never consented
  consent_at: string | null;
  cloudSyncWarning: string | null;
};

export function captureStatus(): CaptureStatus {
  const cfg = getConfig().transcripts;
  const dir = effectiveTranscriptsDir(cfg);
  return {
    enabled: cfg.enabled,
    effective: isCaptureEnabled(cfg),
    needsReconsent: needsReconsent(cfg),
    dir,
    usingDefaultDir: !(cfg.dir && cfg.dir.trim()),
    retention_days: cfg.retention_days > 0 ? cfg.retention_days : DEFAULT_RETENTION_DAYS,
    consent_version: cfg.consent_at ? cfg.consent_version : null,
    consent_at: cfg.consent_at,
    cloudSyncWarning: detectCloudSync(dir),
  };
}

/**
 * Heuristic: warn if the archive path looks like it lives inside a cloud-synced
 * tree, so "machine-local forever" isn't quietly violated. Names the provider
 * when matched; null when the path looks local.
 */
export function detectCloudSync(dir: string): string | null {
  const p = dir.toLowerCase();
  const markers: Array<[RegExp, string]> = [
    [/onedrive/, 'OneDrive'],
    [/dropbox/, 'Dropbox'],
    [/google ?drive|[\\/]my drive/, 'Google Drive'],
    [/[\\/]icloud|com~apple~clouddocs/, 'iCloud'],
  ];
  for (const [re, name] of markers) {
    if (re.test(p)) return name;
  }
  return null;
}

/** Plain-language consent disclosure shown at enable time (what/where/retention/sensitivity/control). */
export function consentText(dir: string, retentionDays: number): string {
  return [
    'Veto transcript capture — what you are turning on:',
    '',
    '  • WHAT: when you save a session, Veto takes a COPY of your host CLI\'s own',
    '    conversation transcript — the AI\'s underlying memory of that session:',
    '    every message you sent, every reply, and all tool activity — and builds',
    '    a searchable index over it so a future session can recall exact detail.',
    '  • THE COPY IS SEPARATE: the original file is left untouched, but Veto\'s copy',
    '    lives on independently. Clearing your AI client\'s history, or the client',
    '    rotating its own logs, will NOT remove it. Only `veto transcripts purge`',
    '    (or the retention window below) deletes a Veto archive.',
    '  • WHERE: archives are stored on THIS machine only, at:',
    `      ${dir}`,
    '    Nothing is uploaded, sent to a server, or shared. No API keys involved.',
    `  • RETENTION: archives older than ${retentionDays} days are pruned automatically`,
    '    (configurable). You can change or turn this off at any time.',
    '  • SENSITIVITY: an archive inherits the sensitivity of everything you typed or',
    '    pasted during that session — including secrets and third parties\' data.',
    '    Detected secrets are masked in the search index and never returned to an',
    '    AI, but treat the archive itself as private data.',
    '  • CONTROL: `veto transcripts disable` stops capture; `veto transcripts purge`',
    '    deletes archives. Capture stays OFF until you enable it.',
  ].join('\n');
}
