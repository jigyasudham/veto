// Save-time capture orchestration (VERSION-3 item 6, Step 7).
//
// Runs capture, then (bounded) ingest so the save response can report the leak
// count and the one-time first-capture note. Never throws — the caller wraps it
// too, but this returns null on any problem so a save is never affected.

import { isCaptureEnabled, firstCaptureNote, effectiveTranscriptsDir } from './config.js';
import { captureSession } from './archive.js';
import { ingestArchive } from './ingest.js';

// Don't parse+index a monster transcript inline on the save path (architect:
// keep save-time work bounded). Above this, capture still archives; indexing is
// deferred to first recall (Step 11's ensureIndexed).
const INLINE_INGEST_MAX_BYTES = 16 * 1024 * 1024;

export type OnSaveTranscript = {
  status: string;               // archived | unchanged | skipped | error
  events?: number;
  secrets_redacted?: number;
  archive_dir?: string;
  note?: string;
};

export async function captureOnSave(opts: { projectDir?: string | null; vetoSessionId?: string | null }): Promise<OnSaveTranscript | null> {
  if (!isCaptureEnabled()) return null;

  const cap = await captureSession({ source: 'claude', projectDir: opts.projectDir, vetoSessionId: opts.vetoSessionId });
  if (!cap.ok) return null; // skipped (no mapping / missing / too_large) or error — stay silent

  const out: OnSaveTranscript = { status: cap.status };

  // Index inline for small transcripts so we can report the leak count now.
  if (cap.archiveId && cap.status === 'archived' && (cap.sourceBytes ?? 0) <= INLINE_INGEST_MAX_BYTES) {
    const ing = ingestArchive(cap.archiveId);
    if (ing.status === 'indexed') {
      out.events = ing.events;
      out.secrets_redacted = ing.secretsRedacted;
    }
  }

  const note = firstCaptureNote();
  if (note) {
    out.archive_dir = effectiveTranscriptsDir();
    out.note = out.secrets_redacted
      ? `${note} (${out.secrets_redacted} secret-like string(s) were redacted from the index.)`
      : note;
  }
  return out;
}
