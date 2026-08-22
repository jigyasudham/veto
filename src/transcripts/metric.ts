// The v3.0 success metric — "does deep recall actually get used?" (VERSION-3).
//
// v3.0 shipped without a confirmed success metric, so three releases later there
// was no measure of whether transcript recall is reached for at all. This
// computes that measure.
//
// IT IS A HEALTH CHECK, NOT THE v3.2 GATE. v3.2 (lesson mining) was written as
// gated on "once recall proves demand", and it is tempting to point this number
// at that gate. Do not: it reads ONE local database, and no threshold on a
// single user — who is also the person who built the feature — can become market
// evidence. Council 06b7b55c (YELLOW, 2026-08-22) was explicit that binding v3.2
// to this number would leave v3.2 blocked on something that can never be
// representative. Demand evidence lives outside the product.
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
/**
 * Ceiling on queries the AI had to REFORMULATE.
 *
 * This deliberately replaced an "expansion rate >= 50%" target, which was
 * self-defeating: it assumed opening an excerpt is the desired outcome, so
 * improving phase 1 until its snippets answer the question outright would have
 * DRIVEN THE NUMBER DOWN and scored the improvement as a failure. Expansion is
 * still reported, but it is not a target.
 *
 * Reformulation is gated instead because it is the one unambiguous signal in the
 * data: a query followed by another query means phase 1 did not serve the first
 * one. A query followed by nothing cannot be read — satisfied and gave-up look
 * identical from here — so it is reported as `silent` and never scored.
 */
export const REFORMULATION_CEILING = 0.40;
/**
 * How long after a resume a recall query still counts as belonging to it (and
 * likewise a query → its expansion). Long enough for a real working session,
 * short enough that tomorrow's query is not credited to yesterday's resume.
 */
export const ATTRIBUTION_WINDOW_HOURS = 6;

const RESUME_TOOLS = ['veto_continue', 'veto_session_restore'];

export type MetricVerdict =
  | 'insufficient_data'      // too few eligible resumes / too short a window
  | 'healthy'                // reached for, and phase 1 serves the query
  | 'not_reached_for'        // recall is available but rarely used
  | 'retrieval_not_landing'; // recall IS used, but queries keep being reformulated

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
  /**
   * Every query lands in exactly one bucket. `silent` is deliberately NOT scored:
   * a query followed by nothing is indistinguishable between "phase 1 answered
   * it" and "the AI gave up", and pretending otherwise would invent a number.
   */
  queries: {
    total: number;
    expanded: number;
    reformulated: number;
    silent: number;
    expansionRate: number | null;
    reformulationRate: number | null;
  };
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

  // ── What became of each query. Exactly one bucket each:
  //   expanded     — led to opening an exact excerpt
  //   reformulated — followed by ANOTHER query in the window: phase 1 failed it
  //   silent       — neither; unreadable, so never scored (see REFORMULATION_CEILING)
  const queryTimes = queries.map(q => q.recorded_at);
  let expandedQueries = 0, reformulated = 0;
  for (const t of queryTimes) {
    const nextQuery = queryTimes.find(x => x > t) ?? null;
    const expandedHere = expands.some(e =>
      e.recorded_at > t
      && (!nextQuery || e.recorded_at < nextQuery)
      && hoursBetween(t, e.recorded_at) <= ATTRIBUTION_WINDOW_HOURS);
    if (expandedHere) { expandedQueries++; continue; }
    if (nextQuery && hoursBetween(t, nextQuery) <= ATTRIBUTION_WINDOW_HOURS) reformulated++;
  }
  const silent = queries.length - expandedQueries - reformulated;

  const distinctExpanded = new Set(expands.map(e => expandTarget(e.args_json)).filter(Boolean) as string[]).size;

  const from = earliestArchive;
  const to = resumeRows.length || replayRows.length
    ? [...resumeRows, ...replayRows].map(r => r.recorded_at).sort().slice(-1)[0]
    : null;
  const days = from && to ? Math.max(0, Math.round(hoursBetween(from, to) / 24)) : 0;

  const attachRate = eligible > 0 ? attached / eligible : null;
  const expansionRate = queries.length > 0 ? expandedQueries / queries.length : null;
  const reformulationRate = queries.length > 0 ? reformulated / queries.length : null;

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
        ? ` Observation, not a verdict: ${queries.length} recall quer${queries.length === 1 ? 'y has' : 'ies have'} run and none opened an excerpt.`
          + ` That is only a defect if phase 1 was not already enough — which this data cannot tell you.`
        : '');
  } else if ((attachRate ?? 0) < ATTACH_TARGET) {
    code = 'not_reached_for';
    headline = 'Recall is available but rarely reached for';
    detail = `Attach rate ${(100 * (attachRate ?? 0)).toFixed(0)}% is below the ${(100 * ATTACH_TARGET).toFixed(0)}% target.`;
  } else if ((reformulationRate ?? 0) > REFORMULATION_CEILING) {
    code = 'retrieval_not_landing';
    headline = 'Recall is used, but queries keep having to be re-asked';
    detail = `Attach rate ${(100 * (attachRate ?? 0)).toFixed(0)}% meets the target, but `
      + `${(100 * (reformulationRate ?? 0)).toFixed(0)}% of queries were reformulated `
      + `(ceiling ${(100 * REFORMULATION_CEILING).toFixed(0)}%) — phase 1 is not serving them.`;
  } else {
    code = 'healthy';
    headline = 'Deep recall is reached for, and phase 1 serves the query';
    detail = `Attach ${(100 * (attachRate ?? 0)).toFixed(0)}% and reformulation `
      + `${(100 * (reformulationRate ?? 0)).toFixed(0)}% are both within target.`;
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
    queries: {
      total: queries.length, expanded: expandedQueries, reformulated, silent,
      expansionRate, reformulationRate,
    },
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
  lines.push(`  Re-asked:    ${pct(m.queries.reformulationRate)}  ${m.queries.reformulated}/${m.queries.total} queries had to be reformulated`
    + `   ${c(m.queries.reformulationRate === null ? null : 1 - m.queries.reformulationRate, 1 - REFORMULATION_CEILING)} ceiling ${pct(REFORMULATION_CEILING)}`);
  lines.push(`  Of ${m.queries.total} quer${m.queries.total === 1 ? 'y' : 'ies'}: `
    + `${m.queries.expanded} opened an excerpt · ${m.queries.reformulated} re-asked · ${m.queries.silent} neither`);
  lines.push(`  Depth:       ${m.depth.expands} expansion(s), `
    + `${m.depth.perExpandingQuery === null ? '—' : m.depth.perExpandingQuery.toFixed(1)} per expanding query, `
    + `${m.depth.distinctSessionsExpanded} distinct session(s) opened`);
  lines.push('');
  lines.push(`  Verdict:     ${m.verdict.headline}`);
  lines.push(`               ${m.verdict.detail}`);
  lines.push('');
  lines.push('  Reads THIS machine only — nothing is uploaded. It is a health check on');
  lines.push('  whether recall works for you. It is NOT evidence of demand across users,');
  lines.push('  and must not be used on its own to justify building on top of recall.');
  lines.push('  "Neither" is not scored: satisfied and gave-up look identical from here.');
  return lines.join('\n');
}

function c(rate: number | null, target: number): string {
  if (rate === null) return ' ';
  return rate >= target ? '✓' : '✗';
}
