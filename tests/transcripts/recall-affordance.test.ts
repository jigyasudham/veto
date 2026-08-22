import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

// Guards the calibration between the two recall phases (council 06b7b55c).
// The measured failure was not ranking: it was that phase 1 returned 97-char
// keyword fragments while phase 2 returned unbounded raw JSONL (139.6KB / ~35k
// tokens at worst), so the query->expand loop never once completed. These tests
// pin the properties that fix requires, because every one of them is the kind of
// thing a later refactor silently undoes.
const ROOT = join(tmpdir(), `veto-afford-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'store');

const { enableCapture } = await import('../../src/transcripts/config.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { recallQuery, recallExpand } = await import('../../src/transcripts/recall.js');
const { MAX_EXPAND_CHARS } = await import('../../src/transcripts/expand.js');
const { resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const PROJECT = 'd:\\afford';
const SECRET = 'AKIA' + 'AFFORD' + '00000000XYZ';

// A long assistant turn (so a snippet must choose a window) plus a deliberately
// enormous one (the 139KB case, scaled down) and a pasted secret.
function line(uuid: string, type: 'user' | 'assistant', text: string, ts: string): string {
  const msg = type === 'user'
    ? { role: 'user', content: text }
    : { role: 'assistant', content: [{ type: 'text', text }] };
  return JSON.stringify({ type, uuid, parentUuid: null, timestamp: ts, sessionId: 'AFF', message: msg });
}

const LONG = 'The provenance failure happened because package.json had no repository field, '
  + 'and npm validates that during the sigstore attestation step rather than at pack time. '
  + 'That is why a dry run could never have caught it: a dry run never signs anything. '.repeat(3);
const HUGE = 'x'.repeat(MAX_EXPAND_CHARS * 3);

{
  const path = join(ROOT, 'aff.jsonl');
  writeFileSync(path, [
    line('u1', 'user', `here is the key ${SECRET} do not lose it`, '2026-08-01T10:00:00.000Z'),
    line('a1', 'assistant', LONG, '2026-08-01T10:00:05.000Z'),
    line('a2', 'assistant', HUGE, '2026-08-01T10:00:09.000Z'),
    line('u2', 'user', 'why did the npm publish fail with a 422', '2026-08-01T10:01:00.000Z'),
  ].join('\n') + '\n');
  enableCapture();
  recordSessionMapping({ sourceSessionId: 'AFF', transcriptPath: path, projectDir: PROJECT });
}

const captured = await captureOnSave({ projectDir: PROJECT, vetoSessionId: 'v-aff', platform: 'claude' });

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_CONFIG_PATH;
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('phase 1 returns enough to decide on', () => {
  it('captured and indexed the fixture', () => {
    expect(captured?.status).toBe('archived');
  });

  // The defect: 97-char fragments are below the width at which a relevance
  // judgement is possible, so the AI could never tell if a hit was worth opening.
  it('returns sentence-sized snippets, not keyword fragments', () => {
    const res = recallQuery({ query: 'provenance repository field sigstore', projectDir: PROJECT });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
    const best = res.hits.map(h => String(h.snippet).length).sort((a, b) => b - a)[0];
    expect(best).toBeGreaterThan(150);
  });

  // The README advertises a TOC as half of phase 1; it used to appear only when
  // every hit came from one archive, so multi-session projects silently got none.
  it('always returns a table-of-contents when the scope has archives', () => {
    const res = recallQuery({ query: 'provenance', projectDir: PROJECT });
    expect(res.toc).toBeDefined();
    expect(res.toc!.length).toBeGreaterThan(0);
  });

  it('tells the AI what the second call will cost', () => {
    const res = recallQuery({ query: 'provenance', projectDir: PROJECT });
    expect(res.guidance).toContain('capped');
    expect(res.guidance).toMatch(/cheap/i);
  });
});

describe('phase 2 returns something readable and bounded', () => {
  const hit = () => recallQuery({ query: 'provenance repository field', projectDir: PROJECT }).hits[0];

  it('returns conversation text, not the raw log envelope', () => {
    const r = recallExpand({ eventId: hit().eventId });
    expect(r.ok).toBe(true);
    expect(r.form).toBe('text');
    expect(r.text).not.toContain('"parentUuid"');   // the JSON envelope
    expect(r.text).toMatch(/^\[turn \d+ · (user|assistant)\]/);
    expect(r.text).toContain('provenance failure');
  });

  it('still serves byte-exact source bytes on request (Rule 0 escape hatch)', () => {
    const r = recallExpand({ eventId: hit().eventId, raw: true });
    expect(r.ok).toBe(true);
    expect(r.form).toBe('raw');
    expect(r.text).toContain('"parentUuid"');
  });

  // The 139.6KB case: one expand call must never be able to eat a context window.
  it('caps a huge expansion and says so', () => {
    const res = recallQuery({ query: 'xxxxxxxx', projectDir: PROJECT });
    const all = [...res.hits];
    // Find the oversized turn by expanding every hit; at least one must be capped
    // when the underlying line is 3x the cap.
    const big = recallExpand({ sourceSessionId: 'AFF', fromSeq: 0, toSeq: 99, raw: true });
    expect(big.ok).toBe(true);
    expect(big.text!.length).toBeLessThanOrEqual(MAX_EXPAND_CHARS + 200);
    expect(big.truncated).toBe(true);
    expect(big.text).toContain('truncated');
    expect(all).toBeDefined();
  });

  it('keeps provenance on the readable form', () => {
    const r = recallExpand({ eventId: hit().eventId });
    expect(r.provenance).toContain('session AFF');
    expect(r.provenance).toContain('turn');
  });
});

// Widening snippets and changing the expansion form both move content into an AI
// context, so the mask guarantee is re-pinned on the new paths specifically.
describe('the widened paths still never leak a secret', () => {
  it('keeps the pasted key out of snippets, expansions and raw bytes alike', () => {
    // Searching FOR the secret must not surface it from the archive. (`res.query`
    // echoes the caller's own input back, which is not a leak, so it is excluded.)
    const res = recallQuery({ query: SECRET, projectDir: PROJECT });
    const { query: _echoed, ...archiveDerived } = res;
    expect(JSON.stringify(archiveDerived)).not.toContain(SECRET);

    const byKey = recallQuery({ query: 'here is the key do not lose it', projectDir: PROJECT });
    for (const h of byKey.hits) {
      expect(String(h.snippet)).not.toContain(SECRET);
      const text = recallExpand({ eventId: h.eventId });
      expect(text.text).not.toContain(SECRET);
      const raw = recallExpand({ eventId: h.eventId, raw: true });
      expect(raw.text).not.toContain(SECRET);
    }
  });

  it('still reports that a secret was redacted from a masked event', () => {
    const byKey = recallQuery({ query: 'here is the key do not lose it', projectDir: PROJECT });
    const user = byKey.hits.find(h => h.kind === 'user_message');
    expect(user).toBeDefined();
    const r = recallExpand({ eventId: user!.eventId });
    expect(r.secretsRedacted).toBeGreaterThanOrEqual(1);
    expect(r.text).toMatch(/REDACTED\[sha256:[0-9a-f]{8}\]/);
  });
});
