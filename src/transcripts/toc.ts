// Metadata table-of-contents / phase segmentation (VERSION-3 item 6, Step 9).
//
// B1 of the vectorless-retrieval pipeline: split a session into phases so the
// recall tool can hand the host AI a compact map to navigate BEFORE any text
// search. Boundaries are deterministic — a new segment begins at each real user
// message (a user prompt + the assistant's response + tool activity until the
// next prompt). Events before the first user prompt form a preamble segment.
// Computed on demand from the events table (no extra storage).

import { getTranscriptsDb } from './store.js';
import { EDIT_TOOLS, ERROR_RE, extractFiles } from './pyramid.js';

const TITLE_MAX = 80;

export type Segment = {
  index: number;
  fromSeq: number;
  toSeq: number;
  firstTs: string | null;
  lastTs: string | null;
  title: string;             // first user message preview (already masked), or a fallback
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  files: string[];
  tools: string[];
  hasError: boolean;
};

type Ev = { seq: number; kind: string; tool_name: string | null; text: string | null; ts_utc: string | null };

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t;
}

export function buildTOC(archiveId: string): Segment[] {
  const db = getTranscriptsDb();
  const rows = db.prepare(
    `SELECT seq, kind, tool_name, text, ts_utc FROM events WHERE archive_id = ? ORDER BY seq`
  ).all(archiveId) as Ev[];
  if (rows.length === 0) return [];

  const segments: Segment[] = [];
  let cur: (Segment & { _files: Set<string>; _tools: Set<string> }) | null = null;

  const open = (first: Ev, title: string) => {
    cur = {
      index: segments.length, fromSeq: first.seq, toSeq: first.seq,
      firstTs: first.ts_utc, lastTs: first.ts_utc, title,
      userMessages: 0, assistantMessages: 0, toolCalls: 0, files: [], tools: [], hasError: false,
      _files: new Set<string>(), _tools: new Set<string>(),
    };
    segments.push(cur);
  };
  const close = () => {
    if (cur) { cur.files = [...cur._files]; cur.tools = [...cur._tools]; }
  };

  for (const r of rows) {
    if (r.kind === 'user_message') {
      close();
      open(r, preview(r.text ?? '') || `segment ${segments.length + 1}`);
    } else if (!cur) {
      // Preamble: events before the first user message.
      open(r, '(session start)');
    }
    const c = cur!;
    c.toSeq = r.seq;
    if (r.ts_utc) { if (!c.firstTs || r.ts_utc < c.firstTs) c.firstTs = r.ts_utc; if (!c.lastTs || r.ts_utc > c.lastTs) c.lastTs = r.ts_utc; }
    switch (r.kind) {
      case 'user_message': c.userMessages++; break;
      case 'assistant_message': c.assistantMessages++; break;
      case 'tool_call': {
        c.toolCalls++;
        const name = r.tool_name ?? 'tool';
        c._tools.add(name);
        if (r.text && EDIT_TOOLS.has(name)) { for (const f of extractFiles(r.text)) c._files.add(f); }
        break;
      }
      case 'tool_result': if (r.text && ERROR_RE.test(r.text)) c.hasError = true; break;
      default: break;
    }
  }
  close();
  return segments;
}

/** Compact one-line-per-segment rendering for the recall tool's first response. */
export function renderTOC(segments: Segment[]): string {
  return segments.map(s => {
    const bits = [`#${s.index} [${s.fromSeq}-${s.toSeq}]`];
    if (s.hasError) bits.push('⚠err');
    if (s.files.length) bits.push(`files:${s.files.slice(0, 4).join(',')}`);
    if (s.tools.length) bits.push(`tools:${s.tools.slice(0, 4).join(',')}`);
    return `${bits.join(' ')}  ${s.title}`;
  }).join('\n');
}
