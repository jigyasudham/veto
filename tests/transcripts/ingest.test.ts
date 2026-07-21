import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-ingest-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession, ingestArchive, getEvents, PARSER_VERSION } = await import('../../src/transcripts/ingest.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

function transcript(sessionId: string): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-07-21T10:00:00.000Z', sessionId, message: { role: 'user', content: 'run the tests' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-21T10:00:03.000Z', sessionId, message: { role: 'assistant', content: [ { type: 'text', text: 'tests pass' } ] } }),
  ].join('\n') + '\n';
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('ingestArchive — derive events from L0', () => {
  it('indexes a captured session into ordered events and sets the watermark', async () => {
    const path = join(ROOT, 's1.jsonl');
    writeFileSync(path, transcript('S1'));
    recordSessionMapping({ sourceSessionId: 'S1', transcriptPath: path, projectDir: 'd:\\veto' });
    await captureSession({ sourceSessionId: 'S1' });

    const res = ingestSession('S1');
    expect(res.status).toBe('indexed');
    expect(res.events).toBe(2);

    const arch = getArchive('S1')!;
    const events = getEvents(arch.id);
    expect(events.map(e => e.kind)).toEqual(['user_message', 'assistant_message']);
    expect(arch.indexed_through_seq).toBe(2);
    expect(arch.parser_version).toBe(PARSER_VERSION);
  });

  it('is idempotent — re-ingesting an unchanged archive is a no-op', async () => {
    const res = ingestSession('S1');
    expect(res.status).toBe('already_indexed');
    const arch = getArchive('S1')!;
    expect(getEvents(arch.id).length).toBe(2); // not duplicated
  });

  it('re-derives when the transcript grows (Step 5 reset the watermark)', async () => {
    const path = join(ROOT, 's1.jsonl');
    appendFileSync(path, JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-07-21T10:01:00.000Z', sessionId: 'S1', message: { role: 'user', content: 'thanks' } }) + '\n');
    await captureSession({ sourceSessionId: 'S1' }); // content changed → watermark + parser_version reset

    const res = ingestSession('S1');
    expect(res.status).toBe('indexed');
    expect(res.events).toBe(3);
    const arch = getArchive('S1')!;
    expect(getEvents(arch.id).length).toBe(3); // rebuilt, not appended-with-dupes
  });

  it('skips a mismatched transcript (mapping pointed at the wrong file)', async () => {
    // Map W1 to a file whose lines belong to a DIFFERENT session id.
    const path = join(ROOT, 'wrong.jsonl');
    writeFileSync(path, transcript('SOMEONE_ELSE'));
    recordSessionMapping({ sourceSessionId: 'W1', transcriptPath: path });
    await captureSession({ sourceSessionId: 'W1' });

    const arch = getArchive('W1')!;
    const res = ingestArchive(arch.id);
    expect(res.status).toBe('session_mismatch');
    expect(getEvents(arch.id).length).toBe(0); // nothing indexed
  });

  it('returns not_found for an unknown archive id', () => {
    expect(ingestArchive('nope').status).toBe('not_found');
  });
});
