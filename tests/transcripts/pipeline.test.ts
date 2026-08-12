import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

// End-to-end semantic pipeline on a SYNTHETIC model, so this runs in CI on
// every commit rather than skipping until @jigyasudham/veto-model publishes.
//
// The fixture is a real payload in the shipped format (8 dims, 24 tokens,
// hand-placed vectors) — see scripts/make-tiny-model.ts. It cannot vouch for
// numerical fidelity; that is what the golden vectors do against the real
// model. What it pins is the plumbing: load and validate a payload, tokenize,
// chunk, embed, store, score, fuse, scope, and degrade.
const ROOT = join(tmpdir(), `veto-pipeline-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;
process.env.VETO_MODEL_DIR = resolve(__dirname, '..', 'fixtures', 'tiny-model');

const { captureSession } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { searchEvents, searchEventsHybrid } = await import('../../src/transcripts/search.js');
const { embedArchive, searchVectors } = await import('../../src/transcripts/vectors.js');
const { embed, embeddingsAvailable, tokenizeForEmbedding, cosine, modelProvenance } =
  await import('../../src/transcripts/embed.js');
const { getTranscriptsDb, resetTranscriptsDb } = await import('../../src/transcripts/store.js');

const PROJECT = 'd:\\pipeline';

async function addSession(sessionId: string, lines: string[]): Promise<string> {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((text, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: `${sessionId}-${i}`,
      timestamp: `2026-08-12T10:0${i}:00.000Z`,
      sessionId,
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? text : [{ type: 'text', text }],
      },
    }),
  ).join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: PROJECT });
  await captureSession({ sourceSessionId: sessionId });
  ingestSession(sessionId);
  const db = getTranscriptsDb();
  return (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
    .get(sessionId) as { id: string }).id;
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
  delete process.env.VETO_MODEL_DIR;
});

describe('semantic pipeline on a synthetic model', () => {
  it('loads and validates the fixture payload', () => {
    expect(embeddingsAvailable()).toBe(true);
    expect(modelProvenance().model_id).toBe('synthetic/tiny-test-model');
  });

  it('honours the inference contract', () => {
    // No special tokens, and a zero vector for input with no known tokens.
    expect(tokenizeForEmbedding('the')).toHaveLength(1);
    expect(embed('').every(x => x === 0)).toBe(true);
    // Case folding and accent stripping still apply.
    expect(tokenizeForEmbedding('THE')).toEqual(tokenizeForEmbedding('the'));
    const v = embed('credentials expired');
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5);
  });

  it('places related vocabulary closer than unrelated vocabulary', () => {
    const a = embed('credentials expired registry rejected');
    const b = embed('authentication lapsed package push refused');
    const c = embed('kitchen sink full dishes');
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  it('embeds an archive and stores one vector per window', async () => {
    const archiveId = await addSession('P1', [
      'the credentials expired so the registry rejected the upload',
      'a note of the kitchen sink full of dishes',
    ]);
    const res = embedArchive(archiveId);
    expect(res.status).toBe('embedded');
    expect(res.chunks).toBeGreaterThan(0);

    const db = getTranscriptsDb();
    const rows = db.prepare(
      `SELECT LENGTH(v.vec) AS bytes FROM search_vectors v
         JOIN search_docs d ON d.id = v.doc_id WHERE d.archive_id = ?`
    ).all(archiveId) as { bytes: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.bytes).toBe(8);
  });

  it('retrieves a document with no shared vocabulary with the query', () => {
    // Query words appear nowhere in the target; only their direction matches.
    const hits = searchVectors('authentication lapsed package push refused', { projectDir: PROJECT });
    expect(hits.length).toBeGreaterThan(0);
    const db = getTranscriptsDb();
    const top = db.prepare(`SELECT event_id FROM search_docs WHERE id = ?`)
      .get(hits[0].docId) as { event_id: string };
    const text = (db.prepare(`SELECT text FROM events WHERE id = ?`)
      .get(top.event_id) as { text: string }).text;
    expect(text).toContain('credentials expired');
  });

  it('fuses with BM25 and keeps an exact keyword hit', () => {
    const hits = searchEventsHybrid('kitchen dishes', { projectDir: PROJECT });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet.toLowerCase()).toContain('kitchen');
  });

  it('scopes results and returns nothing for out-of-vocabulary queries', () => {
    expect(searchEventsHybrid('zzz-unknown-token', { projectDir: PROJECT })).toEqual([]);
    expect(searchEvents('credentials', { projectDir: 'd:\\somewhere-else' })).toEqual([]);
  });
});
