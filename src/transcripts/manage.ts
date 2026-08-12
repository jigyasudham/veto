// Management: list / show / purge + disk usage (VERSION-3 item 6, Step 13).
//
// Purge is a TRUE cascading delete — for each archive it removes the events, the
// search index rows (docs + postings), the archive row, the session mapping, and
// the L0 file, leaving no orphan rows (Step 14 asserts zero orphans). Row deletes
// run in one transaction; the L0 file is unlinked best-effort afterwards (a
// leftover file is harmless disk, a dangling row is not).

import { statSync, existsSync, rmSync } from 'node:fs';
import { getTranscriptsDb, transcriptsDbPath } from './store.js';
import { resetCaches } from './cache.js';
import { normalizeProjectDir } from '../memory/local.js';
import { buildTOC, type Segment } from './toc.js';
import { buildFacts, type SessionFacts } from './pyramid.js';
import type { ArchiveRow } from './schema.js';

export type ArchiveSummary = {
  sourceSessionId: string;
  source: string;
  projectDir: string | null;
  events: number;
  sourceBytes: number;
  archiveBytes: number;
  capturedAt: string;
  updatedAt: string;
  indexed: boolean;
};

function toSummary(r: ArchiveRow): ArchiveSummary {
  return {
    sourceSessionId: r.source_session_id, source: r.source, projectDir: r.project_dir,
    events: r.indexed_through_seq, sourceBytes: r.source_bytes, archiveBytes: r.archive_bytes,
    capturedAt: r.captured_at, updatedAt: r.updated_at, indexed: r.parser_version > 0,
  };
}

export function listArchives(opts: { projectDir?: string; limit?: number } = {}): ArchiveSummary[] {
  const db = getTranscriptsDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = opts.projectDir
    ? db.prepare(`SELECT * FROM archives WHERE project_dir = ? ORDER BY updated_at DESC LIMIT ?`).all(normalizeProjectDir(opts.projectDir), limit)
    : db.prepare(`SELECT * FROM archives ORDER BY updated_at DESC LIMIT ?`).all(limit);
  return (rows as ArchiveRow[]).map(toSummary);
}

export type ArchiveDetail = { summary: ArchiveSummary; toc: Segment[]; facts: SessionFacts } | null;

export function showArchive(sourceSessionId: string, source = 'claude'): ArchiveDetail {
  const db = getTranscriptsDb();
  const r = db.prepare(`SELECT * FROM archives WHERE source = ? AND source_session_id = ?`).get(source, sourceSessionId) as ArchiveRow | undefined;
  if (!r) return null;
  return { summary: toSummary(r), toc: buildTOC(r.id), facts: buildFacts(r.id) };
}

export type PurgeResult = { archives: number; events: number; indexRows: number; files: number; mappings: number };

function purgeArchiveRows(archives: ArchiveRow[]): PurgeResult {
  const db = getTranscriptsDb();
  const res: PurgeResult = { archives: 0, events: 0, indexRows: 0, files: 0, mappings: 0 };
  const paths: string[] = [];
  db.exec('BEGIN');
  try {
    for (const a of archives) {
      res.events += (db.prepare(`SELECT COUNT(*) n FROM events WHERE archive_id = ?`).get(a.id) as { n: number }).n;
      // Two plain queries, not one with a reused ?1 — node 22.13's sqlite
      // binding doesn't dedupe numbered parameters (SQLITE_RANGE on CI).
      res.indexRows += (db.prepare(
        `SELECT COUNT(*) n FROM search_docs WHERE archive_id = ?`
      ).get(a.id) as { n: number }).n;
      res.indexRows += (db.prepare(
        `SELECT COUNT(*) n FROM search_postings WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).get(a.id) as { n: number }).n;
      // Chunk vectors hang off the same doc ids, so they orphan the same way
      // postings would if this were forgotten (C3 asserts zero orphans).
      res.indexRows += (db.prepare(
        `SELECT COUNT(*) n FROM search_vectors WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).get(a.id) as { n: number }).n;
      db.prepare(`DELETE FROM events WHERE archive_id = ?`).run(a.id);
      db.prepare(
        `DELETE FROM search_postings WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).run(a.id);
      db.prepare(
        `DELETE FROM search_vectors WHERE doc_id IN (SELECT id FROM search_docs WHERE archive_id = ?)`
      ).run(a.id);
      db.prepare(`DELETE FROM search_docs WHERE archive_id = ?`).run(a.id);
      db.prepare(`DELETE FROM archives WHERE id = ?`).run(a.id);
      const m = db.prepare(`DELETE FROM session_map WHERE source = ? AND source_session_id = ?`).run(a.source, a.source_session_id);
      res.mappings += Number(m.changes ?? 0);
      res.archives += 1;
      if (a.archive_path) paths.push(a.archive_path);
    }
    db.exec('COMMIT');
    resetCaches();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Rows are gone and committed; remove the L0 files best-effort.
  for (const p of paths) {
    if (existsSync(p)) { try { rmSync(p); res.files += 1; } catch { /* leftover file is harmless */ } }
  }
  return res;
}

export function purgeSession(sourceSessionId: string, source = 'claude'): PurgeResult {
  const db = getTranscriptsDb();
  const arch = db.prepare(`SELECT * FROM archives WHERE source = ? AND source_session_id = ?`).get(source, sourceSessionId) as ArchiveRow | undefined;
  const result = purgeArchiveRows(arch ? [arch] : []);
  // Purge the mapping even if there was no archive yet (capture never ran).
  if (!arch) {
    const m = db.prepare(`DELETE FROM session_map WHERE source = ? AND source_session_id = ?`).run(source, sourceSessionId);
    result.mappings += Number(m.changes ?? 0);
  }
  return result;
}

export function purgeProject(projectDir: string): PurgeResult {
  const db = getTranscriptsDb();
  const archives = db.prepare(`SELECT * FROM archives WHERE project_dir = ?`).all(normalizeProjectDir(projectDir)) as ArchiveRow[];
  return purgeArchiveRows(archives);
}

export function purgeAll(): PurgeResult {
  const db = getTranscriptsDb();
  const archives = db.prepare(`SELECT * FROM archives`).all() as ArchiveRow[];
  const res = purgeArchiveRows(archives);
  // Sweep any orphan mappings left with no archive.
  const m = db.prepare(`DELETE FROM session_map`).run();
  res.mappings = Math.max(res.mappings, Number(m.changes ?? 0));
  return res;
}

export type DiskUsage = { archives: number; archiveBytes: number; dbBytes: number; totalBytes: number };

export function transcriptsDiskUsage(): DiskUsage {
  const db = getTranscriptsDb();
  const agg = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(archive_bytes), 0) b FROM archives`).get() as { n: number; b: number };
  let dbBytes = 0;
  try { dbBytes = statSync(transcriptsDbPath()).size; } catch { /* db not on disk (memory) */ }
  return { archives: agg.n, archiveBytes: agg.b, dbBytes, totalBytes: dbBytes + agg.b };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
