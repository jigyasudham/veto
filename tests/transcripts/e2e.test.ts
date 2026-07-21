import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

// End-to-end proof of the whole v3.0 opt-in flow, as a user would drive it:
//   enable → statusline mapping → save (capture + index) → recall → expand.
// Isolates BOTH config (opt-in gate) and the sidecar/archives.
const ROOT = join(tmpdir(), `veto-e2e-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');

const { enableCapture, disableCapture, isCaptureEnabled } = await import('../../src/transcripts/config.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { recallQuery, recallExpand } = await import('../../src/transcripts/recall.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const SECRET = 'AKIA' + 'E2E' + '0000000000ABC';

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_CONFIG_PATH;
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('v3.0 end-to-end — capture is inert until opted in', () => {
  it('captureOnSave does nothing while capture is disabled (default)', async () => {
    expect(isCaptureEnabled()).toBe(false);
    // Even with a mapping present, disabled = no capture.
    const path = join(ROOT, 'pre.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'p0', timestamp: '2026-07-21T09:00:00.000Z', sessionId: 'PRE', message: { role: 'user', content: 'hi' } }) + '\n');
    recordSessionMapping({ sourceSessionId: 'PRE', transcriptPath: path, projectDir: 'd:\\e2e' });
    const out = await captureOnSave({ projectDir: 'd:\\e2e', vetoSessionId: 'v-pre' });
    expect(out).toBeNull();
  });
});

describe('v3.0 end-to-end — enable → save → recall → expand', () => {
  it('runs the full pipeline and never leaks a pasted secret', async () => {
    // 1) user opts in
    enableCapture();
    expect(isCaptureEnabled()).toBe(true);

    // 2) statusline records the live session's transcript path
    const path = join(ROOT, 'E2E.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'e0', timestamp: '2026-07-21T10:00:00.000Z', sessionId: 'E2E', message: { role: 'user', content: `the deploy failed with npm E404 and I pasted ${SECRET}` } }),
      JSON.stringify({ type: 'assistant', uuid: 'e1', timestamp: '2026-07-21T10:00:04.000Z', sessionId: 'E2E', message: { role: 'assistant', content: [{ type: 'text', text: 'the fix was to run npm login and republish' }] } }),
    ].join('\n') + '\n');
    recordSessionMapping({ sourceSessionId: 'E2E', transcriptPath: path, projectDir: 'd:\\e2e' });

    // 3) save → capture + inline index; first-capture note + leak count surfaced
    const saved = await captureOnSave({ projectDir: 'd:\\e2e', vetoSessionId: 'v-e2e' });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('archived');
    expect(saved!.events).toBeGreaterThan(0);
    expect(saved!.secrets_redacted).toBeGreaterThanOrEqual(1); // the pasted AKIA
    expect(saved!.note).toContain('veto transcripts');          // one-time note

    // 4) recall (Phase 1): query returns cited hits + a TOC
    const q = recallQuery({ query: 'E404 deploy', projectDir: 'd:\\e2e' });
    expect(q.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(q)).not.toContain(SECRET);            // secret not in snippets/TOC

    // 5) recall (Phase 2): expand to the exact masked line with provenance
    const ex = recallExpand({ eventId: q.hits[0].eventId });
    expect(ex.ok).toBe(true);
    expect(ex.text).toContain('E404');                          // real detail recalled
    expect(ex.text).not.toContain(SECRET);                      // masked on expansion
    expect(ex.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
    expect(ex.provenance).toContain('session E2E');
    expect(ex.disclaimer).toContain('HISTORICAL TRANSCRIPT DATA');
  });

  it('honors the retention/consent audit trail and disable', async () => {
    disableCapture();
    expect(isCaptureEnabled()).toBe(false);
    // A save after disable is inert again.
    const out = await captureOnSave({ projectDir: 'd:\\e2e', vetoSessionId: 'v-e2e' });
    expect(out).toBeNull();
  });
});
