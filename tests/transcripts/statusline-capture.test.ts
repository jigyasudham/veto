import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolate BOTH the config (controls the opt-in gate) and the sidecar DB.
const TEST_CFG = join(tmpdir(), `veto-slcap-cfg-${Date.now()}-${process.pid}.json`);
const TEST_DB = join(tmpdir(), `veto-slcap-${Date.now()}-${process.pid}.db`);
process.env.VETO_CONFIG_PATH = TEST_CFG;
process.env.VETO_TRANSCRIPTS_DB = TEST_DB;

const { maybeRecordSessionMapping } = await import('../../src/cli/statusline.js');
const { enableCapture, disableCapture } = await import('../../src/transcripts/config.js');
const { getSessionMapping } = await import('../../src/transcripts/mapping.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const payload = (sessionId: string) => JSON.stringify({
  session_id: sessionId,
  transcript_path: `/home/me/.claude/projects/x/${sessionId}.jsonl`,
  cwd: 'D:\\Veto',
});

beforeEach(() => {
  disableCapture();
});

afterAll(() => {
  resetTranscriptsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  try { rmSync(TEST_CFG); } catch { /* ignore */ }
  delete process.env.VETO_CONFIG_PATH;
  delete process.env.VETO_TRANSCRIPTS_DB;
});

describe('maybeRecordSessionMapping — the hot-path opt-in gate', () => {
  it('does NOT record when capture is disabled (default)', async () => {
    const wrote = await maybeRecordSessionMapping(payload('off-1'));
    expect(wrote).toBe(false);
    expect(getSessionMapping('off-1')).toBeNull();
  });

  it('records when capture is enabled and the payload is complete', async () => {
    enableCapture();
    const wrote = await maybeRecordSessionMapping(payload('on-1'));
    expect(wrote).toBe(true);
    const row = getSessionMapping('on-1');
    expect(row).not.toBeNull();
    expect(row!.transcript_path).toContain('on-1.jsonl');
    expect(row!.project_dir).toBe('d:\\Veto'); // normalized
  });

  it('does NOT record when the payload lacks session_id/transcript_path', async () => {
    enableCapture();
    const wrote = await maybeRecordSessionMapping(JSON.stringify({ cwd: 'D:\\Veto' }));
    expect(wrote).toBe(false);
  });

  it('is safe on null / bad input (never throws)', async () => {
    enableCapture();
    expect(await maybeRecordSessionMapping(null)).toBe(false);
    expect(await maybeRecordSessionMapping('not json')).toBe(false);
    expect(await maybeRecordSessionMapping('')).toBe(false);
  });
});
