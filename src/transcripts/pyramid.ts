// Memory pyramid L1 (facts) + L2 (spine) (VERSION-3 item 6, Step 8).
//
// Both are DERIVED from the already-masked events table — no new storage. L3 (the
// abstract summary) is what veto_session_save already stores.
//   • L1 facts: deterministic aggregates — files touched, commands, tool usage,
//     error count, message counts, timespan. Cheap, no LLM. Injected on resume.
//   • L2 spine: user messages verbatim + assistant conclusions, tool chatter
//     stripped. The searchable conversation backbone (the portable index indexes it in Step 10).

import { getTranscriptsDb } from './store.js';

// Shared deterministic extractors (reused by the TOC in Step 9).
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const FILE_RE = /"(?:file_path|filePath|notebook_path|file|path)"\s*:\s*"([^"]+)"/;
export const COMMAND_RE = /"command"\s*:\s*"([^"]+)"/;
export const ERROR_RE = /\b(error|errno|failed|failure|exception|traceback|not found|cannot|denied|refused|non-zero|exit code [1-9])\b/i;

export type SpineEntry = { seq: number; role: string; kind: string; ts: string | null; text: string };

export type SessionFacts = {
  archiveId: string;
  firstTs: string | null;
  lastTs: string | null;
  counts: { user: number; assistant: number; tool_calls: number; tool_results: number; reasoning: number; events: number };
  tools: { name: string; count: number }[];
  files: string[];
  commands: string[];
  errorCount: number;
};

/** L2 — the conversation spine (user + assistant text, in order). */
export function buildSpine(archiveId: string): SpineEntry[] {
  const db = getTranscriptsDb();
  const rows = db.prepare(
    `SELECT seq, role, kind, ts_utc, text FROM events
     WHERE archive_id = ? AND kind IN ('user_message','assistant_message')
     ORDER BY seq`
  ).all(archiveId) as { seq: number; role: string | null; kind: string; ts_utc: string | null; text: string | null }[];
  return rows.map(r => ({
    seq: r.seq,
    role: r.role ?? (r.kind === 'user_message' ? 'user' : 'assistant'),
    kind: r.kind,
    ts: r.ts_utc,
    text: r.text ?? '',
  }));
}

/** L1 — deterministic facts about the session. */
export function buildFacts(archiveId: string): SessionFacts {
  const db = getTranscriptsDb();
  const rows = db.prepare(
    `SELECT kind, tool_name, text, ts_utc FROM events WHERE archive_id = ? ORDER BY seq`
  ).all(archiveId) as { kind: string; tool_name: string | null; text: string | null; ts_utc: string | null }[];

  const counts = { user: 0, assistant: 0, tool_calls: 0, tool_results: 0, reasoning: 0, events: rows.length };
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  const commands: string[] = [];
  let errorCount = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const r of rows) {
    if (r.ts_utc) {
      if (!firstTs || r.ts_utc < firstTs) firstTs = r.ts_utc;
      if (!lastTs || r.ts_utc > lastTs) lastTs = r.ts_utc;
    }
    switch (r.kind) {
      case 'user_message': counts.user++; break;
      case 'assistant_message': counts.assistant++; break;
      case 'reasoning': counts.reasoning++; break;
      case 'tool_result':
        counts.tool_results++;
        if (r.text && ERROR_RE.test(r.text)) errorCount++;
        break;
      case 'tool_call': {
        counts.tool_calls++;
        const name = r.tool_name ?? 'tool';
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        if (r.text) {
          if (EDIT_TOOLS.has(name)) {
            const m = r.text.match(FILE_RE);
            if (m) files.add(m[1]);
          } else if (name === 'Bash') {
            const m = r.text.match(COMMAND_RE);
            if (m) commands.push(m[1].slice(0, 200));
          }
        }
        break;
      }
      default: break;
    }
  }

  const tools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    archiveId,
    firstTs,
    lastTs,
    counts,
    tools,
    files: [...files],
    commands: [...new Set(commands)],
    errorCount,
  };
}

/** Compact human/AI-readable rendering of L1 for resume injection. */
export function renderFacts(f: SessionFacts): string {
  const lines: string[] = [];
  lines.push(`events=${f.counts.events} (user ${f.counts.user} · assistant ${f.counts.assistant} · tools ${f.counts.tool_calls})`);
  if (f.firstTs) lines.push(`span=${f.firstTs} → ${f.lastTs}`);
  if (f.tools.length) lines.push(`tools: ${f.tools.slice(0, 6).map(t => `${t.name}×${t.count}`).join(', ')}`);
  if (f.files.length) lines.push(`files: ${f.files.slice(0, 20).join(', ')}`);
  if (f.commands.length) lines.push(`commands: ${f.commands.slice(0, 10).join(' | ')}`);
  if (f.errorCount) lines.push(`errors observed: ${f.errorCount}`);
  return lines.join('\n');
}
