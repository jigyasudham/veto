import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

// Isolate config to a temp file BEFORE importing the config layer, mirroring the
// VETO_TEST_DB pattern — so these tests never touch the real ~/.veto/config.json.
const TEST_CFG = join(tmpdir(), `veto-transcripts-cfg-${Date.now()}-${process.pid}.json`);
process.env.VETO_CONFIG_PATH = TEST_CFG;

const {
  CONSENT_VERSION,
  DEFAULT_RETENTION_DAYS,
  defaultTranscriptsDir,
  effectiveTranscriptsDir,
  isCaptureEnabled,
  needsReconsent,
  enableCapture,
  disableCapture,
  captureStatus,
  detectCloudSync,
  consentText,
} = await import('../../src/transcripts/config.js');
const { getConfig, setConfig } = await import('../../src/memory/config.js');

function clearCfg() {
  try { rmSync(TEST_CFG); } catch { /* ignore */ }
}

beforeEach(clearCfg);
afterAll(clearCfg);

describe('transcripts config — defaults (capture OFF until enabled)', () => {
  it('defaults to disabled, 180-day retention, default dir, never-consented', () => {
    const s = captureStatus();
    expect(s.enabled).toBe(false);
    expect(s.effective).toBe(false);
    expect(s.needsReconsent).toBe(false);
    expect(s.retention_days).toBe(DEFAULT_RETENTION_DAYS);
    expect(s.retention_days).toBe(180);
    expect(s.usingDefaultDir).toBe(true);
    expect(s.consent_version).toBeNull();
    expect(s.consent_at).toBeNull();
  });

  it('resolves a platform-appropriate, non-cloud default dir ending in veto/transcripts', () => {
    const dir = defaultTranscriptsDir().replace(/\\/g, '/');
    expect(dir.endsWith('veto/transcripts')).toBe(true);
    // The default location must never itself look cloud-synced.
    expect(detectCloudSync(defaultTranscriptsDir())).toBeNull();
  });
});

describe('enable / disable', () => {
  it('enable turns capture on and records consent (version + timestamp)', () => {
    const r = enableCapture();
    expect(r.consent_version).toBe(CONSENT_VERSION);
    expect(r.reconsented).toBe(false);

    const s = captureStatus();
    expect(s.enabled).toBe(true);
    expect(s.effective).toBe(true);
    expect(s.consent_version).toBe(CONSENT_VERSION);
    expect(typeof s.consent_at).toBe('string');
    expect(Number.isNaN(Date.parse(s.consent_at!))).toBe(false);
    expect(isCaptureEnabled()).toBe(true);
  });

  it('disable turns capture off but retains the consent record', () => {
    enableCapture();
    disableCapture();
    const s = captureStatus();
    expect(s.enabled).toBe(false);
    expect(s.effective).toBe(false);
    expect(isCaptureEnabled()).toBe(false);
    // Consent audit trail survives a disable.
    expect(s.consent_at).not.toBeNull();
    expect(s.consent_version).toBe(CONSENT_VERSION);
  });
});

describe('consent versioning', () => {
  it('capture is paused (needs re-consent) when enabled under a stale consent version', () => {
    // Simulate a user who enabled under an older disclosure.
    const cfg = getConfig();
    setConfig({ transcripts: { ...cfg.transcripts, enabled: true, consent_version: 0, consent_at: '2026-01-01T00:00:00.000Z' } });

    expect(isCaptureEnabled()).toBe(false);
    expect(needsReconsent()).toBe(true);
    expect(captureStatus().needsReconsent).toBe(true);
  });

  it('re-enabling after a stale version re-records consent and flags reconsented', () => {
    const cfg = getConfig();
    setConfig({ transcripts: { ...cfg.transcripts, enabled: true, consent_version: 0, consent_at: '2026-01-01T00:00:00.000Z' } });

    const r = enableCapture();
    expect(r.reconsented).toBe(true);
    expect(r.consent_version).toBe(CONSENT_VERSION);
    expect(isCaptureEnabled()).toBe(true);
  });
});

describe('archive dir resolution + cloud-sync guard', () => {
  it('honors a user override and reports it as non-default', () => {
    const cfg = getConfig();
    const custom = join(tmpdir(), 'my-veto-archives');
    setConfig({ transcripts: { ...cfg.transcripts, dir: custom } });
    expect(effectiveTranscriptsDir()).toBe(custom);
    expect(captureStatus().usingDefaultDir).toBe(false);
  });

  it('flags cloud-synced override paths and names the provider', () => {
    expect(detectCloudSync('C:/Users/me/OneDrive/veto/transcripts')).toBe('OneDrive');
    expect(detectCloudSync('/Users/me/Dropbox/veto')).toBe('Dropbox');
    expect(detectCloudSync('C:/Users/me/My Drive/veto')).toBe('Google Drive');
    expect(detectCloudSync('/Users/me/.local/share/veto/transcripts')).toBeNull();
  });
});

describe('consent disclosure text', () => {
  it('states where archives live, the retention window, and the sensitivity/control notice', () => {
    const dir = '/tmp/veto/transcripts';
    const text = consentText(dir, 180);
    expect(text).toContain(dir);
    expect(text).toContain('180 days');
    expect(text).toContain('THIS machine only');
    expect(text.toLowerCase()).toContain('third parties');
    expect(text).toContain('veto transcripts disable');
  });
});

describe('config file isolation', () => {
  it('persists to the VETO_CONFIG_PATH temp file, not the real config', () => {
    enableCapture();
    expect(existsSync(TEST_CFG)).toBe(true);
  });
});
