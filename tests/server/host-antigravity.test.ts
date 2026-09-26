// Antigravity reports itself as "antigravity-client" (observed 2026-09-26). It
// matched no marker, so saves were labelled "claude", resumes went unrecorded,
// and a model that declared "gemini" sent capture to Gemini CLI's files.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyHost, classifyHostApp, detectHostApp, detectHostPlatform, hostHasNoTranscript, recordHostClient, resetHostClient } from '../../src/host.js';
import { callTool } from '../../src/server.js';
import { getDb } from '../../src/memory/local.js';

beforeEach(() => { resetHostClient(); getDb().exec('DELETE FROM sessions'); });
afterEach(() => resetHostClient());

const json = (res: any) => { const t = res.content[0].text as string; return JSON.parse(t.slice(t.indexOf('{'))); };

describe('Antigravity is its own app', () => {
  it('is recognised by name, is not Gemini CLI, and has no capturable transcript', () => {
    expect(classifyHostApp('antigravity-client')).toBe('antigravity');
    expect(classifyHost('antigravity-client')).toBeNull(); // not a capture platform
    expect(classifyHostApp('gemini-cli-mcp-client')).toBe('gemini');
    expect(classifyHostApp('claude-code')).toBe('claude');
    recordHostClient({ name: 'antigravity-client', version: '1.2.2' });
    expect(detectHostApp()).toBe('antigravity');
    expect(detectHostPlatform()).toBeNull();
    expect(hostHasNoTranscript()).toBe(true);
  });

  it('labels a save made through Antigravity "antigravity", even when the model says "gemini"', async () => {
    recordHostClient({ name: 'antigravity-client', version: '1.2.2' });
    const saved = json(await callTool({ params: { name: 'veto_session_save', arguments: { summary: 's', context: 'c', platform: 'gemini' } } }));
    const row = getDb().prepare('SELECT platform FROM sessions WHERE id = ?').get(saved.session_id) as { platform: string };
    expect(row.platform).toBe('antigravity');
    expect(saved.platform_note ?? saved.note ?? JSON.stringify(saved)).toMatch(/recorded antigravity/);
  });

  it('records Antigravity as the active client when it resumes a session', async () => {
    recordHostClient({ name: 'claude-code' });
    const saved = json(await callTool({ params: { name: 'veto_session_save', arguments: { summary: 'from claude', context: 'c' } } }));
    resetHostClient();
    recordHostClient({ name: 'antigravity-client' });
    const restored = json(await callTool({ params: { name: 'veto_continue', arguments: { session_id: saved.session_id.slice(0, 8) } } }));
    expect(restored).toMatchObject({ saved_by: 'claude', active_client: 'antigravity' });
  });
});
