import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-expand-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession, getArchive } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession, getEvents } = await import('../../src/transcripts/ingest.js');
const { expandBytes, expandEvent, expandRange, _resetExpandCache } = await import('../../src/transcripts/expand.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

// A transcript whose RAW L0 content contains a live secret (Rule 0 keeps it raw).
const SECRET = 'AKIA1234567890ABCDEF';
const TRANSCRIPT = join(ROOT, 'sx.jsonl');

async function setup() {
  writeFileSync(TRANSCRIPT, [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-21T10:00:00.000Z', sessionId: 'SX', message: { role: 'user', content: `here is the key ${SECRET} do not lose it` } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-21T10:00:02.000Z', sessionId: 'SX', message: { role: 'assistant', content: [{ type: 'text', text: 'rotating it now' }] } }),
  ].join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: 'SX', transcriptPath: TRANSCRIPT, projectDir: 'd:\\veto' });
  await captureSession({ sourceSessionId: 'SX' });
  ingestSession('SX');
  _resetExpandCache();
  return getArchive('SX')!;
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('mask-on-expansion — a raw L0 secret NEVER leaves unmasked', () => {
  it('masks a secret when expanding the exact event that contains it', async () => {
    const arch = await setup();
    const events = getEvents(arch.id);
    const userEvent = events.find(e => e.kind === 'user_message')!;

    const r = expandEvent(userEvent.id);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('here is the key');           // context preserved
    expect(r.text).not.toContain(SECRET);                  // secret masked on the way out
    expect(r.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
    expect(r.secretsRedacted).toBeGreaterThanOrEqual(1);
    expect(r.provenance).toContain('session SX');
  });

  it('masks across a whole-range expansion too', async () => {
    const arch = await setup();
    const r = expandRange(arch.id, 0, 99);
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toContain('rotating it now');
    expect(r.provenance).toContain('turns 0-99');
  });
});

describe('raw_ptr bounds validation (S6) — never read outside the archive', () => {
  it('rejects offsets past the archive length', async () => {
    const arch = await setup();
    expect(expandBytes(arch, 999_999_999, 10).ok).toBe(false);
    expect(expandBytes(arch, 999_999_999, 10).reason).toBe('out_of_bounds');
  });

  it('rejects negative / non-integer offsets and lengths', async () => {
    const arch = await setup();
    expect(expandBytes(arch, -1, 5).ok).toBe(false);
    expect(expandBytes(arch, 0, -5).ok).toBe(false);
    expect(expandBytes(arch, 1.5, 5).ok).toBe(false);
    expect(expandBytes(arch, 0, 1.5).ok).toBe(false);
  });

  it('accepts an in-bounds range and returns masked text', async () => {
    const arch = await setup();
    const r = expandBytes(arch, 0, 20);
    expect(r.ok).toBe(true);
    expect(typeof r.text).toBe('string');
  });
});

describe('expand error cases', () => {
  it('reports event_not_found / no_events cleanly', async () => {
    const arch = await setup();
    expect(expandEvent('nope').ok).toBe(false);
    expect(expandRange(arch.id, 10_000, 10_001).reason).toBe('no_events');
    expect(expandRange('nope', 0, 1).reason).toBe('archive_not_found');
  });
});
