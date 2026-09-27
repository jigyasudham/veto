// Shared plumbing for `veto api` commands: the envelope, the database-path
// check, the capture label, and keeping the user's home folder out of messages.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { API_CONTRACT, type ApiState, type Envelope } from './contract.js';

export type ApiContext = { version: string; command: string; now?: () => Date };

export function envelope(ctx: ApiContext, state: ApiState, extra: { message?: string; next_action?: string; data?: unknown } = {}): Envelope {
  return {
    contract: API_CONTRACT,
    command: ctx.command,
    backend_version: ctx.version,
    generated_at: (ctx.now?.() ?? new Date()).toISOString(),
    state,
    ...extra,
  };
}

/** The user's home folder as `~`, so a message or detail never carries it verbatim. */
export function maskHome(text: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (!home) return text;
  // Either slash direction matches: Windows paths are written both ways (C:\Users\x, C:/Users/x).
  const pattern = home.split(/[\\/]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  return text.replace(new RegExp(pattern, platform === 'win32' ? 'gi' : 'g'), '~');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * Refuse, rather than read a different database than the caller means. An
 * extension with a custom database path would otherwise be shown data from the
 * default one as if it were its own.
 */
export async function dbMismatch(ctx: ApiContext, requested: string | undefined): Promise<Envelope | null> {
  if (!requested) return null;
  const { getDbPath } = await import('../memory/local.js');
  const actual = getDbPath();
  if (actual === ':memory:' || samePath(requested, actual)) return null;
  return envelope(ctx, 'db_mismatch', {
    message: 'This Veto uses a different database from the one named in the request, so it did not answer from either.',
    next_action: 'Point the extension at the database Veto uses, or leave its database path at the default.',
  });
}

export type CaptureLabel = 'enabled' | 'disabled' | 'reconsent_required';

export async function captureLabel(): Promise<CaptureLabel> {
  const { captureStatus } = await import('../transcripts/config.js');
  const s = captureStatus();
  return s.effective ? 'enabled' : s.needsReconsent ? 'reconsent_required' : 'disabled';
}

/** A missing table or column means an older or newer schema: the section is unavailable, not broken. */
export function sectionError(err: unknown): { state: 'unavailable' | 'error'; message: string } {
  const message = maskHome(err instanceof Error ? err.message : String(err));
  return /no such (table|column)/i.test(message)
    ? { state: 'unavailable', message: `not in this database's schema (${message})` }
    : { state: 'error', message };
}
