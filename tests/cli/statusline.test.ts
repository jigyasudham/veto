import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  composeStatusline,
  installStatusline,
  uninstallStatusline,
  statuslineStatusInfo,
  isStatuslineInstalled,
  statuslineSetupInstruction,
  parseClaudeContextPct,
  type StatuslineData,
} from '../../src/cli/statusline.js';

const FULL: StatuslineData = {
  verdict: 'GREEN', routerPct: 94, contextPct: 42, memCount: 15,
};
const EMPTY: StatuslineData = {
  verdict: null, routerPct: null, contextPct: null, memCount: null,
};

const NO_COLOR = { color: false } as const;

describe('composeStatusline (pure formatter)', () => {
  it('renders the full line in the documented order', () => {
    expect(composeStatusline(FULL, NO_COLOR)).toBe('⬡ veto GREEN · router 94% · ctx 42% · mem 15');
  });

  it('falls back to a neutral line when there is no data (missing/locked DB)', () => {
    expect(composeStatusline(EMPTY, NO_COLOR)).toBe('⬡ veto');
  });

  it('omits only the segments that are missing', () => {
    expect(composeStatusline({ ...EMPTY, verdict: 'RED', memCount: 0 }, NO_COLOR))
      .toBe('⬡ veto RED · mem 0');
  });

  it('drops the ctx segment when live context % is unavailable', () => {
    expect(composeStatusline({ ...EMPTY, verdict: 'GREEN', contextPct: null }, NO_COLOR))
      .toBe('⬡ veto GREEN');
  });

  it('shows ctx 0% (a real reading) rather than dropping it', () => {
    expect(composeStatusline({ ...EMPTY, contextPct: 0 }, NO_COLOR)).toBe('⬡ veto ctx 0%');
  });

  it('uses an ASCII glyph when asked', () => {
    expect(composeStatusline(EMPTY, { color: false, ascii: true })).toBe('# veto');
  });

  it('colors the verdict and a critical context %', () => {
    const line = composeStatusline({ ...FULL, verdict: 'YELLOW', contextPct: 95 }, { color: true });
    expect(line).toContain('\x1b[33mYELLOW\x1b[0m'); // yellow verdict
    expect(line).toContain('\x1b[31mctx 95%\x1b[0m'); // red (critical) context usage
  });

  it('emits no ANSI codes when color is disabled', () => {
    expect(composeStatusline(FULL, NO_COLOR)).not.toContain('\x1b[');
  });
});

describe('parseClaudeContextPct (live session input)', () => {
  it('reads the pre-computed context-window percentage from Claude Code stdin', () => {
    const raw = JSON.stringify({ context_window: { used_percentage: 37.4 } });
    expect(parseClaudeContextPct(raw)).toBe(37); // rounded
  });

  it('clamps out-of-range values into 0..100', () => {
    expect(parseClaudeContextPct(JSON.stringify({ context_window: { used_percentage: 142 } }))).toBe(100);
    expect(parseClaudeContextPct(JSON.stringify({ context_window: { used_percentage: -5 } }))).toBe(0);
  });

  it('returns null when the field is missing or null (early session / post-compact)', () => {
    expect(parseClaudeContextPct(JSON.stringify({ context_window: { used_percentage: null } }))).toBeNull();
    expect(parseClaudeContextPct(JSON.stringify({ model: { display_name: 'Opus' } }))).toBeNull();
    expect(parseClaudeContextPct('{}')).toBeNull();
  });

  it('returns null on malformed / empty input instead of throwing', () => {
    expect(parseClaudeContextPct('not json')).toBeNull();
    expect(parseClaudeContextPct('')).toBeNull();
  });
});

describe('install / uninstall settings.json patch', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'veto-sl-'));
    settingsPath = join(dir, 'settings.json');
    process.env.VETO_STATUSLINE_SETTINGS = settingsPath;
  });

  afterEach(() => {
    delete process.env.VETO_STATUSLINE_SETTINGS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs into a fresh (nonexistent) settings file, then uninstall removes it', () => {
    const r = installStatusline('claude');
    expect(r.ok && r.changed).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toEqual({ type: 'command', command: 'veto statusline print' });

    const u = uninstallStatusline('claude');
    expect(u.ok).toBe(true);
    // No original file existed → file is removed entirely on uninstall.
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('preserves an existing user statusLine and restores it byte-for-byte on uninstall', () => {
    const original = JSON.stringify({
      theme: 'dark',
      statusLine: { type: 'command', command: 'my-custom-line' },
    }, null, 4) + '\n';
    writeFileSync(settingsPath, original, 'utf8');

    // Without --force it must refuse to clobber the user's statusLine.
    const refused = installStatusline('claude');
    expect(refused.ok).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original); // untouched

    // With --force it installs ours but backs up the original.
    const forced = installStatusline('claude', { force: true });
    expect(forced.ok && forced.changed).toBe(true);
    const patched = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(patched.statusLine.command).toBe('veto statusline print');
    expect(patched.theme).toBe('dark'); // other keys preserved

    // Uninstall restores the original file exactly.
    const u = uninstallStatusline('claude');
    expect(u.ok).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('preserves unrelated keys when installing into an existing file with no statusLine', () => {
    const original = JSON.stringify({ theme: 'light', model: 'opus' }, null, 2) + '\n';
    writeFileSync(settingsPath, original, 'utf8');

    const r = installStatusline('claude');
    expect(r.ok && r.changed).toBe(true);
    const patched = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(patched.theme).toBe('light');
    expect(patched.model).toBe('opus');
    expect(patched.statusLine.command).toBe('veto statusline print');

    const u = uninstallStatusline('claude');
    expect(u.ok).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original); // byte-for-byte
  });

  it('refuses to touch a settings file that is not valid JSON', () => {
    writeFileSync(settingsPath, '{ not valid json', 'utf8');
    const r = installStatusline('claude');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not valid JSON/);
  });

  it('is idempotent — re-installing reports already installed and does not change the file', () => {
    installStatusline('claude');
    const after1 = readFileSync(settingsPath, 'utf8');
    const r2 = installStatusline('claude');
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(after1);
  });

  it('dry-run reports the change without writing', () => {
    const r = installStatusline('claude', { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('status reports installed state and a sample render', () => {
    expect(statuslineStatusInfo('claude').installed).toBe(false);
    installStatusline('claude');
    const info = statuslineStatusInfo('claude');
    expect(info.installed).toBe(true);
    expect(info.settingsPath).toBe(settingsPath);
    expect(info.sample).toContain('veto');
  });

  it('rejects unknown clients', () => {
    expect(installStatusline('emacs').ok).toBe(false);
    expect(uninstallStatusline('emacs').ok).toBe(false);
  });
});

describe('first-run setup nudge (MCP instructions)', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'veto-sl-'));
    settingsPath = join(dir, 'settings.json');
    process.env.VETO_STATUSLINE_SETTINGS = settingsPath;
  });

  afterEach(() => {
    delete process.env.VETO_STATUSLINE_SETTINGS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-installed and offers the nudge before install', () => {
    expect(isStatuslineInstalled('claude')).toBe(false);
    const tip = statuslineSetupInstruction('claude');
    expect(tip).toBeDefined();
    expect(tip).toMatch(/veto statusline install/);
  });

  it('reports installed and drops the nudge once installed (self-resolving)', () => {
    installStatusline('claude');
    expect(isStatuslineInstalled('claude')).toBe(true);
    expect(statuslineSetupInstruction('claude')).toBeUndefined();
  });

  it('treats an unknown client as not installed (no nudge crash)', () => {
    expect(isStatuslineInstalled('emacs')).toBe(false);
    expect(statuslineSetupInstruction('emacs')).toBeDefined();
  });
});
