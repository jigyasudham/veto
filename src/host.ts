// Which AI CLI is actually hosting this Veto server?
//
// Until now Veto only knew this if the model told it, via the `platform` arg on
// veto_session_save. That is a self-report: it defaults to "claude" when
// omitted, and nothing stops a model in Codex from leaving it at the default.
// For most uses that is a cosmetic error, but transcript capture picks WHICH
// HOST'S TRANSCRIPT FILE to archive from it, so a wrong platform silently
// captures nothing (or, worse, the wrong CLI's session).
//
// MCP already carries the answer. Every client sends `clientInfo` in the
// `initialize` handshake, and the SDK exposes it as `server.getClientVersion()`.
// That is ground truth about the process Veto is running inside, so it does not
// depend on the model reporting anything.
//
// MATCHING IS DELIBERATELY LOOSE. These strings belong to other projects and can
// change without notice — the same "version lottery" that produced the fts5,
// SQLITE_RANGE and SDK-minor bugs. So this matches a marker substring rather
// than an exact table, an unrecognized host resolves to null (callers fall back
// to the declared platform) instead of being forced into a guess, and the raw
// string is always kept so an unknown host is diagnosable rather than invisible.

export type HostPlatform = 'claude' | 'codex' | 'gemini';

export type HostClient = { name: string; version?: string; title?: string };

/**
 * Marker → platform. Substrings, matched case-insensitively against the client's
 * reported name (then title). Observed forms include "claude-code", "claude-ai",
 * "codex", "codex-cli", "gemini-cli"; the marker form covers variants of each
 * without pinning an exact string that upstream may rename.
 */
const MARKERS: Array<[string, HostPlatform]> = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['gemini', 'gemini'],
];

let observed: HostClient | null = null;

/** Record the client identity from the MCP initialize handshake. Never throws. */
export function recordHostClient(impl: unknown): void {
  try {
    if (!impl || typeof impl !== 'object') return;
    const i = impl as Record<string, unknown>;
    if (typeof i.name !== 'string' || !i.name.trim()) return;
    observed = {
      name: i.name,
      version: typeof i.version === 'string' ? i.version : undefined,
      title: typeof i.title === 'string' ? i.title : undefined,
    };
  } catch { /* identity is best-effort; never break a connection over it */ }
}

/** The raw reported client identity, for diagnostics. Null before initialize. */
export function hostClient(): HostClient | null {
  return observed;
}

/** Classify a client name. Exported for testing and for `veto doctor`-style output. */
export function classifyHost(name: string | null | undefined): HostPlatform | null {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const [marker, platform] of MARKERS) if (n.includes(marker)) return platform;
  return null;
}

/**
 * The host CLI, or null when it cannot be determined (no handshake yet, or a
 * client Veto does not recognize). Pass the MCP server to read the handshake
 * lazily — the value is cached, since it cannot change within a connection.
 */
export function detectHostPlatform(server?: { getClientVersion?: () => unknown }): HostPlatform | null {
  if (!observed && server && typeof server.getClientVersion === 'function') {
    try { recordHostClient(server.getClientVersion()); } catch { /* ignore */ }
  }
  return classifyHost(observed?.name) ?? classifyHost(observed?.title);
}

/** Test seam — resets the cached identity. */
export function resetHostClient(): void {
  observed = null;
}
