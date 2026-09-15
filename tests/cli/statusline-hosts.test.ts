import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';

// The Veto line for AI CLIs that cannot run one. Codex records are laid out
// as a real Codex 0.154 rollout writes them (session_meta, then token_count
// events carrying last_token_usage, model_context_window and rate_limits).
const ROOT = join(tmpdir(), `veto-statusline-hosts-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.GEMINI_DIR = join(ROOT, 'gemini');
process.env.CLAUDE_CONFIG_DIR = join(ROOT, 'claude');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');

const { codexGauges, readHostLive, detectWatchHost, formatAge, renderHostStatusline, watchSetupGuide } = await import('../../src/cli/statusline-hosts.js');
const { composeStatusline } = await import('../../src/cli/statusline.js');
const { claudeProjectSlug } = await import('../../src/transcripts/claude-paths.js');

const PROJECT = 'D:\\Watch Project';
const CODEX_SESSION = '019f0000-aaaa-7bbb-8ccc-000000000001';

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['CODEX_HOME', 'GEMINI_DIR', 'CLAUDE_CONFIG_DIR', 'VETO_TRANSCRIPTS_DIR']) delete process.env[k];
});

function tokenCount(used: number, window: number, primary: { used: number; minutes: number } | null, secondary: { used: number; minutes: number } | null = null): string {
  const rate = (w: { used: number; minutes: number } | null) => (w ? { used_percent: w.used, window_minutes: w.minutes, resets_at: 1_800_000_000 } : null);
  return JSON.stringify({
    timestamp: '2026-09-15T10:00:00.000Z', ordinal: 1, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: used * 3 }, last_token_usage: { total_tokens: used }, model_context_window: window },
      rate_limits: { limit_id: 'codex', limit_name: null, primary: rate(primary), secondary: rate(secondary), plan_type: 'plus' },
    },
  });
}

function codexRollout(project: string, sessionId: string, lines: string[], ageMs = 0): string {
  const day = join(ROOT, 'codex', 'sessions', '2026', '09', '15');
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-09-15T10-00-00-${sessionId}.jsonl`);
  const meta = JSON.stringify({ timestamp: '2026-09-15T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: project, cli_version: '0.154.0' } });
  writeFileSync(path, [meta, ...lines].join('\n') + '\n');
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(path, t, t); }
  return path;
}

describe('Codex gauges from its own session file', () => {
  it('reads context use and both rate-limit windows from the last token_count event', () => {
    const tail = ['{"cut mid-record', tokenCount(10_000, 100_000, { used: 5, minutes: 300 }), tokenCount(64_000, 258_400, { used: 23, minutes: 300 }, { used: 71, minutes: 10_080 })].join('\n');
    expect(codexGauges(tail)).toEqual({ contextPct: 25, rate5hPct: 23, rate7dPct: 71 });
  });

  it('shows nothing it cannot read', () => {
    expect(codexGauges('{"type":"event_msg","payload":{"type":"agent_message"}}')).toEqual({ contextPct: null, rate5hPct: null, rate7dPct: null });
  });
});

describe('the live session in this folder', () => {
  beforeEach(() => rmSync(join(ROOT, 'codex'), { recursive: true, force: true }));

  it("finds the folder's Codex session, whatever case the folder is written in", () => {
    codexRollout(PROJECT, CODEX_SESSION, [tokenCount(51_680, 258_400, { used: 12, minutes: 300 })]);
    codexRollout('D:\\Somewhere Else', '019f0000-aaaa-7bbb-8ccc-000000000002', [tokenCount(1, 2, null)]);
    const live = readHostLive('codex', process.platform === 'win32' ? 'd:\\watch project' : PROJECT);
    expect(live).toMatchObject({ host: 'codex', session: CODEX_SESSION, contextPct: 20, rate5hPct: 12 });
  });

  it('follows whichever AI worked in the folder last', () => {
    codexRollout(PROJECT, CODEX_SESSION, [], 60 * 60 * 1000);
    const folder = join(ROOT, 'claude', 'projects', claudeProjectSlug(PROJECT));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'aaaaaaaa-0000-4000-8000-00000000000a.jsonl'), '{}\n');
    expect(detectWatchHost(PROJECT)).toBe('claude');
  });

  it('reports a Gemini session without inventing gauges', () => {
    const gdir = join(ROOT, 'gemini', 'tmp', 'watch-project');
    mkdirSync(join(gdir, 'chats'), { recursive: true });
    writeFileSync(join(gdir, '.project_root'), PROJECT);
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    writeFileSync(join(gdir, 'chats', 'session-2026-09-15T10-00-bbbbbbbb.jsonl'), JSON.stringify({ sessionId: id, projectHash: 'x' }) + '\n');
    expect(readHostLive('gemini', PROJECT)).toMatchObject({ session: id, contextPct: null, rate5hPct: null, rate7dPct: null });
  });
});

describe('the rendered line', () => {
  it('adds the host session and archived chats after the usual segments', () => {
    const line = composeStatusline({
      verdict: 'GREEN', routerPct: 72, contextPct: 41, rate5hPct: 12, rate7dPct: null, memCount: 13,
      host: { name: 'codex', session: CODEX_SESSION, age: '2m ago' }, chats: 3,
    }, { color: false, ascii: true });
    expect(line).toBe('# veto GREEN · router 72% · ctx 41% · 5h 12% · mem 13 · codex 019f0000 2m ago · chats 3');
  });

  it('renders end to end for a folder with no session yet', () => {
    rmSync(join(ROOT, 'codex'), { recursive: true, force: true });
    expect(renderHostStatusline('codex', 'D:\\Empty Folder', { color: false, ascii: true })).toContain('codex no session yet');
  });

  it('formats ages the way a glance needs', () => {
    const now = Date.now();
    expect([formatAge(now - 10_000, now), formatAge(now - 5 * 60_000, now), formatAge(now - 3 * 3_600_000, now), formatAge(now - 2 * 86_400_000, now)])
      .toEqual(['now', '5m ago', '3h ago', '2d ago']);
  });
});

describe('setup for a host that cannot run a status line', () => {
  it.each(['codex', 'gemini'] as const)('explains the split-pane option for %s and changes nothing', (host) => {
    const guide = watchSetupGuide(host, PROJECT);
    expect(guide).toContain(`veto statusline watch --client=${host}`);
    expect(guide).toMatch(/cannot run a custom status line/);
    expect(guide).toContain('wt -w 0 split-pane');
  });
});
