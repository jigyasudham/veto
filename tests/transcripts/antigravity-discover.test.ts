import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';

// Vite cannot resolve node:sqlite statically; Veto loads it the same way.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// Antigravity CLI keeps each conversation in brain/<id>/, and names its
// workspace only in its own index, conversation_summaries.db. These tests lay
// that layout down and take a conversation from discovery through capture to
// recall, as Codex and Gemini are in multi-source.test.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(tmpdir(), `veto-agy-${Date.now()}-${process.pid}`);
const AGY = join(ROOT, 'gemini', 'antigravity-cli');
mkdirSync(AGY, { recursive: true });
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');
process.env.GEMINI_DIR = join(ROOT, 'gemini');

const { discoverAntigravitySessions, workspaceUriToPath } = await import('../../src/transcripts/discover.js');
const { enableCapture } = await import('../../src/transcripts/config.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { recallQuery, recallExpand } = await import('../../src/transcripts/recall.js');
const { getArchive } = await import('../../src/transcripts/archive.js');
const { getEvents } = await import('../../src/transcripts/ingest.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const PROJECT = 'D:\\Agy Proj';
const id = (c: string) => `${c.repeat(8)}-1111-2222-3333-444444444444`;
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'antigravity-sample.jsonl'), 'utf8');

function conversation(convId: string, secondsAgo: number, file = 'transcript_full.jsonl', body = FIXTURE): void {
  const logs = join(AGY, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  const path = join(logs, file);
  writeFileSync(path, body);
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
}

type Row = { id: string; uris: string; app?: string; parent?: string };
function writeIndex(rows: Row[]): void {
  const db = new DatabaseSync(join(AGY, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "",
    workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    app_data_dir text NOT NULL DEFAULT "", PRIMARY KEY (conversation_id))`);
  const insert = db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, app_data_dir, parent_conversation_id) VALUES (?, ?, ?, ?)');
  for (const r of rows) insert.run(r.id, r.uris, r.app ?? 'antigravity-cli', r.parent ?? '');
  db.close();
}

// A: this project, older. B: this project, newest — the one capture should take.
// C: started by B (nested). D: the Antigravity IDE's. E: empty transcript.
// F: another project, only the short transcript.jsonl.
conversation(id('a'), 600);
conversation(id('b'), 60);
conversation(id('c'), 5);
conversation(id('d'), 5);
conversation(id('e'), 5, 'transcript_full.jsonl', '');
conversation(id('f'), 300, 'transcript.jsonl');
writeIndex([
  { id: id('a'), uris: '["file:///D:/Agy%20Proj"]' },
  { id: id('b'), uris: '["file:///d%3A/Agy%20Proj"]' },
  { id: id('c'), uris: '["file:///D:/Agy%20Proj"]', parent: id('b') },
  { id: id('d'), uris: '["file:///D:/Agy%20Proj"]', app: 'antigravity' },
  { id: id('e'), uris: '["file:///D:/Agy%20Proj"]' },
  { id: id('f'), uris: '["file:///D:/Elsewhere"]' },
]);

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['VETO_CONFIG_PATH', 'VETO_TRANSCRIPTS_DIR', 'GEMINI_DIR']) delete process.env[k];
});

describe('workspaceUriToPath', () => {
  it('decodes Windows workspace URIs the same way on every OS', () => {
    expect(workspaceUriToPath('file:///D:/Veto')).toBe('D:\\Veto');
    expect(workspaceUriToPath('file:///d%3A/Job%20automation')).toBe('d:\\Job automation');
  });

  it('keeps POSIX paths and rejects what is not a file URI', () => {
    expect(workspaceUriToPath('file:///home/me/proj')).toBe('/home/me/proj');
    expect(workspaceUriToPath('https://example.com')).toBeNull();
  });
});

describe('discoverAntigravitySessions', () => {
  it('lists this app\'s own top-level conversations with a transcript, newest first', () => {
    const found = discoverAntigravitySessions();
    expect(found.map(s => s.sourceSessionId)).toEqual([id('b'), id('f'), id('a')]);
    expect(found.every(s => s.source === 'antigravity')).toBe(true);
  });

  it('takes the workspace from Antigravity\'s index, not from history', () => {
    const found = discoverAntigravitySessions();
    expect(found.find(s => s.sourceSessionId === id('b'))!.projectDir).toBe('d:\\Agy Proj');
    expect(found.find(s => s.sourceSessionId === id('f'))!.projectDir).toBe('D:\\Elsewhere');
  });

  it('prefers the full transcript and falls back to the short one', () => {
    const found = discoverAntigravitySessions();
    expect(found.find(s => s.sourceSessionId === id('b'))!.transcriptPath).toMatch(/transcript_full\.jsonl$/);
    expect(found.find(s => s.sourceSessionId === id('f'))!.transcriptPath).toMatch(/[\\/]transcript\.jsonl$/);
  });

  it('falls back to history.jsonl for the workspace when the index cannot be read', () => {
    const db = join(AGY, 'conversation_summaries.db');
    renameSync(db, db + '.away');
    try {
      writeFileSync(join(AGY, 'history.jsonl'),
        JSON.stringify({ display: 'hi', workspace: 'D:\\From History', conversationId: id('a') }) + '\n{broken\n');
      const found = discoverAntigravitySessions();
      expect(found.find(s => s.sourceSessionId === id('a'))!.projectDir).toBe('D:\\From History');
      // Without the index nothing says which conversations were nested or the IDE's,
      // so they are listed — but with no workspace they can never be bound to a project.
      expect(found.find(s => s.sourceSessionId === id('b'))!.projectDir).toBeNull();
    } finally {
      renameSync(db + '.away', db);
    }
  });
});

describe('antigravity end-to-end', () => {
  it('captures the project\'s newest conversation, indexes it and recalls from it', async () => {
    enableCapture();
    const out = await captureOnSave({ projectDir: PROJECT, vetoSessionId: 'v-agy', platform: 'antigravity' });
    expect(out).toMatchObject({ status: 'archived', source: 'antigravity' });
    expect(out!.events).toBeGreaterThan(0);

    const archive = getArchive(id('b'), 'antigravity');
    expect(archive).not.toBeNull();
    expect(archive!.source_format_hint).toBe('antigravity-transcript-jsonl');

    const res = recallQuery({ query: 'deploy key environment', projectDir: PROJECT });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
    const expanded = recallExpand({ eventId: res.hits[0].eventId });
    expect(expanded.ok).toBe(true);
    expect(expanded.sourceSessionId).toBe(id('b'));
  });

  it('keeps the pasted key out of everything recall returns', () => {
    const archive = getArchive(id('b'), 'antigravity')!;
    const events = getEvents(archive.id);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.text ?? '').not.toContain('AKIA' + '1234567890ABCDEF');
    const res = recallQuery({ query: 'AKIA' + '1234567890ABCDEF', projectDir: PROJECT });
    expect(JSON.stringify(res.hits)).not.toContain('AKIA' + '1234567890ABCDEF');
  });
});
