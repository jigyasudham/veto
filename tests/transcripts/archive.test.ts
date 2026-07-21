import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Root the whole feature (sidecar DB + archives dir) under one temp dir.
const ROOT = join(tmpdir(), `veto-archive-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive, MAX_SOURCE_BYTES } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const TRANSCRIPT = join(ROOT, 'sess-a.jsonl');

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('captureSession — L0 archive', () => {
  it('archives a mapped transcript and records the row', async () => {
    writeFileSync(TRANSCRIPT, '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi"}\n');
    recordSessionMapping({ sourceSessionId: 'sess-a', transcriptPath: TRANSCRIPT, projectDir: 'd:\\veto' });

    const r = await captureSession({ sourceSessionId: 'sess-a', vetoSessionId: 'veto-1' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('archived');
    expect(existsSync(r.archivePath!)).toBe(true);

    const row = getArchive('sess-a')!;
    expect(row).not.toBeNull();
    expect(row.content_sha256).toBe(r.contentSha256);
    expect(row.veto_session_id).toBe('veto-1');
    expect(row.source_format_hint).toBe('claude-jsonl');
    expect(row.source_bytes).toBeGreaterThan(0);
    expect(row.archive_bytes).toBeGreaterThan(0);
  });

  it('archive is byte-for-byte (Rule 0): gunzip equals the source file', async () => {
    const r = await captureSession({ sourceSessionId: 'sess-a' });
    const gz = readFileSync(r.archivePath ?? getArchive('sess-a')!.archive_path);
    expect(gunzipSync(gz).equals(readFileSync(TRANSCRIPT))).toBe(true);
  });

  it('is a no-op (unchanged) when the transcript has not changed', async () => {
    const before = getArchive('sess-a')!;
    const r = await captureSession({ sourceSessionId: 'sess-a' });
    expect(r.status).toBe('unchanged');
    const after = getArchive('sess-a')!;
    expect(after.id).toBe(before.id);          // same archive, not a duplicate
    expect(after.updated_at).toBe(before.updated_at); // untouched
  });

  it('re-archives in place when the transcript grows (latest wins, watermark reset)', async () => {
    const before = getArchive('sess-a')!;
    // Simulate a watermark advanced by a later indexing step.
    const { getTranscriptsDb } = await import('../../src/transcripts/store.js');
    getTranscriptsDb().prepare(`UPDATE archives SET indexed_through_seq=5 WHERE id=?`).run(before.id);

    appendFileSync(TRANSCRIPT, '{"type":"user","text":"more"}\n');
    const r = await captureSession({ sourceSessionId: 'sess-a' });
    expect(r.status).toBe('archived');

    const after = getArchive('sess-a')!;
    expect(after.id).toBe(before.id);                       // same row updated
    expect(after.content_sha256).not.toBe(before.content_sha256);
    expect(after.indexed_through_seq).toBe(0);              // reset → re-derive
    expect(gunzipSync(readFileSync(after.archive_path)).equals(readFileSync(TRANSCRIPT))).toBe(true);
  });

  it('tolerates a truncated final line (no trailing newline / partial JSON)', async () => {
    const path = join(ROOT, 'sess-trunc.jsonl');
    writeFileSync(path, '{"type":"user","text":"ok"}\n{"type":"assistant","tex'); // cut off mid-line
    recordSessionMapping({ sourceSessionId: 'sess-trunc', transcriptPath: path });
    const r = await captureSession({ sourceSessionId: 'sess-trunc' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('archived');
    expect(gunzipSync(readFileSync(r.archivePath!)).equals(readFileSync(path))).toBe(true);
  });

  it('resolves by project when no session id is given (newest active mapping)', async () => {
    const r = await captureSession({ projectDir: 'd:\\veto' });
    expect(r.ok).toBe(true);
    expect(r.sourceSessionId).toBe('sess-a'); // the mapping under d:\veto
  });
});

describe('captureSession — skip / safety cases (never throws)', () => {
  it('skips when there is no mapping', async () => {
    const r = await captureSession({ sourceSessionId: 'ghost' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no_mapping');
  });

  it('skips when the mapped transcript file is missing', async () => {
    recordSessionMapping({ sourceSessionId: 'sess-missing', transcriptPath: join(ROOT, 'does-not-exist.jsonl') });
    const r = await captureSession({ sourceSessionId: 'sess-missing' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('transcript_missing');
  });

  it('exposes a sane size cap', () => {
    expect(MAX_SOURCE_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });
});
