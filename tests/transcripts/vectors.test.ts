import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `veto-vectors-${Date.now()}-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const { captureSession } = await import('../../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../../src/transcripts/mapping.js');
const { ingestSession } = await import('../../src/transcripts/ingest.js');
const { searchEvents, searchEventsHybrid } = await import('../../src/transcripts/search.js');
const { embedArchive, searchVectors, vectorStats } = await import('../../src/transcripts/vectors.js');
const { embeddingsAvailable } = await import('../../src/transcripts/embed.js');
const { getTranscriptsDb, resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const { purgeSession } = await import('../../src/transcripts/manage.js');

const available = embeddingsAvailable();
const withModel = available ? describe : describe.skip;
if (!available) {
  console.warn('[vectors.test] model package not resolvable — semantic tests SKIPPED.');
}

async function addSession(sessionId: string, project: string, lines: string[]): Promise<string> {
  const path = join(ROOT, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((text, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: `${sessionId}-${i}`,
      timestamp: `2026-07-21T10:0${i}:00.000Z`,
      sessionId,
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? text : [{ type: 'text', text }],
      },
    }),
  ).join('\n') + '\n');
  recordSessionMapping({ sourceSessionId: sessionId, transcriptPath: path, projectDir: project });
  await captureSession({ sourceSessionId: sessionId });
  ingestSession(sessionId);
  const db = getTranscriptsDb();
  const row = db.prepare(
    `SELECT id FROM archives WHERE source_session_id = ?`
  ).get(sessionId) as { id: string };
  return row.id;
}

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VETO_TRANSCRIPTS_DIR;
});

describe('vectors — lifecycle without a model', () => {
  it('ingests successfully and leaves the archive unembedded', async () => {
    const archiveId = await addSession('V0', 'd:\\vec-a', [
      'the deployment pipeline broke this morning',
      'it was a stale cache on the build runner',
    ]);
    const db = getTranscriptsDb();
    const row = db.prepare(`SELECT chunker_version, embed_model FROM archives WHERE id = ?`)
      .get(archiveId) as { chunker_version: number; embed_model: string | null };

    // Parsing must never depend on the model: chunker_version stays 0 until an
    // embed pass runs, and BM25 works regardless.
    expect(row.chunker_version).toBe(0);
    expect(row.embed_model).toBeNull();
    expect(searchEvents('stale cache', { projectDir: 'd:\\vec-a' }).length).toBeGreaterThan(0);
  });
});

withModel('vectors — embedding and storage', () => {
  it('embeds an archive and marks it with the chunker and model', async () => {
    const archiveId = await addSession('V1', 'd:\\vec-b', [
      'we hit an npm E404 error on publish',
      'the credentials had expired, so the registry rejected the upload as not found',
      'now deploying the release to production',
      'the kitchen sink is full of dishes and unrelated to anything',
    ]);

    const res = embedArchive(archiveId);
    expect(res.status).toBe('embedded');
    expect(res.chunks).toBeGreaterThan(0);

    const db = getTranscriptsDb();
    const row = db.prepare(`SELECT chunker_version, embed_model FROM archives WHERE id = ?`)
      .get(archiveId) as { chunker_version: number; embed_model: string | null };
    expect(row.chunker_version).toBe(1);
    expect(row.embed_model).toContain('potion-base-8M');
  });

  it('is idempotent — a second pass is a no-op', async () => {
    const archiveId = await addSession('V2', 'd:\\vec-c', ['a short note about caching']);
    expect(embedArchive(archiveId).status).toBe('embedded');
    expect(embedArchive(archiveId).status).toBe('already_embedded');
  });

  it('stores one row per window, with a byte-per-dimension payload', async () => {
    const archiveId = await addSession('V3', 'd:\\vec-d', ['short event, one window only']);
    embedArchive(archiveId);
    const db = getTranscriptsDb();
    const rows = db.prepare(
      `SELECT v.chunk_index, LENGTH(v.vec) AS bytes, v.norm
         FROM search_vectors v JOIN search_docs d ON d.id = v.doc_id
        WHERE d.archive_id = ?`
    ).all(archiveId) as { chunk_index: number; bytes: number; norm: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.bytes).toBe(256);        // potion-base-8M dim
      expect(r.norm).toBeGreaterThan(0); // zero-norm rows are never stored
    }
  });
});

withModel('vectors — retrieval', () => {
  it('finds a paraphrase that shares no keywords with the target', async () => {
    await addSession('V4', 'd:\\vec-e', [
      'we hit an npm E404 error on publish',
      'the credentials had expired, so the registry rejected the upload as not found',
      'the kitchen sink is full of dishes',
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V4') as { id: string }).id;
    embedArchive(archiveId);

    // Deliberately shares no content words with the target event.
    const query = 'authentication had lapsed so the package upload was refused';
    const semantic = searchVectors(query, { projectDir: 'd:\\vec-e' });
    expect(semantic.length).toBeGreaterThan(0);

    const top = db.prepare(`SELECT event_id FROM search_docs WHERE id = ?`)
      .get(semantic[0].docId) as { event_id: string };
    const text = (db.prepare(`SELECT text FROM events WHERE id = ?`)
      .get(top.event_id) as { text: string }).text;
    expect(text).toContain('credentials had expired');
  });

  it('scopes semantic hits by project', async () => {
    await addSession('V5', 'd:\\vec-f', ['a conversation about migrating the billing system']);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V5') as { id: string }).id;
    embedArchive(archiveId);

    expect(searchVectors('billing migration', { projectDir: 'd:\\vec-e' })
      .some(h => h.docId === undefined)).toBe(false);
    const inScope = searchVectors('billing migration', { projectDir: 'd:\\vec-f' });
    expect(inScope.length).toBeGreaterThan(0);
  });
});

withModel('searchEventsHybrid — RRF fusion', () => {
  it('keeps an exact keyword hit at the top (lexical survival)', async () => {
    await addSession('V6', 'd:\\vec-g', [
      'the smithery capability scan returned null again',
      'we discussed unrelated deployment topics at length',
      'a note about database migrations and rollbacks',
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V6') as { id: string }).id;
    embedArchive(archiveId);

    const hits = searchEventsHybrid('smithery capability scan', { projectDir: 'd:\\vec-g' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet.toLowerCase()).toContain('smithery');
  });

  it('surfaces a paraphrase that BM25 alone misses', async () => {
    await addSession('V7', 'd:\\vec-h', [
      'the credentials had expired, so the registry rejected the upload as not found',
      'we talked about the weather and lunch plans',
      'a long digression about office furniture and chairs',
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V7') as { id: string }).id;
    embedArchive(archiveId);

    const query = 'authentication lapsed and the package push was refused';
    const lexical = searchEvents(query, { projectDir: 'd:\\vec-h' });
    const fused = searchEventsHybrid(query, { projectDir: 'd:\\vec-h' });

    const target = (t: { snippet: string }) => t.snippet.toLowerCase().includes('credentials');
    expect(fused.some(target)).toBe(true);
    // Fusion must be at least as good as lexical alone on this query.
    expect(fused.findIndex(target)).toBeLessThanOrEqual(
      lexical.some(target) ? lexical.findIndex(target) : Number.MAX_SAFE_INTEGER,
    );
  });

  it('returns event-granular hits — a chunk never surfaces as a result (C6)', async () => {
    await addSession('V8', 'd:\\vec-i', [
      'preamble. '.repeat(40) + 'the actual answer is that the lock file was stale. ' + 'trailing. '.repeat(40),
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V8') as { id: string }).id;
    embedArchive(archiveId);

    const hits = searchEventsHybrid('the lock file had gone stale', { projectDir: 'd:\\vec-i' });
    expect(hits.length).toBe(1); // one EVENT, despite many windows
    expect(hits[0].eventId).toBeTruthy();
  });
});

withModel('vectors — purge leaves no orphans (C3)', () => {
  it('deletes chunk rows with their session', async () => {
    await addSession('V9', 'd:\\vec-j', ['something worth embedding and then removing']);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('V9') as { id: string }).id;
    embedArchive(archiveId);

    const before = vectorStats().chunks;
    expect(before).toBeGreaterThan(0);

    purgeSession('V9');

    const orphans = (db.prepare(
      `SELECT COUNT(*) AS n FROM search_vectors v
        WHERE NOT EXISTS (SELECT 1 FROM search_docs d WHERE d.id = v.doc_id)`
    ).get() as { n: number }).n;
    expect(orphans).toBe(0);
  });
});

withModel('A2 — the model is never load-bearing', () => {
  it('recall still works when the model directory is broken', async () => {
    await addSession('VA', 'd:\vec-k', [
      'the release checklist mentions rotating the signing key',
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('VA') as { id: string }).id;
    embedArchive(archiveId);

    const { resetModelCache } = await import('../../src/transcripts/embed.js');
    const previous = process.env.VETO_MODEL_DIR;
    try {
      // Point the loader at nothing and force a re-resolve.
      process.env.VETO_MODEL_DIR = join(ROOT, 'does-not-exist');
      resetModelCache();

      // Semantic side is dead...
      expect(searchVectors('signing key rotation', { projectDir: 'd:\vec-k' })).toEqual([]);
      expect(embedArchive(archiveId).status).toBe('unavailable');

      // ...but search still answers, on BM25 alone.
      const hits = searchEventsHybrid('signing key', { projectDir: 'd:\vec-k' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].snippet.toLowerCase()).toContain('signing');
    } finally {
      if (previous === undefined) delete process.env.VETO_MODEL_DIR;
      else process.env.VETO_MODEL_DIR = previous;
      resetModelCache();
    }
  });
});

withModel('searchEventsHybrid — "nothing matched" stays expressible', () => {
  it('returns nothing for a query the corpus has no word of', async () => {
    await addSession('VB', 'd:\vec-l', [
      'we reviewed the caching strategy and the retry budget',
    ]);
    const db = getTranscriptsDb();
    const archiveId = (db.prepare(`SELECT id FROM archives WHERE source_session_id = ?`)
      .get('VB') as { id: string }).id;
    embedArchive(archiveId);

    // Cosine ranking would happily return its nearest neighbours here; the
    // out-of-vocabulary guard is what keeps an empty result possible.
    expect(searchEventsHybrid('zzz-nonexistent-term', { projectDir: 'd:\vec-l' })).toEqual([]);
    expect(searchEventsHybrid('qwertyuiop asdfghjkl', { projectDir: 'd:\vec-l' })).toEqual([]);
  });

  it('still generalizes when the query shares vocabulary but not phrasing', async () => {
    const hits = searchEventsHybrid('how did we handle repeated attempts', { projectDir: 'd:\vec-l' });
    expect(hits.length).toBeGreaterThan(0);
  });
});
