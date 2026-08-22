// The v3.0 success metric — "does deep recall actually get used?" (VERSION-3).
//
// v3.0 shipped without a confirmed success metric, so three releases later there
// was no measure of whether transcript recall is reached for at all — and v3.2
// (lesson mining) is gated on "once recall proves demand", a gate nobody could
// evaluate. This computes that measure.
//
// NOTHING NEW IS INSTRUMENTED. Every tool call is already traced into veto.db's
// tool_call_trace_log, and archives.captured_at already says when recall became
// possible, so the metric is derived from data that exists rather than from new
// telemetry. Only the SHAPE of a recall call is read (which keys the args had),
// never the query text — the metric must not become a second copy of what the
// user searched for.
//
// WHAT THIS CAN AND CANNOT ANSWER. It reads one machine's local database and
// nothing is ever uploaded, by design. So it answers "is recall being used HERE"
// — dogfooding, and whether the two-call loop completes at all. It cannot
// measure market demand; that evidence lives outside the product (downloads,
// issues, user reports) and the v3.2 gate should not be argued from this number
// alone. Any user can run it against their own data.

import { getDb } from '../memory/local.js';
import { normalizeProjectDir } from '../memory/local.js';
import { getTranscriptsDb, transcriptsAvailable } from './store.js';
import { getConfig } from '../memory/config.js';

// ─── Pre-registered thresholds ───────────────────────────────────────────────
// Fixed BEFORE the numbers are read so the gate cannot be argued backwards from
// whatever the data happens to say. They are a judgement call, not a discovery;
// change them deliberately and in the open, not to make a release pass.

/** Below this many eligible resumes the result is noise, and reports as such. */
export const MIN_ELIGIBLE_RESUMES = 30;
/** A window shorter than this cannot show a habit, only a mood. */
export const MIN_WINDOW_DAYS = 30;
/** Eligible resumes that reach for recall. */
export const ATTACH_TARGET = 0.30;
/** Recall queries that lead to opening at least one exact excerpt. */
export const EXPANSION_TARGET = 0.50;
/**
 * How long after a resume a recall query still counts as belonging to it (and
 * likewise a query → its expansion). Long enough for a real working session,
 * short enough that tomorrow's query is not credited to yesterday's resume.
 */
export const ATTRIBUTION_WINDOW_HOURS = 6;

const RESUME_TOOLS = ['veto_continue', 'veto_session_restore'];

export type MetricVerdict =
  | 'insufficient_data'      // too few eligible resumes / too short a window
  | 'pass'                   // both targets met
  | 'demand_not_shown'       // recall is available but not reached for
  | 'retrieval_not_landing'; // recall IS reached for, but nothing is worth opening

export type RecallMetric = {
  window: { from: string | null; to: string | null; days: number };
  coverage: {
    captureEnabled: boolean;
    captureEnabledAt: string | null;
    archives: number;
    events: number;
    projectsWithArchives: string[];
  };
  resumes: {
    total: number;           // all resumes ever traced
    inWindow: number;        // resumes after capture became possible
    eligible: number;        // ...and in a project that had an archive by then
    ineligible: number;      // in a project with no archive yet
    unscoped: number;        // project could not be resolved; excluded from both
  };
  attach: { attached: number; rate: number | null };
  queries: { total: number; expanded: number; rate: number | null };
  depth: { expands: number; perExpandingQuery: number | null; distinctSessionsExpanded: number };
  verdict: { code: MetricVerdict; headline: string; detail: string };
};

/** SQLite `datetime('now')` text and ISO timestamps compared on one scale (both UTC). */
function toSqlTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function hoursBetween(a: string, b: string): number {
  const ta = Date.parse(a.replace(' ', 'T') + 'Z');
  const tb = Date.parse(b.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return (tb - ta) / 3_600_000;
}

type TraceRow = { recorded_at: string; tool_name: string; args_json: string | null; project_dir: string | null };

/** Recall calls split by which phase of the two-call loop they are. */
function classifyReplay(argsJson: string | null): 'query' | 'expand' | 'legacy' {
  if (!argsJson) return 'legacy';
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    if (a.expand && typeof a.expand === 'object') return 'expand';
    if (a.query) return 'query';
  } catch { /* unparseable args are not recall */ }
  return 'legacy';   // the unrelated session_id tool-call trace mode
}

/** Which archived session an expand opened, when it named one (for depth). */
function expandTarget(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const a = JSON.parse(argsJson) as { expand?: Record<string, unknown> };
    const e = a.expand;
    if (!e) return null;
    if (typeof e.source_session_id === 'string') return e.source_session_id;
    if (typeof e.archive_id === 'string') return e.archive_id;
    if (typeof e.event_id === 'string') return `event:${e.event_id}`;
  } catch { /* ignore */ }
  return null;
}

export function recallMetric(): RecallMetric {
  const db = getDb();
  const cfg = getConfig().transcripts;

  // ── Coverage: when did recall become possible, and over how much?
  let archives: { project_dir: string | null; captured_at: string }[] = [];
  let events = 0;
  if (transcriptsAvailable()) {
    try {
      const tdb = getTranscriptsDb();
      archives = tdb.prepare('SELECT project_dir, captured_at FROM archives').all() as typeof archives;
      events = (tdb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    } catch { /* sidecar unreadable — reported as zero coverage below */ }
  }

  // Recall is only possible for a project from the moment it first has an archive.
  const firstArchiveByProject = new Map<string, string>();
  for (const a of archives) {
    if (!a.project_dir) continue;
    const p = normalizeProjectDir(a.project_dir);
    const t = toSqlTime(a.captured_at);
    const prev = firstArchiveByProject.get(p);
    if (!prev || t < prev) firstArchiveByProject.set(p, t);
  }
  const earliestArchive = [...firstArchiveByProject.values()].sort()[0] ?? null;

  // ── Traces. Resumes carry the veto session id, which resolves the project.
  const resumeRows = db.prepare(
    `SELECT t.recorded_at, t.tool_name, t.args_json, s.project_dir
       FROM tool_call_trace_log t
       LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.tool_name IN (${RESUME_TOOLS.map(() => '?').join(',')})
        AND t.result_status = 'success'
      ORDER BY t.recorded_at`
  ).all(...RESUME_TOOLS) as TraceRow[];

  const replayRows = db.prepare(
    `SELECT recorded_at, tool_name, args_json, NULL AS project_dir
       FROM tool_call_trace_log
      WHERE tool_name = 'veto_session_replay' AND result_status = 'success'
      ORDER BY recorded_at`
  ).all() as TraceRow[];

  const queries = replayRows.filter(r => classifyReplay(r.args_json) === 'query');
  const expands = replayRows.filter(r => classifyReplay(r.args_json) === 'expand');

  // ── Eligibility. A resume counts only if recall could have helped it: it
  // happened after that project's first archive existed. Resumes whose project
  // cannot be resolved are excluded from BOTH sides rather than guessed at.
  let inWindow = 0, eligible = 0, ineligible = 0, unscoped = 0;
  const eligibleTimes: string[] = [];
  for (const r of resumeRows) {
    if (!earliestArchive || r.recorded_at < earliestArchive) continue;
    inWindow++;
    if (!r.project_dir) { unscoped++; continue; }
    const first = firstArchiveByProject.get(normalizeProjectDir(r.project_dir));
    if (first && r.recorded_at >= first) { eligible++; eligibleTimes.push(r.recorded_at); }
    else ineligible++;
  }

  // ── Attach: an eligible resume followed by a recall query, before the next
  // resume and inside the attribution window.
  const resumeTimes = resumeRows.map(r => r.recorded_at);
  let attached = 0;
  for (const t of eligibleTimes) {
    const nextResume = resumeTimes.find(x => x > t) ?? null;
    const hit = queries.some(q =>
      q.recorded_at > t
      && (!nextResume || q.recorded_at < nextResume)
      && hoursBetween(t, q.recorded_at) <= ATTRIBUTION_WINDOW_HOURS);
    if (hit) attached++;
  }

  // ── Expansion: a query that led to opening at least one exact excerpt.
  const queryTimes = queries.map(q => q.recorded_at);
  let expandedQueries = 0;
  for (const t of queryTimes) {
    const nextQuery = queryTimes.find(x => x > t) ?? null;
    const hit = expands.some(e =>
      e.recorded_at > t
      && (!nextQuery || e.recorded_at < nextQuery)
      && hoursBetween(t, e.recorded_at) <= ATTRIBUTION_WINDOW_HOURS);
    if (hit) expandedQueries++;
  }

  const distinctExpanded = new Set(expands.map(e => expandTarget(e.args_json)).filter(Boolean) as string[]).size;

  const from = earliestArchive;
  const to = resumeRows.length || replayRows.length
    ? [...resumeRows, ...replayRows].map(r => r.recorded_at).sort().slice(-1)[0]
    : null;
  const days = from && to ? Math.max(0, Math.round(hoursBetween(from, to) / 24)) : 0;

  const attachRate = eligible > 0 ? attached / eligible : null;
  const expansionRate = queries.length > 0 ? expandedQueries / queries.length : null;

  // ── Verdict. Sample size is checked FIRST: a rate over three resumes is a
  // number, not evidence, and reporting it as a verdict is how a metric starts
  // lying.
  let code: MetricVerdict;
  let headline: string;
  let detail: string;
  if (eligible < MIN_ELIGIBLE_RESUMES || days < MIN_WINDOW_DAYS) {
    code = 'insufficient_data';
    headline = 'Not enough data to judge yet';
    detail = `Needs ${MIN_ELIGIBLE_RESUMES} eligible resumes over ${MIN_WINDOW_DAYS} days; have ${eligible} over ${days}.`
      + (expands.length === 0 && queries.length > 0
        ? ` Worth noting regardless: ${queries.length} recall quer${queries.length === 1 ? 'y has' : 'ies have'} run and NONE led to opening an excerpt.`
        : '');
  } else if ((attachRate ?? 0) < ATTACH_TARGET) {
    code = 'demand_not_shown';
    headline = 'Recall is available but rarely reached for';
    detail = `Attach rate ${(100 * (attachRate ?? 0)).toFixed(0)}% is below the ${(100 * ATTACH_TARGET).toFixed(0)}% target. `
      + 'v3.2 lesson mining should not be justified on "recall proves demand" from this data.';
  } else if ((expansionRate ?? 0) < EXPANSION_TARGET) {
    code = 'retrieval_not_landing';
    headline = 'Recall is wanted, but results are not worth opening';
    detail = `Attach rate ${(100 * (attachRate ?? 0)).toFixed(0)}% meets the target, but only `
      + `${(100 * (expansionRate ?? 0)).toFixed(0)}% of queries led to an expansion (target ${(100 * EXPANSION_TARGET).toFixed(0)}%). `
      + 'Fix retrieval quality before building lesson mining on top of it.';
  } else {
    code = 'pass';
    headline = 'Deep recall is used and lands';
    detail = `Attach ${(100 * (attachRate ?? 0)).toFixed(0)}% and expansion ${(100 * (expansionRate ?? 0)).toFixed(0)}% both meet target.`;
  }

  return {
    window: { from, to, days },
    coverage: {
      captureEnabled: cfg.enabled,
      captureEnabledAt: cfg.consent_at,
      archives: archives.length,
      events,
      projectsWithArchives: [...firstArchiveByProject.keys()],
    },
    resumes: { total: resumeRows.length, inWindow, eligible, ineligible, unscoped },
    attach: { attached, rate: attachRate },
    queries: { total: queries.length, expanded: expandedQueries, rate: expansionRate },
    depth: {
      expands: expands.length,
      perExpandingQuery: expandedQueries > 0 ? expands.length / expandedQueries : null,
      distinctSessionsExpanded: distinctExpanded,
    },
    verdict: { code, headline, detail },
  };
}

const pct = (r: number | null) => (r === null ? '—' : `${(100 * r).toFixed(0)}%`);

/** Human-readable report for `veto transcripts metric`. */
export function renderRecallMetric(m: RecallMetric): string {
  const lines: string[] = [];
  lines.push('  Deep-recall adoption — the v3.0 success metric');
  lines.push('  ─────────────────────────────────────────────────────');
  if (!m.coverage.captureEnabled) {
    lines.push('  Transcript capture is OFF, so recall was never possible here.');
    lines.push('  Nothing to measure until: veto transcripts enable');
    return lines.join('\n');
  }
  lines.push(`  Window:      ${m.window.from ?? '(no archives yet)'} → ${m.window.to ?? '—'}  (${m.window.days}d)`);
  lines.push(`  Coverage:    ${m.coverage.archives} archive(s), ${m.coverage.events} events, `
    + `${m.coverage.projectsWithArchives.length} project(s)`);
  lines.push('');
  lines.push(`  Resumes:     ${m.resumes.eligible} eligible `
    + `(of ${m.resumes.inWindow} since recall became possible; `
    + `${m.resumes.ineligible} in projects with no archive, ${m.resumes.unscoped} unattributable)`);
  lines.push(`  Attach rate: ${pct(m.attach.rate)}  ${m.attach.attached}/${m.resumes.eligible} eligible resumes reached for recall`
    + `   ${c(m.attach.rate, ATTACH_TARGET)} target ${pct(ATTACH_TARGET)}`);
  lines.push(`  Expansion:   ${pct(m.queries.rate)}  ${m.queries.expanded}/${m.queries.total} queries opened an exact excerpt`
    + `   ${c(m.queries.rate, EXPANSION_TARGET)} target ${pct(EXPANSION_TARGET)}`);
  lines.push(`  Depth:       ${m.depth.expands} expansion(s), `
    + `${m.depth.perExpandingQuery === null ? '—' : m.depth.perExpandingQuery.toFixed(1)} per expanding query, `
    + `${m.depth.distinctSessionsExpanded} distinct session(s) opened`);
  lines.push('');
  lines.push(`  Verdict:     ${m.verdict.headline}`);
  lines.push(`               ${m.verdict.detail}`);
  lines.push('');
  lines.push('  Measures THIS machine only — nothing is uploaded. It shows whether recall');
  lines.push('  is used here and whether the query→expand loop completes; it is not evidence');
  lines.push('  of demand across users.');
  return lines.join('\n');
}

function c(rate: number | null, target: number): string {
  if (rate === null) return ' ';
  return rate >= target ? '✓' : '✗';
}
