import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end proof that a Codex and a Gemini session go all the way through the
// pipeline Claude already used — discovery → capture → ingest → recall → expand —
// and that each is parsed by ITS OWN adapter, keyed off archives.source.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(tmpdir(), `veto-multi-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.GEMINI_DIR = join(ROOT, 'gemini');

const { enableCapture } = await import('../../src/transcripts/config.js');
const { captureOnSave, sourceForPlatform, captureSourceFor } = await import('../../src/transcripts/on-save.js');
const { recallQuery, recallExpand } = await import('../../src/transcripts/recall.js');
const { getArchive } = await import('../../src/transcripts/archive.js');
const { getEvents } = await import('../../src/transcripts/ingest.js');
const { parseTranscript, isTranscriptSource, formatHint } = await import('../../src/transcripts/adapters/index.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const CODEX_PROJECT = 'D:\\Multi Codex';
const GEMINI_PROJECT = 'd:\\multi gemini';
const CODEX_SESSION = 'eeeeeeee-1111-2222-3333-444444444444';
const GEMINI_SESSION = 'ffffffff-1111-2222-3333-444444444444';

// Lay both hosts' real on-disk layouts down, seeded from the pinned fixtures.
{
  const day = join(ROOT, 'codex', 'sessions', '2026', '05', '07');
  mkdirSync(day, { recursive: true });
  const codexFixture = readFileSync(join(__dirname, 'fixtures', 'codex-sample.jsonl'), 'utf8')
    .replace(/"id":"CODEXA"/, `"id":"${CODEX_SESSION}"`)
    .replace(/D:\\\\Job automation/g, CODEX_PROJECT.replace(/\\/g, '\\\\'));
  writeFileSync(join(day, `rollout-2026-05-07T22-03-04-${CODEX_SESSION}.jsonl`), codexFixture);

  const gdir = join(ROOT, 'gemini', 'tmp', 'multi-gemini');
  mkdirSync(join(gdir, 'chats'), { recursive: true });
  writeFileSync(join(gdir, '.project_root'), GEMINI_PROJECT);
  const geminiFixture = readFileSync(join(__dirname, 'fixtures', 'gemini-sample.jsonl'), 'utf8')
    .replace(/5dc752e2-f64c-4f68-929e-d0cca523724b/g, GEMINI_SESSION);
  writeFileSync(join(gdir, 'chats', 'session-2026-05-03T13-49-ffffffff.jsonl'), geminiFixture);
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['VETO_CONFIG_PATH', 'VETO_TRANSCRIPTS_DIR', 'CODEX_HOME', 'GEMINI_DIR']) delete process.env[k];
});

describe('adapter registry', () => {
  it('recognizes exactly the three supported sources', () => {
    expect(isTranscriptSource('claude')).toBe(true);
    expect(isTranscriptSource('codex')).toBe(true);
    expect(isTranscriptSource('gemini')).toBe(true);
    expect(isTranscriptSource('cursor')).toBe(false);
  });

  it('records a distinct format hint per source', () => {
    expect(formatHint('codex')).toBe('codex-rollout-jsonl');
    expect(formatHint('gemini')).toBe('gemini-chat-jsonl');
    expect(formatHint('claude')).toBe('claude-jsonl');
  });

  it('routes each buffer to the parser that owns its source', () => {
    const codex = readFileSync(join(__dirname, 'fixtures', 'codex-sample.jsonl'));
    // Parsed as codex, the agent_message line is assistant text...
    expect(parseTranscript('codex', codex).events.some(e => e.kind === 'assistant_message')).toBe(true);
    // ...but the Claude parser has no idea what a Codex envelope is.
    expect(parseTranscript('claude', codex).events.every(e => e.kind === 'unknown')).toBe(true);
  });

  it('maps a declared save platform onto a capture source', () => {
    expect(sourceForPlatform('codex')).toBe('codex');
    expect(sourceForPlatform('GEMINI')).toBe('gemini');
    expect(sourceForPlatform(undefined)).toBe('claude');
    expect(sourceForPlatform('something-else')).toBe('claude');
  });
});

describe('captureSourceFor — the MCP handshake outranks the self-report', () => {
  // The bug this closes: a model in Codex that leaves `platform` at its default
  // would send Veto looking for a CLAUDE transcript and silently archive nothing.
  it('trusts the detected host over a wrong declared platform', () => {
    expect(captureSourceFor('codex', 'claude')).toBe('codex');
    expect(captureSourceFor('gemini', undefined)).toBe('gemini');
    expect(captureSourceFor('claude', 'codex')).toBe('claude');
  });

  it('falls back to the declared platform when the host is unrecognized', () => {
    expect(captureSourceFor(null, 'codex')).toBe('codex');
    expect(captureSourceFor(null, 'GEMINI')).toBe('gemini');
  });

  // Skipping beats guessing: capturing the wrong CLI's transcript is worse than
  // capturing nothing, and an unknown host with no usable declaration is exactly
  // the case where a guess would be wrong.
  it('skips capture entirely when neither signal identifies a supported host', () => {
    expect(captureSourceFor(null, undefined)).toBeNull();
    expect(captureSourceFor(null, 'cursor')).toBeNull();
    expect(captureSourceFor(null, '')).toBeNull();
  });
});

describe('codex end-to-end — discovery replaces the statusline hook', () => {
  it('captures, indexes and recalls a Codex session with no mapping written by hand', async () => {
    enableCapture();
    // No recordSessionMapping() call anywhere: discovery has to find it.
    const out = await captureOnSave({ projectDir: CODEX_PROJECT, vetoSessionId: 'v-codex', platform: 'codex' });
    expect(out).not.toBeNull();
    expect(out!.status).toBe('archived');
    expect(out!.source).toBe('codex');
    expect(out!.events).toBeGreaterThan(0);

    const archive = getArchive(CODEX_SESSION, 'codex');
    expect(archive).not.toBeNull();
    expect(archive!.source_format_hint).toBe('codex-rollout-jsonl');

    // Parsed by the Codex adapter, not the Claude one.
    const events = getEvents(archive!.id);
    expect(events.some(e => e.source_type === 'response_item/function_call')).toBe(true);
    expect(events.some(e => e.kind === 'assistant_message')).toBe(true);
  });

  it('recalls exact detail from the Codex session and expands it back to L0', async () => {
    const res = recallQuery({ query: 'deploy.ts process.env.AWS_KEY', projectDir: CODEX_PROJECT });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
    const expanded = recallExpand({ eventId: res.hits[0].eventId });
    expect(expanded.ok).toBe(true);
    expect(expanded.text).toContain('deploy.ts');
    // The citation names the Codex session the line actually came from.
    expect(expanded.sourceSessionId).toBe(CODEX_SESSION);
  });

  it('redacts the pasted key from everything recall can return', () => {
    const archive = getArchive(CODEX_SESSION, 'codex')!;
    for (const e of getEvents(archive.id)) expect(e.text ?? '').not.toContain('AKIA1234567890ABCDEF');
    const res = recallQuery({ query: 'AKIA1234567890ABCDEF', projectDir: CODEX_PROJECT });
    expect(JSON.stringify(res.hits)).not.toContain('AKIA1234567890ABCDEF');
  });
});

describe('gemini end-to-end', () => {
  it('captures, indexes and recalls a Gemini session', async () => {
    const out = await captureOnSave({ projectDir: GEMINI_PROJECT, vetoSessionId: 'v-gemini', platform: 'gemini' });
    expect(out).not.toBeNull();
    expect(out!.status).toBe('archived');
    expect(out!.source).toBe('gemini');

    const archive = getArchive(GEMINI_SESSION, 'gemini');
    expect(archive).not.toBeNull();
    expect(archive!.source_format_hint).toBe('gemini-chat-jsonl');

    const res = recallQuery({ query: 'hard-coded key env var', projectDir: GEMINI_PROJECT });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
  });

  // The supersession rule has to survive the trip through the database, or a
  // Gemini session's index fills with half-streamed copies of its own messages.
  it('indexes only the final revision of a re-written message', () => {
    const archive = getArchive(GEMINI_SESSION, 'gemini')!;
    const assistant = getEvents(archive.id).filter(e => e.kind === 'assistant_message');
    expect(assistant.map(e => e.text)).toEqual([
      "I'll swap the hard-coded key for an env var.",
      'Done — deploy.ts now reads the key from the environment.',
    ]);
  });
});

describe('sources stay isolated from one another', () => {
  it('keeps each project scoped to its own source and archive', () => {
    expect(getArchive(CODEX_SESSION, 'gemini')).toBeNull();
    expect(getArchive(GEMINI_SESSION, 'codex')).toBeNull();
    // A Codex-only phrase must not surface in the Gemini project's recall.
    const cross = recallQuery({ query: 'apply_patch', projectDir: GEMINI_PROJECT });
    expect(cross.hits.every(h => h.sourceSessionId !== CODEX_SESSION)).toBe(true);
  });
});
