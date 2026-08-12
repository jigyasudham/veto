// Chunk vectors: build, store, and query (VERSION-3 item 6, Phase B).
//
// Separated from embed.ts on purpose — that file is pure inference against a
// pinned contract, this one owns storage and lifecycle. It is also separate
// from ingest.ts: parsing must never depend on the model being installed, so
// vectors have their own marker (`archives.chunker_version` + `embed_model`)
// and are backfilled lazily. Installing the model later costs an embed pass,
// not a re-parse; removing it leaves search working on BM25 alone.
//
// Quantization note: cosine similarity is invariant to a positive per-vector
// scalar, so the dequantization scale cancels and is never stored. What IS
// stored is the int8 vector's own L2 norm, so scoring is a dot product and a
// divide.

import { getTranscriptsDb } from './store.js';
import { EMPTY_SCORE, getDocCache, getVectorCache, resetCaches, scopeMask, scoreScratch } from './cache.js';
import { CHUNKER_VERSION, chunkText } from './chunk.js';
import { embed, embeddingsAvailable, modelProvenance } from './embed.js';
import type { ArchiveRow } from './schema.js';

export type EmbedStatus = 'embedded' | 'already_embedded' | 'unavailable' | 'not_found' | 'error';
export type EmbedResult = { status: EmbedStatus; docs?: number; chunks?: number; reason?: string };

/** Identifies which model produced stored vectors; a change forces a rebuild. */
function modelTag(): string {
  const { model_id, revision } = modelProvenance();
  return `${model_id}@${revision}`;
}

/** Per-vector symmetric int8. The scale is deliberately discarded (see above). */
function quantize(vec: Float32Array): { bytes: Uint8Array; norm: number } {
  let max = 0;
  for (const v of vec) { const a = Math.abs(v); if (a > max) max = a; }
  const scale = max === 0 ? 1 : max / 127;

  const bytes = new Uint8Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    let q = Math.round(vec[i]! / scale);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    sumSq += q * q;
    // Int8 stored in a byte: two's complement, unpacked on read.
    bytes[i] = q < 0 ? q + 256 : q;
  }
  return { bytes, norm: Math.sqrt(sumSq) };
}

/** Read a stored row back into signed values for scoring. */
export function dequantizeToInt8(bytes: Uint8Array): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function needsEmbedding(row: ArchiveRow, tag: string): boolean {
  return row.chunker_version !== CHUNKER_VERSION || row.embed_model !== tag;
}

/**
 * Build chunk vectors for one archive's indexed docs. Idempotent, and a no-op
 * when the model is not installed — the caller degrades to BM25 rather than
 * failing (condition A2).
 */
export function embedArchive(archiveId: string): EmbedResult {
  try {
    if (!embeddingsAvailable()) return { status: 'unavailable' };
    const db = getTranscriptsDb();
    const row = db.prepare(`SELECT * FROM archives WHERE id = ?`).get(archiveId) as ArchiveRow | undefined;
    if (!row) return { status: 'not_found' };

    const tag = modelTag();
    if (!needsEmbedding(row, tag)) return { status: 'already_embedded' };

    // Only indexed, searchable docs get vectors — the same set BM25 covers,
    // read with their masked text (C3: masked text is the only text there is).
    const docs = db.prepare(
      `SELECT d.id AS doc_id, e.text AS text
         FROM search_docs d JOIN events e ON e.id = d.event_id
        WHERE d.archive_id = ?`
    ).all(archiveId) as { doc_id: number; text: string | null }[];

    const insVec = db.prepare(
      `INSERT INTO search_vectors (doc_id, chunk_index, vec, norm) VALUES (?, ?, ?, ?)`
    );

    let chunks = 0;
    db.exec('BEGIN');
    try {
      db.prepare(
        `DELETE FROM search_vectors WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).run(archiveId);

      for (const d of docs) {
        const text = d.text ?? '';
        if (!text.trim()) continue;
        for (const c of chunkText(text)) {
          const { bytes, norm } = quantize(embed(c.text));
          // A zero-norm chunk (no in-vocabulary tokens) can never win a cosine
          // and would divide by zero at query time; storing it is pure cost.
          if (norm === 0) continue;
          insVec.run(d.doc_id, c.index, bytes, norm);
          chunks += 1;
        }
      }

      db.prepare(`UPDATE archives SET chunker_version = ?, embed_model = ? WHERE id = ?`)
        .run(CHUNKER_VERSION, tag, archiveId);
      db.exec('COMMIT');
      resetCaches();
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return { status: 'embedded', docs: docs.length, chunks };
  } catch (e) {
    return { status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** `chunkIndex` is the window that won — used only to aim a snippet at the
 *  right part of a long event. Chunks never surface as results (C6). */
export type VectorHit = { docId: number; chunkIndex: number; score: number };

/**
 * Score every stored chunk against `query` and return the best score per doc.
 *
 * Max-sim, not mean: an event is relevant if ANY of its windows is, which is
 * the entire point of chunking. Dedup to docs happens here so nothing outside
 * this module ever sees a chunk (C6).
 */
export function searchVectors(
  query: string,
  opts: { projectDir?: string; sourceSessionId?: string; limit?: number } = {},
): VectorHit[] {
  if (!embeddingsAvailable()) return [];
  const db = getTranscriptsDb();

  const qv = embed(query);
  let qNorm = 0;
  for (const v of qv) qNorm += v * v;
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) return [];

  // Brute-force scan, but over a cached flat Int8Array rather than freshly
  // materialized rows. Measured at 27,070 chunks: the arithmetic is ~12 ms and
  // the SQL/Buffer marshalling it replaces was ~60 ms, every query. A full
  // scan is still the right algorithm — it cannot lose recall the way ANN
  // would — it just must not re-read the table each time.
  const cache = getVectorCache();
  if (cache.count === 0 || cache.dim !== qv.length) return [];
  const docs = getDocCache();
  const mask = scopeMask(docs, opts);

  const { data, norms, docIds, chunkIdx, dim } = cache;

  // Best-per-document is accumulated in flat arrays indexed by doc id, not a
  // Map. At 108k chunks the Map get/set pair was a six-figure allocation-heavy
  // operation count on the hot path; this is two typed-array writes. `touched`
  // records which ids were written so the result scan stays proportional to
  // matches rather than to the id space.
  const { score: bestScore, chunk: bestChunk } = scoreScratch(docs.maxId);
  const touched: number[] = [];

  // Single pass, full dot product per in-scope chunk.
  //
  // A two-pass scheme was tried and MEASURED SLOWER (170 ms vs 131 ms at 108k
  // chunks): score a PCA prefix, bound the tail by Cauchy-Schwarz, skip chunks
  // whose best possible score cannot reach the cutoff. It is exact, but the
  // bound is far too loose here — the tail retains enough norm that almost
  // nothing prunes, so it paid for the prefix and the bookkeeping and skipped
  // little. Recorded so it is not re-attempted on intuition.
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  for (let c = 0; c < cache.count; c += 1) {
    const docId = docIds[c]!;
    if (mask && mask[docId] !== 1) continue;
    const norm = norms[c]!;
    if (norm === 0) continue;
    const base = c * dim;
    // Unrolled by 8. Separate accumulations, not one chained sum: `dot +=
    // a+b+...+h` would add the eight products together first and change the
    // summation order.
    let dot = 0;
    let i = 0;
    for (; i + 8 <= dim; i += 8) {
      const b = base + i;
      dot += qv[i]! * data[b]!;
      dot += qv[i + 1]! * data[b + 1]!;
      dot += qv[i + 2]! * data[b + 2]!;
      dot += qv[i + 3]! * data[b + 3]!;
      dot += qv[i + 4]! * data[b + 4]!;
      dot += qv[i + 5]! * data[b + 5]!;
      dot += qv[i + 6]! * data[b + 6]!;
      dot += qv[i + 7]! * data[b + 7]!;
    }
    for (; i < dim; i += 1) dot += qv[i]! * data[base + i]!;
    const score = dot / (qNorm * norm);
    if (score > bestScore[docId]!) {
      if (bestScore[docId] === EMPTY_SCORE) touched.push(docId);
      bestScore[docId] = score;
      bestChunk[docId] = chunkIdx[c]!;
    }
  }

  const out = touched
    .map(docId => ({ docId, chunkIndex: bestChunk[docId]!, score: bestScore[docId]! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // The scratch buffers are shared and handed back dirty; clear exactly what
  // was written so the next query sees a clean slate without a full zero-fill.
  for (const docId of touched) bestScore[docId] = EMPTY_SCORE;
  return out;
}

/** Rows currently stored, for budget measurement and tests. */
export function vectorStats(): { chunks: number; bytes: number } {
  const db = getTranscriptsDb();
  const r = db.prepare(
    `SELECT COUNT(*) AS chunks, COALESCE(SUM(LENGTH(vec)), 0) AS bytes FROM search_vectors`
  ).get() as { chunks: number; bytes: number };
  return { chunks: Number(r.chunks), bytes: Number(r.bytes) };
}
