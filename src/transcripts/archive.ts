// L0 archive: byte-for-byte gzip of a host transcript (VERSION-3 item 6, Step 5).
//
// Rule 0 — the original is copied verbatim and never transformed. The raw bytes
// (even a truncated final JSONL line) are preserved exactly, so a better parser
// later can re-derive from L0 with nothing lost. Capture is best-effort: it NEVER
// throws, so it can be called on the save path without ever breaking a save.
//
// Dedup: one archive per source session, keyed by content hash. Re-capturing an
// unchanged transcript is a no-op; a grown transcript overwrites in place (latest
// wins) rather than accumulating N gzips per save.

import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { archiveDir, getTranscriptsDb, transcriptsAvailable } from './store.js';
import { getSessionMapping, latestMappingForProject } from './mapping.js';
import { normalizeProjectDir } from '../memory/local.js';
import type { ArchiveRow } from './schema.js';

// Above this raw size we skip capture with a warning rather than gzip a monster
// transcript on the save path. 128 MB is already an enormous single session.
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export type CaptureStatus = 'archived' | 'unchanged' | 'skipped' | 'error';

export type CaptureResult = {
  ok: boolean;
  status: CaptureStatus;
  reason?: string;
  archiveId?: string;
  archivePath?: string;
  sourceSessionId?: string;
  sourceBytes?: number;
  archiveBytes?: number;
  contentSha256?: string;
};

export type CaptureOptions = {
  source?: string;
  sourceSessionId?: string;      // exact session; else resolve newest-for-project
  projectDir?: string | null;
  vetoSessionId?: string | null; // link back to veto.db sessions.id
};

export function getArchive(sourceSessionId: string, source = 'claude'): ArchiveRow | null {
  const db = getTranscriptsDb();
  return (db.prepare(
    `SELECT * FROM archives WHERE source = ? AND source_session_id = ?`
  ).get(source, sourceSessionId) as ArchiveRow | undefined) ?? null;
}

// Stream the file through sha256 (dedup key) without loading it into memory.
function hashFile(src: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const rs = createReadStream(src);
    rs.on('error', reject);
    rs.on('data', (c: string | Buffer) => { bytes += c.length; hash.update(c); });
    rs.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

export async function captureSession(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const source = opts.source ?? 'claude';
  try {
    if (!transcriptsAvailable()) return { ok: false, status: 'skipped', reason: 'sqlite_unavailable' };

    // Which transcript file? Exact session id if given, else newest active mapping
    // for the project (S5: ties broken by recency).
    const mapping = opts.sourceSessionId
      ? getSessionMapping(opts.sourceSessionId, source)
      : opts.projectDir
        ? latestMappingForProject(opts.projectDir, source)
        : null;
    if (!mapping) return { ok: false, status: 'skipped', reason: 'no_mapping' };

    const sessionId = mapping.source_session_id;
    const transcriptPath = mapping.transcript_path;
    if (!existsSync(transcriptPath)) {
      return { ok: false, status: 'skipped', reason: 'transcript_missing', sourceSessionId: sessionId };
    }

    const size = statSync(transcriptPath).size;
    if (size > MAX_SOURCE_BYTES) {
      return { ok: false, status: 'skipped', reason: 'too_large', sourceSessionId: sessionId, sourceBytes: size };
    }

    const { sha256, bytes } = await hashFile(transcriptPath);
    const existing = getArchive(sessionId, source);
    if (existing && existing.content_sha256 === sha256) {
      return {
        ok: true, status: 'unchanged', archiveId: existing.id, archivePath: existing.archive_path,
        sourceSessionId: sessionId, sourceBytes: bytes, archiveBytes: existing.archive_bytes, contentSha256: sha256,
      };
    }

    // Stream gzip → stable per-session path (overwrite = latest wins).
    mkdirSync(archiveDir(), { recursive: true });
    const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const archivePath = join(archiveDir(), `${source}__${safeId}.gz`);
    await pipeline(createReadStream(transcriptPath), createGzip(), createWriteStream(archivePath));
    const archiveBytes = statSync(archivePath).size;

    const db = getTranscriptsDb();
    const now = new Date().toISOString();
    const proj = opts.projectDir ? normalizeProjectDir(opts.projectDir) : mapping.project_dir;
    const formatHint = source === 'claude' ? 'claude-jsonl' : source;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      // Content changed (grew): overwrite the row, reset the index watermark so
      // Step 6 re-derives from the new bytes.
      db.prepare(
        `UPDATE archives SET archive_path=?, content_sha256=?, source_bytes=?, archive_bytes=?,
           project_dir=COALESCE(?, project_dir), veto_session_id=COALESCE(?, veto_session_id),
           updated_at=?, indexed_through_seq=0 WHERE id=?`
      ).run(archivePath, sha256, bytes, archiveBytes, proj, opts.vetoSessionId ?? null, now, id);
    } else {
      db.prepare(
        `INSERT INTO archives (id, source, source_session_id, project_dir, veto_session_id, archive_path,
           content_sha256, source_bytes, archive_bytes, source_format_hint, parser_version, indexed_through_seq,
           captured_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      ).run(id, source, sessionId, proj, opts.vetoSessionId ?? null, archivePath, sha256, bytes, archiveBytes, formatHint, now, now);
    }

    return {
      ok: true, status: 'archived', archiveId: id, archivePath,
      sourceSessionId: sessionId, sourceBytes: bytes, archiveBytes, contentSha256: sha256,
    };
  } catch (e) {
    return { ok: false, status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
