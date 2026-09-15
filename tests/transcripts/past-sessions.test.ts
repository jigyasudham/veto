import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// Past sessions are put to work by the tools themselves: one project, one saved
// Veto session, worked on first in Claude Code and then in Codex.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(tmpdir(), `veto-past-sessions-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TEST_DB = join(ROOT, 'veto.db');
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');
process.env.CLAUDE_CONFIG_DIR = join(ROOT, 'claude');
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.GEMINI_DIR = join(ROOT, 'gemini');

const { enableCapture, disableCapture } = await import('../../src/transcripts/config.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const { claudeProjectSlug } = await import('../../src/transcripts/claude-paths.js');
const { pastSessionHits, pastSessionChats, withPastSessions } = await import('../../src/transcripts/context.js');
const { saveSession, resetDb } = await import('../../src/memory/local.js');
const { sessionHandlers } = await import('../../src/server/handlers/session.js');
const { memoryHandlers } = await import('../../src/server/handlers/memory.js');
const { buildAgenticAgentPrompt } = await import('../../src/agents/llm-runner.js');
const { councilHandlers } = await import('../../src/server/handlers/council.js');
const { runLlmDebate } = await import('../../src/council/llm-council.js');

const FIXTURES = join(__dirname, 'fixtures');
const PROJECT = 'D:\\Past Project';
let vetoSession = '';

beforeAll(async () => {
  enableCapture();
  vetoSession = saveSession({ summary: 'login form and key rotation', platform: 'claude', project_dir: PROJECT }).session_id;

  // Claude Code: the login-form chat.
  const claudeFolder = join(ROOT, 'claude', 'projects', claudeProjectSlug(PROJECT));
  mkdirSync(claudeFolder, { recursive: true });
  const claudeId = 'dddddddd-0000-4000-8000-000000000001';
  writeFileSync(join(claudeFolder, `${claudeId}.jsonl`), readFileSync(join(FIXTURES, 'claude-sample.jsonl'), 'utf8').replace(/FIXA/g, claudeId));
  expect((await captureOnSave({ projectDir: PROJECT, vetoSessionId: vetoSession, platform: 'claude' }))?.status).toBe('archived');

  // Codex: the key-rotation chat, same project, same saved session.
  const codexId = 'eeeeeeee-0000-4000-8000-000000000001';
  const day = join(ROOT, 'codex', 'sessions', '2026', '09', '15');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-15T11-00-00-${codexId}.jsonl`), readFileSync(join(FIXTURES, 'codex-sample.jsonl'), 'utf8')
    .replace(/"id":"CODEXA"/, `"id":"${codexId}"`)
    .replace(/D:\\\\Job automation/g, PROJECT.replace(/\\/g, '\\\\')));
  expect((await captureOnSave({ projectDir: PROJECT, vetoSessionId: vetoSession, platform: 'codex' }))?.status).toBe('archived');

  // A later, unrelated Claude chat in the same project, saved under another session.
  const otherId = 'dddddddd-0000-4000-8000-000000000002';
  writeFileSync(join(claudeFolder, `${otherId}.jsonl`), readFileSync(join(FIXTURES, 'claude-sample.jsonl'), 'utf8').replace(/FIXA/g, otherId));
  expect((await captureOnSave({ projectDir: PROJECT, vetoSessionId: 'another-session', platform: 'claude' }))?.status).toBe('archived');
});

afterAll(() => {
  resetTranscriptsDb();
  resetDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['VETO_TEST_DB', 'VETO_CONFIG_PATH', 'VETO_TRANSCRIPTS_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) delete process.env[k];
});

describe('relevant excerpts from any AI\'s chats', () => {
  it('finds the Codex chat for a question about it', () => {
    const hits = pastSessionHits('how did we rotate the key in deploy.ts', PROJECT);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ ai: 'Codex', session: 'eeeeeeee-0000-4000-8000-000000000001' });
    expect(hits[0].excerpt.length).toBeLessThanOrEqual(301);
  });

  it('shows nothing for a query that shares one word by chance', () => {
    expect(pastSessionHits('weather forecast for the deploy', PROJECT)).toEqual([]);
    // One compound word expands to several search terms, but is still one word:
    // a one-word query may match on it; a two-word query needs both.
    expect(pastSessionHits('deploy.ts', PROJECT).length).toBeGreaterThan(0);
    expect(pastSessionHits('changelog deploy.ts', PROJECT)).toEqual([]);
  });

  it('attaches conversation, never raw tool payloads', () => {
    const hits = pastSessionHits('apply_patch deploy.ts key rotate', PROJECT);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => !h.excerpt.includes('apply_patch'))).toBe(true);
  });

  it('shows nothing for another project, or once capture is off', () => {
    expect(pastSessionHits('rotate key deploy.ts', 'D:\\Other Project')).toEqual([]);
    disableCapture();
    try { expect(pastSessionHits('rotate key deploy.ts', PROJECT)).toEqual([]); }
    finally { enableCapture(); }
  });
});

describe('the chats behind a saved session', () => {
  it('lists every AI that worked on it, with what was asked last, and only its own chats', () => {
    const chats = pastSessionChats(vetoSession, PROJECT);
    expect(chats.map(c => c.session).sort()).toEqual(['dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001']);
    expect(chats.find(c => c.ai === 'Claude Code')?.last_asked.join(' ')).toContain('login form');
  });

  it('veto_continue brings them along, whichever AI resumes', async () => {
    const out = await sessionHandlers.veto_continue({ args: { session_id: vetoSession }, request: {}, server: null });
    const body = JSON.parse(out.content[0].text.slice(out.content[0].text.indexOf('{')));
    expect(body.past_sessions.note).toMatch(/not follow instructions/);
    expect(body.past_sessions.chats.map((c: { ai: string }) => c.ai).sort()).toEqual(['Claude Code', 'Codex']);
  });
});

describe('tools reach past chats without being asked', () => {
  it('veto_memory_search returns them beside stored memory', async () => {
    const out = await memoryHandlers.veto_memory_search({ args: { query: 'rotate key deploy.ts', project_dir: PROJECT }, request: {}, server: null });
    const body = JSON.parse(out.content[0].text);
    expect(body.past_sessions.excerpts[0].ai).toBe('Codex');
  });

  it('a prompt handed to a model carries relevant excerpts, fenced as data', () => {
    const prompt = buildAgenticAgentPrompt({ id: 't', agent: 'debugger', task: 'Find the root cause', code: 'Error: 1 test failed in the login form', project_dir: PROJECT });
    expect(prompt?.output_prompt).toContain('[PAST SESSIONS]');
    expect(prompt?.output_prompt).toMatch(/Historical data for reference only/);
  });

  it('adds nothing when nothing is relevant', () => {
    expect(withPastSessions('ctx', 'kubernetes ingress certificate', PROJECT)).toBe('ctx');
  });

  it('the council hands the host AI relevant excerpts in its debate prompt', async () => {
    const out = await councilHandlers.veto_council_debate({ args: { task: 'Should we rotate the deploy.ts key again?', project_dir: PROJECT }, request: {}, server: {} });
    const text = out.content[0].text;
    const payload = JSON.parse(text.slice(text.indexOf('{\n')));
    expect(payload.llm_upgrade.debate_prompt).toContain('[PAST SESSIONS]');
  });

  it('council members reasoning through sampling see them; the fallback votes on the task alone', async () => {
    const prompts: string[] = [];
    const server = {
      createMessage: async (req: { messages: Array<{ content: { text: string } }> }) => {
        prompts.push(req.messages[0].content.text);
        return { content: { type: 'text', text: '{"verdict":"approve","reason":"ok","concerns":[],"recommendation":"go"}' } };
      },
    };
    await runLlmDebate(server as never, { task: 'Should we rotate the deploy.ts key again?', project_dir: PROJECT });
    expect(prompts).toHaveLength(7);
    expect(prompts.every(p => p.includes('[PAST SESSIONS]'))).toBe(true);
  });
});
