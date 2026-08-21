import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';

const STAMP = `${Date.now()}-${process.pid}`;
const TEST_DB = join(tmpdir(), `veto-discover-${STAMP}.db`);
const CODEX_HOME = join(tmpdir(), `veto-codex-${STAMP}`);
const GEMINI_DIR = join(tmpdir(), `veto-gemini-${STAMP}`);

process.env.VETO_TRANSCRIPTS_DB = TEST_DB;
process.env.CODEX_HOME = CODEX_HOME;
process.env.GEMINI_DIR = GEMINI_DIR;

const {
  discoverCodexSessions, discoverGeminiSessions, discoverSessions, hasSessionForProject,
} = await import('../../src/transcripts/discover.js');
const { latestMappingForProject, getSessionMapping } = await import('../../src/transcripts/mapping.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

/** Give a file a definite mtime so newest-first ordering is deterministic. */
function writeAt(path: string, content: string, secondsAgo: number): void {
  writeFileSync(path, content);
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
}

const codexMeta = (id: string, cwd: string) =>
  JSON.stringify({ timestamp: '2026-05-07T16:35:06.211Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.130.0' } }) + '\n'
  + JSON.stringify({ timestamp: '2026-05-07T16:35:06.240Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }) + '\n';

const geminiHeader = (sessionId: string) =>
  JSON.stringify({ sessionId, projectHash: 'h', startTime: '2026-05-03T13:49:56.085Z', lastUpdated: '2026-05-03T13:49:56.085Z', kind: 'main' }) + '\n';

// Built at module scope, not in beforeAll: a describe body runs during
// collection, which is BEFORE any hook fires, and these suites discover there.
{
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  const day = join(CODEX_HOME, 'sessions', '2026', '05', '07');
  mkdirSync(day, { recursive: true });
  writeAt(join(day, 'rollout-2026-05-07T22-03-04-aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
    codexMeta('aaaaaaaa-1111-2222-3333-444444444444', 'D:\\Proj One'), 300);
  writeAt(join(day, 'rollout-2026-05-07T23-03-04-bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
    codexMeta('bbbbbbbb-1111-2222-3333-444444444444', 'D:\\Proj One'), 60);   // newer, same project
  writeAt(join(day, 'rollout-2026-05-07T21-03-04-cccccccc-1111-2222-3333-444444444444.jsonl'),
    codexMeta('cccccccc-1111-2222-3333-444444444444', 'D:\\Other'), 600);
  writeAt(join(day, 'not-a-rollout.jsonl'), '{}\n', 10);

  // Gemini: ~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl + .project_root
  const mk = (slug: string, projectRoot: string | null) => {
    const dir = join(GEMINI_DIR, 'tmp', slug);
    mkdirSync(join(dir, 'chats'), { recursive: true });
    if (projectRoot) writeFileSync(join(dir, '.project_root'), projectRoot);
    return join(dir, 'chats');
  };
  const realChats = mk('proj-one', 'd:\\proj one');
  writeAt(join(realChats, 'session-2026-05-03T13-49-dddddddd.jsonl'),
    geminiHeader('dddddddd-1111-2222-3333-444444444444'), 300);
  // Antigravity stubs: newest on disk, all sharing the literal id "a2a-server",
  // spread across projects. They must never win the newest-first budget.
  for (const [slug, root] of [['stub-a', 'd:\\stub a'], ['stub-b', 'd:\\stub b'], ['stub-c', 'd:\\stub c']] as const) {
    const chats = mk(slug, root);
    writeAt(join(chats, 'session-2026-06-10T14-49-a2a-serv.jsonl'), geminiHeader('a2a-server'), 5);
  }
}

afterAll(() => {
  resetTranscriptsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  for (const d of [CODEX_HOME, GEMINI_DIR]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete process.env.VETO_TRANSCRIPTS_DB;
  delete process.env.CODEX_HOME;
  delete process.env.GEMINI_DIR;
});

describe('discoverCodexSessions', () => {
  const found = discoverCodexSessions();

  it('finds rollouts and reads the project out of session_meta', () => {
    expect(found.length).toBe(3);
    const one = found.find(s => s.sourceSessionId.startsWith('aaaaaaaa'))!;
    expect(one.projectDir).toBe('D:\\Proj One');
    expect(one.source).toBe('codex');
  });

  it('ignores files that are not rollouts', () => {
    expect(found.every(s => s.transcriptPath.includes('rollout-'))).toBe(true);
  });

  it('returns newest first, so the active session wins a project tie', () => {
    expect(found[0].sourceSessionId.startsWith('bbbbbbbb')).toBe(true);
  });
});

describe('discoverGeminiSessions', () => {
  const found = discoverGeminiSessions();

  it('resolves the real project path from .project_root', () => {
    expect(found.length).toBe(1);
    expect(found[0].projectDir).toBe('d:\\proj one');
    expect(found[0].sourceSessionId).toBe('dddddddd-1111-2222-3333-444444444444');
  });

  // Guards the exact bug this filter exists for: the stubs are the newest files,
  // so without filtering they would fill the cap AND collide on one session id.
  it('skips the a2a-server stubs even though they are the newest files', () => {
    expect(found.some(s => s.sourceSessionId === 'a2a-server')).toBe(false);
  });

  it('still honours the newest-first cap', () => {
    expect(discoverGeminiSessions(0)).toEqual([]);
  });
});

describe('discoverSessions', () => {
  it('records mappings that capture can then resolve by project', () => {
    const r = discoverSessions('codex');
    expect(r.recorded).toBe(3);
    const m = latestMappingForProject('D:\\Proj One', 'codex');
    expect(m).not.toBeNull();
    // Newest mapping for the project wins (the S5 concurrency rule) — which
    // only holds because discovery stamps last_seen_at from the file's mtime.
    expect(m!.source_session_id.startsWith('bbbbbbbb')).toBe(true);
    expect(m!.last_seen_at < new Date().toISOString()).toBe(true);
    expect(getSessionMapping('cccccccc-1111-2222-3333-444444444444', 'codex')).not.toBeNull();
  });

  it('records gemini mappings under the gemini source', () => {
    const r = discoverSessions('gemini');
    expect(r.recorded).toBe(1);
    expect(latestMappingForProject('d:\\proj one', 'gemini')).not.toBeNull();
    // Sources are separate namespaces — a gemini id is not a codex mapping.
    expect(getSessionMapping('dddddddd-1111-2222-3333-444444444444', 'codex')).toBeNull();
  });

  it('never throws when a source directory does not exist', () => {
    process.env.CODEX_HOME = join(tmpdir(), `veto-missing-${STAMP}`);
    expect(() => discoverSessions('codex')).not.toThrow();
    expect(discoverSessions('codex').sessions).toEqual([]);
    process.env.CODEX_HOME = CODEX_HOME;
  });
});

describe('hasSessionForProject', () => {
  // project_dir is normalized on the drive letter only (memory/local.ts), which
  // is the convention the whole DB follows — not a full case-fold.
  it('matches across drive-letter casing', () => {
    const sessions = discoverCodexSessions();
    expect(hasSessionForProject(sessions, 'd:\\Proj One')).toBe(true);
    expect(hasSessionForProject(sessions, 'D:\\Proj One')).toBe(true);
    expect(hasSessionForProject(sessions, 'D:\\Nowhere')).toBe(false);
  });
});
