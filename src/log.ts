// Structured logger for the Veto MCP server.
//
// IMPORTANT: stdout is reserved for the MCP stdio protocol — this logger writes
// ONLY to stderr. Output is one JSON object per line (set VETO_LOG=text for plain
// lines). Verbosity is controlled by VETO_LOG_LEVEL: silent | error | warn | info
// | debug (default "warn"), so normal runs stay quiet but previously-silent
// failures become visible to a maintainer.

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.VETO_LOG_LEVEL ?? 'warn').toLowerCase();
  if (env === 'silent' || env === 'off' || env === 'none') return Infinity;
  return ORDER[env as Level] ?? ORDER.warn;
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = process.env.VETO_LOG === 'text'
    ? `[veto:${level}] ${msg}${ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : ''}`
    : JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(ctx ?? {}) });
  process.stderr.write(line + '\n');
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};

/** Normalizes any thrown value to a string message. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
