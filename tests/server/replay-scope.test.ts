import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'veto-replay-scope-'));
process.env.VETO_TRANSCRIPTS_DIR = root;
const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession, getEvents } = await import('../../src/transcripts/ingest.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const { sessionHandlers } = await import('../../src/server/handlers/session.js');
const { setActiveProjectDir } = await import('../../src/server/runtime.js');
const { recallQuery } = await import('../../src/transcripts/recall.js');

const own = join(root, 'own');
const foreign = join(root, 'foreign');
const secret = 'ghp_' + 'z'.repeat(36);
const ids: Record<string, { event_id: string; archive_id: string }> = {};

beforeAll(async () => {
  for (const [session, project] of [['OWN', own], ['FOREIGN', foreign], ['CWD', process.cwd()]]) {
    const path = join(root, `${session}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: session, sessionId: session,
      message: { role: 'user', content: `${session} replayboundary ${secret}` } }) + '\n');
    recordSessionMapping({ sourceSessionId: session, transcriptPath: path, projectDir: project });
    await captureSession({ sourceSessionId: session });
    ingestSession(session);
    const archive = getArchive(session)!;
    ids[session] = { archive_id: archive.id, event_id: getEvents(archive.id)[0].id };
  }
});
afterEach(() => setActiveProjectDir(null));
afterAll(() => {
  resetTranscriptsDb();
  delete process.env.VETO_TRANSCRIPTS_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function replay(args: Record<string, unknown>) {
  const response = await sessionHandlers.veto_session_replay({ args } as any) as any;
  return { response, body: JSON.parse(response.content[0].text) };
}

describe('MCP replay project boundary', () => {
  const selectors = [
    (s: string) => ({ event_id: ids[s].event_id }),
    (s: string) => ({ archive_id: ids[s].archive_id, from_seq: 0, to_seq: 1 }),
    (s: string) => ({ archive_id: ids[s].archive_id, segment_index: 0 }),
    (s: string) => ({ source_session_id: s, from_seq: 0 }),
    (s: string) => ({ source_session_id: s, segment_index: 0 }),
  ];
  for (const [index, selector] of selectors.entries()) {
    for (const raw of [false, true]) {
      it(`checks selector ${index} before returning text (raw=${raw})`, async () => {
        setActiveProjectDir(own);
        const allowed = await replay({ expand: { ...selector('OWN'), raw } });
        expect(allowed.body.ok).toBe(true);
        expect(allowed.body.text).toContain('OWN replayboundary');
        expect(allowed.body.text).not.toContain(secret);
        const denied = await replay({ expand: { ...selector('FOREIGN'), raw } });
        const missing = await replay({ expand: { event_id: 'missing', raw } });
        expect(denied.response.isError).toBe(true);
        expect(denied.body).toEqual(missing.body);
        expect(denied.body.reason).toBe('not_found');
        expect(denied.body.text).toBeUndefined();
      });
    }
  }

  it('uses an explicit project ahead of active project, with trailing separator normalization', async () => {
    setActiveProjectDir(own);
    const r = await replay({ project_dir: foreign + '/', expand: { event_id: ids.FOREIGN.event_id } });
    expect(r.body.ok).toBe(true);
  });

  it('falls back to cwd before a session has set the active project', async () => {
    expect((await replay({ expand: { event_id: ids.CWD.event_id } })).body.ok).toBe(true);
    expect((await replay({ expand: { event_id: ids.FOREIGN.event_id } })).body.ok).toBe(false);
    const q = await replay({ query: 'replayboundary' });
    expect(q.body.hits.length).toBeGreaterThan(0);
    expect(q.body.hits.every((h: any) => h.sourceSessionId === 'CWD')).toBe(true);
  });

  it('an event id cannot borrow the project of a different archive id', async () => {
    const r = await replay({ project_dir: own, expand: { event_id: ids.FOREIGN.event_id, archive_id: ids.OWN.archive_id } });
    expect(r.body.reason).toBe('not_found');
  });

  it('an expansion naming no target still says what it needs', async () => {
    setActiveProjectDir(own);
    const r = await replay({ expand: {} });
    expect(r.body.ok).toBe(false);
    expect(r.body.reason).toMatch(/need eventId, archiveId, or sourceSessionId/);
  });

  it('a blank project cannot widen search to all projects', async () => {
    setActiveProjectDir(own);
    const r = await replay({ project_dir: '   ', query: 'replayboundary' });
    expect(r.body.hits.length).toBeGreaterThan(0);
    expect(r.body.hits.every((h: any) => h.sourceSessionId === 'OWN')).toBe(true);
    expect((await replay({ project_dir: '   ', expand: { event_id: ids.FOREIGN.event_id } })).body.ok).toBe(false);
  });

  it('does not index or attach a foreign session TOC when search names both scopes', () => {
    const r = recallQuery({ query: 'replayboundary', projectDir: own, sourceSessionId: 'FOREIGN' });
    expect(r.scope.archivesIndexed).toBe(0);
    expect(r.hits).toEqual([]);
    expect(r.toc).toBeUndefined();
    expect(r.facts).toBeUndefined();
  });
});
