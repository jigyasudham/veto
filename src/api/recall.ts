// `veto api recall search | expand` — the same recall as veto_session_replay,
// with the scope an extension's UI needs enforced here rather than trusted.
//
//   • A project is required. Search never widens to every project.
//   • Expand checks that the event or archive belongs to that project; the MCP
//     tool's expand does not, because an AI only expands ids its own search
//     returned. A UI is handed ids from outside, so here the boundary is checked,
//     and an id from another project is answered exactly like a missing one.
//   • Text is masked again on the way out and never raw.
//   • Search is the one command that writes: the first search of an archive
//     indexes it (and may compute vectors). It never creates an index that does
//     not exist. Expand only reads.
//   • Archives kept after capture was turned off stay searchable (owner
//     decision); every response says what state capture is in.

import { existsSync } from 'node:fs';
import type { Envelope } from './contract.js';
import { captureLabel, dbMismatch, envelope, maskHome, type ApiContext } from './common.js';

const MAX_TOC_ARCHIVES = 3;
const MAX_SEGMENTS_PER_ARCHIVE = 40;

async function preflight(ctx: ApiContext, db: string | undefined): Promise<Envelope | null> {
  const mismatch = await dbMismatch(ctx, db);
  if (mismatch) return mismatch;
  const { sqliteAvailable } = await import('../memory/local.js');
  if (!sqliteAvailable()) {
    return envelope(ctx, 'sqlite_unavailable', {
      message: `Node ${process.version} cannot load node:sqlite, so Veto cannot search its archives.`,
      next_action: 'Use Node 22.13 or later (or 23.4 or later).',
    });
  }
  return null;
}

function noArchive(ctx: ApiContext, capture: string): Envelope {
  return envelope(ctx, 'no_archive', {
    message: capture === 'enabled'
      ? 'Nothing is archived for this project yet. A chat is archived when a session is saved from it.'
      : 'Nothing is archived for this project, and transcript capture is off.',
    next_action: capture === 'enabled' ? 'Save a session with veto_session_save in your AI app.' : 'veto transcripts enable',
    data: { capture },
  });
}

export async function apiRecallSearch(
  ctx: ApiContext,
  req: { project: string; query: string; limit: number; source?: string; db?: string },
): Promise<Envelope> {
  const stop = await preflight(ctx, req.db);
  if (stop) return stop;
  const started = Date.now();
  const { normalizeProjectDir } = await import('../memory/local.js');
  const store = await import('../transcripts/store.js');
  const dir = normalizeProjectDir(req.project);
  const capture = await captureLabel();
  if (!existsSync(store.transcriptsDbPath())) return noArchive(ctx, capture);

  const { archivesForProject, recallQuery, DATA_NOTE } = await import('../transcripts/recall.js');
  const { mask } = await import('../transcripts/mask.js');
  const scope = archivesForProject(dir);
  if (scope.length === 0) return noArchive(ctx, capture);

  // A source filter is applied to the ranked hits, so ask for the most there can be.
  const res = recallQuery({ query: req.query, projectDir: dir, limit: req.source ? 20 : req.limit });
  if (!res.ok) return envelope(ctx, 'error', { message: maskHome(res.reason ?? 'recall failed') });

  const db = store.getTranscriptsDb();
  const archiveSource = new Map((db.prepare('SELECT id, source FROM archives').all() as Array<{ id: string; source: string }>).map(a => [a.id, a.source]));
  const eventTs = db.prepare('SELECT ts_utc FROM events WHERE id = ?');
  const hits = res.hits
    .map(h => ({ ...h, source: archiveSource.get(h.archiveId) ?? 'unknown' }))
    .filter(h => !req.source || h.source === req.source)
    .slice(0, req.limit)
    .map(h => ({
      event_id: h.eventId,
      archive_id: h.archiveId,
      source: h.source,
      source_session_id: h.sourceSessionId,
      seq: h.seq,
      kind: h.kind,
      ts: (eventTs.get(h.eventId) as { ts_utc: string | null } | undefined)?.ts_utc ?? null,
      snippet: mask(h.snippet).text,
      score: h.score,
    }));

  // The segments of the chats that matched, so a UI can offer them to expand.
  const { buildTOC } = await import('../transcripts/toc.js');
  const segments = [...new Set(hits.map(h => h.archive_id))].slice(0, MAX_TOC_ARCHIVES).flatMap(archiveId =>
    buildTOC(archiveId).slice(0, MAX_SEGMENTS_PER_ARCHIVE).map(s => ({
      archive_id: archiveId, index: s.index, title: mask(s.title).text, first_ts: s.firstTs, last_ts: s.lastTs,
      user_messages: s.userMessages, tool_calls: s.toolCalls,
    })));

  const data = {
    capture, disclaimer: DATA_NOTE, retrieval: res.retrieval, archives_searched: scope.length,
    elapsed_ms: Date.now() - started, hits, segments,
  };
  if (hits.length === 0) {
    return envelope(ctx, 'no_match', { message: 'Nothing in this project\'s archived chats matched.', next_action: 'Try other words, such as a file name or an error message.', data });
  }
  return envelope(ctx, 'ok', { data });
}

export async function apiRecallExpand(
  ctx: ApiContext,
  req: { project: string; event_id?: string; archive_id?: string; segment_index?: number; db?: string },
): Promise<Envelope> {
  const stop = await preflight(ctx, req.db);
  if (stop) return stop;
  const { normalizeProjectDir } = await import('../memory/local.js');
  const store = await import('../transcripts/store.js');
  const { projectKey } = await import('../transcripts/project-key.js');
  const want = projectKey(normalizeProjectDir(req.project));
  const capture = await captureLabel();
  const notFound = () => envelope(ctx, 'not_found', {
    message: 'That item is not in this project\'s archived chats.',
    next_action: 'Search again; results from another project cannot be opened here.',
    data: { capture },
  });

  if (!store.useReadOnlyTranscriptsDb()) return notFound();
  const db = store.getTranscriptsDb();
  const archiveId = req.event_id
    ? (db.prepare('SELECT archive_id FROM events WHERE id = ?').get(req.event_id) as { archive_id: string } | undefined)?.archive_id
    : req.archive_id;
  if (!archiveId) return notFound();
  const archive = db.prepare('SELECT project_dir FROM archives WHERE id = ?').get(archiveId) as { project_dir: string | null } | undefined;
  if (!archive?.project_dir || projectKey(archive.project_dir) !== want) return notFound();

  const { recallExpand, DATA_NOTE } = await import('../transcripts/recall.js');
  const { mask } = await import('../transcripts/mask.js');
  const r = req.event_id
    ? recallExpand({ eventId: req.event_id })
    : recallExpand({ archiveId, segmentIndex: req.segment_index });
  if (!r.ok && r.reason === 'no_events') {
    // A segment that holds only metadata, such as "(session start)": it exists, it just has no text.
    return envelope(ctx, 'ok', {
      data: {
        capture, disclaimer: DATA_NOTE, source: 'unknown', source_session_id: '', from_seq: null, to_seq: null,
        provenance: null, text: '', truncated: false, secrets_redacted: 0,
      },
    });
  }
  if (!r.ok) {
    return /not_found/.test(r.reason ?? '') ? notFound() : envelope(ctx, 'error', { message: maskHome(r.reason ?? 'expand failed') });
  }
  const m = mask(r.text ?? '');
  return envelope(ctx, 'ok', {
    data: {
      capture, disclaimer: DATA_NOTE,
      source: r.source ?? 'unknown', source_session_id: r.sourceSessionId ?? '',
      from_seq: r.fromSeq ?? null, to_seq: r.toSeq ?? null, provenance: r.provenance ?? null,
      text: m.text, truncated: r.truncated === true, secrets_redacted: Math.max(r.secretsRedacted ?? 0, m.count),
    },
  });
}
