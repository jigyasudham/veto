import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';

// The six capture fixes of 2026-09-15, each a way a save used to archive the
// wrong thing or nothing at all, without saying so.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(tmpdir(), `veto-capture-fixes-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TEST_DB = join(ROOT, 'veto.db');
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');
process.env.CLAUDE_CONFIG_DIR = join(ROOT, 'claude');
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.GEMINI_DIR = join(ROOT, 'gemini');

const { enableCapture } = await import('../../src/transcripts/config.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping, latestMappingForProject } = await import('../../src/transcripts/mapping.js');
const { showArchive, purgeSession, listArchives } = await import('../../src/transcripts/manage.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const { recallQuery } = await import('../../src/transcripts/recall.js');
const { claudeProjectSlug } = await import('../../src/transcripts/claude-paths.js');
const { saveSession, updateSession, getDb, resetDb } = await import('../../src/memory/local.js');
const { continueSession } = await import('../../src/adapters/index.js');
const { sessionHandlers } = await import('../../src/server/handlers/session.js');
const { setActiveProjectDir } = await import('../../src/server/runtime.js');
const { resetHostClient } = await import('../../src/host.js');

const win32 = process.platform === 'win32';
const FIXTURES = join(__dirname, 'fixtures');
enableCapture();

afterEach(() => { resetHostClient(); setActiveProjectDir(null); });
afterAll(() => {
  resetTranscriptsDb();
  resetDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['VETO_TEST_DB', 'VETO_CONFIG_PATH', 'VETO_TRANSCRIPTS_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) delete process.env[k];
});

/** A Claude session file where Claude Code puts it, with the fixture's session id rewritten. */
function claudeChat(projectDir: string, sessionId: string, folderName = claudeProjectSlug(projectDir)): string {
  const folder = join(ROOT, 'claude', 'projects', folderName);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${sessionId}.jsonl`);
  writeFileSync(path, readFileSync(join(FIXTURES, 'claude-sample.jsonl'), 'utf8').replace(/FIXA/g, sessionId));
  return path;
}

describe('Claude chats are found without the statusline', () => {
  it('archives the newest session file in the project\'s Claude folder', async () => {
    const project = 'D:\\Fix Claude';
    const older = claudeChat(project, 'aaaaaaaa-0000-4000-8000-000000000001');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(older, past, past);
    claudeChat(project, 'aaaaaaaa-0000-4000-8000-000000000002');
    // Neither a side chain nor a stray file counts as a session, however new.
    const folder = join(ROOT, 'claude', 'projects', claudeProjectSlug(project));
    mkdirSync(join(folder, 'aaaaaaaa-0000-4000-8000-000000000002', 'subagents'), { recursive: true });
    writeFileSync(join(folder, 'aaaaaaaa-0000-4000-8000-000000000002', 'subagents', 'agent-x.jsonl'), '{}\n');
    writeFileSync(join(folder, 'notes.jsonl'), '{}\n');

    const out = await captureOnSave({ projectDir: project, vetoSessionId: 'v-claude', platform: 'claude' });

    expect(out).toMatchObject({ status: 'archived', source: 'claude' });
    expect(getArchive('aaaaaaaa-0000-4000-8000-000000000002', 'claude')).not.toBeNull();
  });

  it.runIf(win32)('matches the folder whatever case the drive letter had', async () => {
    claudeChat('D:\\Case Claude', 'aaaaaaaa-0000-4000-8000-000000000003');
    const out = await captureOnSave({ projectDir: 'd:\\case claude', vetoSessionId: 'v-case', platform: 'claude' });
    expect(out?.status).toBe('archived');
  });
});

describe('one folder, however a host spells it', () => {
  it('ignores trailing separators', () => {
    recordSessionMapping({ source: 'gemini', sourceSessionId: 'trail', transcriptPath: join(ROOT, 'x.jsonl'), projectDir: 'd:\\trail\\' });
    expect(latestMappingForProject('d:\\trail', 'gemini')?.source_session_id).toBe('trail');
  });

  it.runIf(win32)("finds Gemini's lowercase record for a save's mixed-case folder", async () => {
    const gdir = join(ROOT, 'gemini', 'tmp', 'fix-gemini');
    mkdirSync(join(gdir, 'chats'), { recursive: true });
    writeFileSync(join(gdir, '.project_root'), 'd:\\fix gemini');
    const session = 'bbbbbbbb-1111-2222-3333-444444444444';
    writeFileSync(join(gdir, 'chats', 'session-2026-09-15T10-00-bbbbbbbb.jsonl'),
      readFileSync(join(FIXTURES, 'gemini-sample.jsonl'), 'utf8').replace(/5dc752e2-f64c-4f68-929e-d0cca523724b/g, session));

    const out = await captureOnSave({ projectDir: 'D:\\Fix Gemini', vetoSessionId: 'v-gemini', platform: 'gemini' });

    expect(out).toMatchObject({ status: 'archived', source: 'gemini' });
    expect(listArchives({ projectDir: 'D:/Fix Gemini/' }).map(a => a.sourceSessionId)).toEqual([session]);
    // Recall, scoped by the save's spelling, takes the Gemini chat into scope
    // (and would index it if it were not already) and searches it.
    const recalled = recallQuery({ query: 'rotate deploy.ts key', projectDir: 'D:\\Fix Gemini' });
    expect(recalled.scope.archivesIndexed).toBe(1);
    expect(recalled.hits.length).toBeGreaterThan(0);
  });
});

describe('show and purge find any CLI\'s session', () => {
  it('shows and purges a Codex session by its bare id', async () => {
    const session = 'cccccccc-1111-2222-3333-444444444444';
    const project = 'D:\\Fix Codex';
    const day = join(ROOT, 'codex', 'sessions', '2026', '09', '15');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-15T10-00-00-${session}.jsonl`), readFileSync(join(FIXTURES, 'codex-sample.jsonl'), 'utf8')
      .replace(/"id":"CODEXA"/, `"id":"${session}"`)
      .replace(/D:\\\\Job automation/g, project.replace(/\\/g, '\\\\')));
    expect((await captureOnSave({ projectDir: project, vetoSessionId: 'v-codex', platform: 'codex' }))?.status).toBe('archived');

    expect(showArchive(session)?.summary.source).toBe('codex');
    expect(showArchive(session, 'claude')).toBeNull();
    const purged = purgeSession(session);
    expect(purged.archives).toBe(1);
    expect(getArchive(session, 'codex')).toBeNull();
  });
});

describe('a skipped capture says why', () => {
  it.each([
    ['no project folder', { projectDir: null, platform: 'claude' }, /no project folder is known/],
    ['an unsupported client', { projectDir: 'D:\\Anything', platform: null }, /not one Veto can capture from/],
    ['no chat for the folder', { projectDir: 'D:\\Nowhere', platform: 'gemini' }, /no Gemini chat was found for D:\\Nowhere/],
  ] as const)('%s', async (_label, opts, reason) => {
    const out = await captureOnSave({ ...opts, vetoSessionId: 'v-skip' });
    expect(out?.status).toBe('skipped');
    expect(out?.reason).toMatch(reason);
  });
});

describe('the session records the AI that actually saved it', () => {
  it('an in-place save updates who saved it, and continue says so', () => {
    const { session_id } = saveSession({ summary: 'begun in claude', platform: 'claude' });
    updateSession(session_id, { summary: 'continued in codex', platform: 'codex' });
    expect(continueSession(session_id).message).toContain('restored from codex');
    updateSession(session_id, { summary: 'no platform given' });
    expect((getDb().prepare('SELECT platform FROM sessions WHERE id = ?').get(session_id) as { platform: string }).platform).toBe('codex');
  });

  it('the connected host wins over the declared platform, and the save says so', async () => {
    const server = { getClientVersion: () => ({ name: 'codex-cli', version: '0.154.0' }) };
    const out = await sessionHandlers.veto_session_save({ args: { summary: 's', context: 'c', platform: 'claude', project_dir: 'D:\\Host Test' }, request: {}, server });
    const res = JSON.parse(out.content[0].text);
    expect(res.platform_note).toMatch(/"claude" was declared, but this save came through codex/);
    expect((getDb().prepare('SELECT platform FROM sessions WHERE id = ?').get(res.session_id) as { platform: string }).platform).toBe('codex');
  });

  it('a save without project_dir uses the project this server already knows', async () => {
    setActiveProjectDir('d:\\active project');
    const out = await sessionHandlers.veto_session_save({ args: { summary: 's', context: 'c' }, request: {}, server: null });
    const res = JSON.parse(out.content[0].text);
    expect((getDb().prepare('SELECT project_dir FROM sessions WHERE id = ?').get(res.session_id) as { project_dir: string }).project_dir).toBe('d:\\active project');
    expect(res.transcript?.reason).toMatch(/not one Veto can capture from|no Claude Code chat was found for d:\\active project/);
  });
});
