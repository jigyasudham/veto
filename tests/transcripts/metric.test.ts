import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const STAMP = `${Date.now()}-${process.pid}`;
const ROOT = join(tmpdir(), `veto-metric-${STAMP}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TEST_DB = join(ROOT, 'veto.db');
process.env.VETO_TRANSCRIPTS_DB = join(ROOT, 'transcripts.db');
process.env.VETO_CONFIG_PATH = join(ROOT, 'config.json');

const { getDb } = await import('../../src/memory/local.js');
const { getTranscriptsDb, resetTranscriptsDb } = await import('../../src/transcripts/store.js');
const {
  recallMetric, renderRecallMetric,
  MIN_ELIGIBLE_RESUMES, MIN_WINDOW_DAYS, ATTACH_TARGET, EXPANSION_TARGET, ATTRIBUTION_WINDOW_HOURS,
} = await import('../../src/transcripts/metric.js');

const PROJ = 'd:\\metric proj';
const OTHER = 'd:\\no archive here';

function setCapture(enabled: boolean): void {
  writeFileSync(process.env.VETO_CONFIG_PATH!, JSON.stringify({
    transcripts: { enabled, dir: '', retention_days: 180, consent_version: 1, consent_at: '2026-01-01T00:00:00.000Z' },
  }));
}

/** `datetime('now')` text, the format the trace log stores. */
function t(day: number, hour = 12, min = 0): string {
  const d = new Date(Date.UTC(2026, 0, day, hour, min, 0));
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

let seq = 0;
function trace(tool: string, at: string, opts: { session?: string; args?: unknown; status?: string } = {}): void {
  getDb().prepare(
    `INSERT INTO tool_call_trace_log (id, session_id, tool_name, args_json, result_status, duration_ms, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`tr-${seq++}`, opts.session ?? null, tool, opts.args ? JSON.stringify(opts.args) : null,
    opts.status ?? 'success', 5, at);
}

function session(id: string, projectDir: string): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO sessions (id, started_at, platform, project_dir, summary, created_at)
     VALUES (?, ?, 'claude', ?, 's', ?)`
  ).run(id, t(1), projectDir, t(1));
}

function archive(projectDir: string, capturedAt: string, id = `a-${seq++}`): void {
  getTranscriptsDb().prepare(
    `INSERT INTO archives (id, source, source_session_id, project_dir, archive_path, content_sha256,
       source_bytes, archive_bytes, parser_version, indexed_through_seq, captured_at, updated_at)
     VALUES (?, 'claude', ?, ?, '/x.gz', 'sha', 1, 1, 2, 1, ?, ?)`
  ).run(id, `s-${id}`, projectDir, capturedAt, capturedAt);
}

function resume(at: string, sessionId: string): void {
  trace('veto_continue', at, { session: sessionId, args: { session_id: sessionId } });
}
const query = (at: string) => trace('veto_session_replay', at, { args: { query: 'x', project_dir: PROJ } });
const expand = (at: string, target = 'sess-1') =>
  trace('veto_session_replay', at, { args: { expand: { source_session_id: target, from_seq: 1, to_seq: 2 } } });

function reset(): void {
  const db = getDb();
  db.exec('DELETE FROM tool_call_trace_log');
  db.exec('DELETE FROM sessions');
  getTranscriptsDb().exec('DELETE FROM archives');
  seq = 0;
  setCapture(true);
}

beforeEach(() => reset());

afterAll(() => {
  resetTranscriptsDb();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ['VETO_TEST_DB', 'VETO_TRANSCRIPTS_DB', 'VETO_CONFIG_PATH']) delete process.env[k];
});

/** Enough eligible resumes, spread over enough days, to clear the sample gate. */
function seedEligible(count: number, attachEvery: number | null): void {
  archive(PROJ, '2026-01-01T00:00:00.000Z');
  session('S', PROJ);
  for (let i = 0; i < count; i++) {
    const day = 2 + i;                       // one per day: clears MIN_WINDOW_DAYS
    resume(t(day, 9), 'S');
    if (attachEvery && i % attachEvery === 0) query(t(day, 10));
  }
}

describe('eligibility — only resumes recall could have helped', () => {
  it('excludes resumes from before the project had any archive', () => {
    archive(PROJ, '2026-01-10T00:00:00.000Z');
    session('S', PROJ);
    resume(t(5), 'S');    // before the archive existed
    resume(t(15), 'S');   // after
    const m = recallMetric();
    expect(m.resumes.eligible).toBe(1);
    expect(m.resumes.inWindow).toBe(1);
  });

  it('excludes resumes in a project that has no archive at all', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('A', PROJ);
    session('B', OTHER);
    resume(t(5), 'A');
    resume(t(6), 'B');
    const m = recallMetric();
    expect(m.resumes.eligible).toBe(1);
    expect(m.resumes.ineligible).toBe(1);
  });

  // Guessing a project would silently move the denominator, so an unresolvable
  // resume is counted in neither direction and reported separately.
  it('counts a resume with no resolvable project as unattributable, not as either', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    trace('veto_continue', t(5));   // no session id → no project
    const m = recallMetric();
    expect(m.resumes.unscoped).toBe(1);
    expect(m.resumes.eligible).toBe(0);
    expect(m.resumes.ineligible).toBe(0);
  });

  it('ignores failed resume calls', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('S', PROJ);
    trace('veto_continue', t(5), { session: 'S', args: { session_id: 'S' }, status: 'error' });
    expect(recallMetric().resumes.eligible).toBe(0);
  });
});

describe('attach rate — did an eligible resume reach for recall', () => {
  it('credits a query inside the attribution window', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('S', PROJ);
    resume(t(5, 9), 'S');
    query(t(5, 10));
    const m = recallMetric();
    expect(m.attach.attached).toBe(1);
    expect(m.attach.rate).toBe(1);
  });

  it('does not credit a query beyond the attribution window', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('S', PROJ);
    resume(t(5, 1), 'S');
    query(t(5, 1 + ATTRIBUTION_WINDOW_HOURS + 1));
    expect(recallMetric().attach.attached).toBe(0);
  });

  it('does not credit yesterday\'s resume with today\'s query', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('S', PROJ);
    resume(t(5, 9), 'S');
    resume(t(6, 9), 'S');
    query(t(6, 10));
    const m = recallMetric();
    expect(m.attach.attached).toBe(1);      // the second resume only
    expect(m.resumes.eligible).toBe(2);
  });
});

describe('expansion rate — did the query lead to opening an excerpt', () => {
  it('counts a query that led to an expansion', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    query(t(5, 9));
    expand(t(5, 10));
    const m = recallMetric();
    expect(m.queries.total).toBe(1);
    expect(m.queries.expanded).toBe(1);
    expect(m.queries.rate).toBe(1);
    expect(m.depth.expands).toBe(1);
  });

  it('records a query with no expansion as a miss', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    query(t(5, 9));
    const m = recallMetric();
    expect(m.queries.expanded).toBe(0);
    expect(m.queries.rate).toBe(0);
  });

  it('attributes each expansion to the query it followed', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    query(t(5, 9));
    query(t(5, 11));
    expand(t(5, 12));       // belongs to the SECOND query
    const m = recallMetric();
    expect(m.queries.total).toBe(2);
    expect(m.queries.expanded).toBe(1);
  });

  it('measures depth across distinct archived sessions', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    query(t(5, 9));
    expand(t(5, 10), 'sess-a');
    expand(t(5, 11), 'sess-b');
    const m = recallMetric();
    expect(m.depth.expands).toBe(2);
    expect(m.depth.distinctSessionsExpanded).toBe(2);
    expect(m.depth.perExpandingQuery).toBe(2);
  });

  // veto_session_replay is overloaded: {session_id} is an unrelated tool-call
  // trace, and counting it as recall would inflate the metric with traffic that
  // never touched a transcript.
  it('does not count the legacy session_id replay mode as recall', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    trace('veto_session_replay', t(5, 9), { args: { session_id: 'some-veto-session' } });
    const m = recallMetric();
    expect(m.queries.total).toBe(0);
    expect(m.depth.expands).toBe(0);
  });
});

describe('verdict', () => {
  it('refuses to judge on a small sample, however good the rates look', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    session('S', PROJ);
    resume(t(5, 9), 'S');
    query(t(5, 10));
    expand(t(5, 11));
    const m = recallMetric();
    expect(m.attach.rate).toBe(1);          // 100% — and still not evidence
    expect(m.queries.rate).toBe(1);
    expect(m.verdict.code).toBe('insufficient_data');
  });

  it('surfaces a zero expansion rate even while withholding a verdict', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    query(t(5, 9));
    query(t(6, 9));
    const m = recallMetric();
    expect(m.verdict.code).toBe('insufficient_data');
    expect(m.verdict.detail).toContain('NONE led to opening an excerpt');
  });

  it('reports demand_not_shown when recall is available but unused', () => {
    seedEligible(MIN_ELIGIBLE_RESUMES + 2, null);   // no queries at all
    const m = recallMetric();
    expect(m.resumes.eligible).toBeGreaterThanOrEqual(MIN_ELIGIBLE_RESUMES);
    expect(m.window.days).toBeGreaterThanOrEqual(MIN_WINDOW_DAYS);
    expect(m.attach.rate).toBe(0);
    expect(m.verdict.code).toBe('demand_not_shown');
  });

  it('reports retrieval_not_landing when recall is used but nothing is opened', () => {
    seedEligible(MIN_ELIGIBLE_RESUMES + 2, 1);      // every resume queries, none expands
    const m = recallMetric();
    expect(m.attach.rate).toBeGreaterThanOrEqual(ATTACH_TARGET);
    expect(m.queries.rate).toBe(0);
    expect(m.verdict.code).toBe('retrieval_not_landing');
  });

  it('passes when both targets are met', () => {
    seedEligible(MIN_ELIGIBLE_RESUMES + 2, 1);
    // Expand after every query, inside its window.
    for (let i = 0; i < MIN_ELIGIBLE_RESUMES + 2; i++) expand(t(2 + i, 11));
    const m = recallMetric();
    expect(m.attach.rate).toBeGreaterThanOrEqual(ATTACH_TARGET);
    expect(m.queries.rate).toBeGreaterThanOrEqual(EXPANSION_TARGET);
    expect(m.verdict.code).toBe('pass');
  });
});

describe('reporting', () => {
  it('says there is nothing to measure when capture is off', () => {
    setCapture(false);
    const out = renderRecallMetric(recallMetric());
    expect(out).toContain('capture is OFF');
    expect(out).toContain('veto transcripts enable');
  });

  it('always states that the measurement is local-only', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    const out = renderRecallMetric(recallMetric());
    expect(out).toContain('THIS machine only');
    expect(out).toContain('not evidence');
  });

  // The metric must not become a second store of what the user searched for.
  it('never echoes the text of a recall query', () => {
    archive(PROJ, '2026-01-01T00:00:00.000Z');
    trace('veto_session_replay', t(5, 9), { args: { query: 'my-secret-search-phrase', project_dir: PROJ } });
    const m = recallMetric();
    const dumped = JSON.stringify(m) + renderRecallMetric(m);
    expect(dumped).not.toContain('my-secret-search-phrase');
  });
});
