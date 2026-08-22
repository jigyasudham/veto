// Save-time capture orchestration (VERSION-3 item 6, Step 7).
//
// Runs capture, then (bounded) ingest so the save response can report the leak
// count and the one-time first-capture note. Never throws — the caller wraps it
// too, but this returns null on any problem so a save is never affected.
//
// The source is the platform the save declares (`veto_session_save`'s `platform`
// arg), because that is the CLI whose transcript the user is actually in. Claude
// Code publishes its own mapping from the statusline; Codex and Gemini have no
// such hook, so their mapping is discovered from disk first (see discover.ts).

import { isCaptureEnabled, firstCaptureNote, effectiveTranscriptsDir } from './config.js';
import { captureSession } from './archive.js';
import { ingestArchive } from './ingest.js';
import { isTranscriptSource, type TranscriptSource } from './adapters/index.js';

// Don't parse+index a monster transcript inline on the save path (architect:
// keep save-time work bounded). Above this, capture still archives; indexing is
// deferred to first recall (Step 11's ensureIndexed).
const INLINE_INGEST_MAX_BYTES = 16 * 1024 * 1024;

export type OnSaveTranscript = {
  status: string;               // archived | unchanged | skipped | error
  source?: string;
  events?: number;
  secrets_redacted?: number;
  archive_dir?: string;
  note?: string;
};

/** Map a declared save platform onto a capture source; unknown platforms → claude. */
export function sourceForPlatform(platform?: string | null): TranscriptSource {
  const p = (platform ?? '').trim().toLowerCase();
  return isTranscriptSource(p) ? p : 'claude';
}

/**
 * Which host's transcript to archive.
 *
 * The MCP handshake wins whenever it resolves, because capture is a question
 * about WHICH PROCESS is hosting Veto — not about what the model believes it is.
 * A model in Codex that leaves `platform` at its default would otherwise make
 * Veto look for a Claude transcript and silently archive nothing.
 *
 * When the host is unrecognized (a client Veto has no marker for) the declared
 * platform is the only signal left, so it is used; and if that is not a
 * supported source either, capture is skipped rather than guessed.
 */
export function captureSourceFor(
  host: TranscriptSource | null,
  declaredPlatform?: string | null,
): TranscriptSource | null {
  if (host) return host;
  const p = (declaredPlatform ?? '').trim().toLowerCase();
  return isTranscriptSource(p) ? p : null;
}

export async function captureOnSave(opts: {
  projectDir?: string | null;
  vetoSessionId?: string | null;
  platform?: string | null;
}): Promise<OnSaveTranscript | null> {
  if (!isCaptureEnabled()) return null;

  const source = sourceForPlatform(opts.platform);

  // Codex/Gemini publish no session mapping of their own — find theirs on disk
  // before capture looks one up. Bounded and best-effort.
  if (source !== 'claude') {
    try {
      const { discoverSessions } = await import('./discover.js');
      discoverSessions(source);
    } catch { /* discovery is best-effort; capture will just find no mapping */ }
  }

  const cap = await captureSession({ source, projectDir: opts.projectDir, vetoSessionId: opts.vetoSessionId });
  if (!cap.ok) return null; // skipped (no mapping / missing / too_large) or error — stay silent

  const out: OnSaveTranscript = { status: cap.status, source };

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
