// `veto api <command>` — the entry point an editor extension calls.
//
//   veto api version
//   veto api snapshot        { project, db? }
//   veto api recall search   { project, query, limit?, source?, db? }
//   veto api recall expand   { project, event_id } | { project, archive_id, segment_index }
//   veto api diagnostics     { checks?: ["host_cli", "probe"], db? }
//
// A program sends the request as JSON on stdin with --stdin, and runs
// `node <cli_path> api …` with an argument array and no shell: on Windows a
// `.cmd` shim can only be started through a shell, which would turn a search
// query into a command line (council 7bb1073f). Flags (--project=…, --query=…)
// are for a person at a terminal. The answer is always ONE JSON envelope on
// stdout, exit code 0; the envelope's `state` says what happened.

import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  API_CONTRACT, TRANSCRIPT_SOURCES_V1, diagnosticsRequestSchema, recallExpandRequestSchema,
  recallSearchRequestSchema, snapshotRequestSchema, type Envelope,
} from './contract.js';
import { envelope, maskHome, type ApiContext } from './common.js';

export const API_COMMANDS = ['version', 'snapshot', 'recall search', 'recall expand', 'diagnostics'] as const;

const MAX_STDIN_BYTES = 64 * 1024;

const FLAG_FIELDS: Record<string, { field: string; type: 'string' | 'number' | 'list' }> = {
  project: { field: 'project', type: 'string' },
  query: { field: 'query', type: 'string' },
  limit: { field: 'limit', type: 'number' },
  source: { field: 'source', type: 'string' },
  event: { field: 'event_id', type: 'string' },
  archive: { field: 'archive_id', type: 'string' },
  segment: { field: 'segment_index', type: 'number' },
  checks: { field: 'checks', type: 'list' },
  db: { field: 'db', type: 'string' },
};

export type ParsedApiArgs = { command: string | null; stdin: boolean; flags: Record<string, unknown>; error?: string };

export function parseApiArgs(argv: string[]): ParsedApiArgs {
  const words: string[] = [];
  const flags: Record<string, unknown> = {};
  let stdin = false;
  let error: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') { stdin = true; continue; }
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    const raw = eq === -1 ? argv[++i] : a.slice(eq + 1);
    const spec = FLAG_FIELDS[name];
    if (!spec || raw === undefined) { error = `Unknown or incomplete option ${a}`; continue; }
    flags[spec.field] = spec.type === 'number' ? Number(raw) : spec.type === 'list' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw;
  }
  const command = words.length === 0 ? null : words[0] === 'recall' ? `recall ${words[1] ?? ''}`.trim() : words[0];
  return { command, stdin, flags, error };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`request is larger than ${MAX_STDIN_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function invalid(ctx: ApiContext, message: string): Envelope {
  return envelope(ctx, 'invalid_request', { message, next_action: 'See the request schema in contracts/api-v1 of the @jigyasudham/veto package.' });
}

function validate<S extends z.ZodTypeAny>(ctx: ApiContext, schema: S, input: unknown): { ok: true; value: z.infer<S> } | { ok: false; env: Envelope } {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
  return { ok: false, env: invalid(ctx, issues) };
}

/** Run one API command and return its envelope. Never throws. */
export async function handleApi(argv: string[], options: { version: string; stdinText?: () => Promise<string> }): Promise<Envelope> {
  const parsed = parseApiArgs(argv);
  const ctx: ApiContext = { version: options.version, command: parsed.command ?? '' };
  try {
    if (parsed.error) return invalid(ctx, parsed.error);
    if (!parsed.command || !(API_COMMANDS as readonly string[]).includes(parsed.command)) {
      return envelope(ctx, 'unknown_command', {
        message: `Unknown command "${parsed.command ?? ''}". Commands: ${API_COMMANDS.join(', ')}.`,
        next_action: 'veto api version',
      });
    }

    let request: unknown = parsed.flags;
    if (parsed.stdin) {
      const text = await (options.stdinText ?? readStdin)();
      try { request = text.trim() ? JSON.parse(text) : {}; } catch { return invalid(ctx, 'stdin is not valid JSON'); }
      if (Object.keys(parsed.flags).length) return invalid(ctx, 'send the request on stdin or as flags, not both');
    }

    switch (parsed.command) {
      case 'version': {
        const { sqliteAvailable } = await import('../memory/local.js');
        return envelope(ctx, 'ok', {
          data: {
            contract: API_CONTRACT,
            backend_version: options.version,
            commands: [...API_COMMANDS],
            request_via: ['stdin', 'flags'],
            transcript_sources: [...TRANSCRIPT_SOURCES_V1],
            node_version: process.version,
            sqlite_ok: sqliteAvailable(),
            cli_path: fileURLToPath(new URL('../cli.js', import.meta.url)),
          },
        });
      }
      case 'snapshot': {
        const v = validate(ctx, snapshotRequestSchema, request);
        if (!v.ok) return v.env;
        const { apiSnapshot } = await import('./snapshot.js');
        return await apiSnapshot(ctx, v.value);
      }
      case 'recall search': {
        const v = validate(ctx, recallSearchRequestSchema, request);
        if (!v.ok) return v.env;
        const { apiRecallSearch } = await import('./recall.js');
        return await apiRecallSearch(ctx, v.value);
      }
      case 'recall expand': {
        const v = validate(ctx, recallExpandRequestSchema, request);
        if (!v.ok) return v.env;
        const { apiRecallExpand } = await import('./recall.js');
        return await apiRecallExpand(ctx, v.value);
      }
      default: {
        const v = validate(ctx, diagnosticsRequestSchema, request);
        if (!v.ok) return v.env;
        const { apiDiagnostics } = await import('./diagnostics.js');
        return await apiDiagnostics(ctx, v.value);
      }
    }
  } catch (err) {
    return envelope(ctx, 'error', { message: maskHome(err instanceof Error ? err.message : String(err)) });
  }
}

/** The CLI wrapper: print the envelope and flush it before the process exits. */
export async function runApiCommand(argv: string[], version: string): Promise<number> {
  // Structured logs go to stderr; the envelope already says what went wrong.
  process.env.VETO_LOG_LEVEL ??= 'silent';
  const env = await handleApi(argv, { version });
  await new Promise<void>(resolve => process.stdout.write(JSON.stringify(env) + '\n', () => resolve()));
  return 0;
}
