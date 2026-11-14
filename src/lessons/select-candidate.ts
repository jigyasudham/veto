// Candidate v1: explicit local preview only. Trial 2 keeps select.ts unchanged.
import { basename, dirname } from 'node:path';
import { getDb } from '../memory/local.js';
import { tokenize } from '../transcripts/tokenize.js';
import { STOPWORDS } from '../transcripts/stopwords.js';
import { isLessonsSharingEnabled } from '../memory/config.js';
import type { LessonSource } from './adapters/index.js';
import { resolveProjectIdentity } from './identity.js';
import { claudeProjectSlug, sameClaudeSlug } from './source-project.js';
import { disabledLessonSources, isProjectExcluded, lessonEntryKey, type LessonRow } from './store.js';
import { trialPhase } from './trial-setup.js';

export const CANDIDATE_VERSION = 'lexical-alias-v1';
const ALIASES: Record<string, string> = {
  pwsh: 'powershell', 'powershell.exe': 'powershell',
  'utf-8': 'utf8', utf_8: 'utf8', 'node.js': 'nodejs',
};
const canonical = (term: string) => Object.hasOwn(ALIASES, term) ? ALIASES[term] : term;
const termsFor = (text: string, subtokens = true): string[] => tokenize(text, subtokens).map(canonical);

export type SelectionDiagnostics = {
  total: number; notYetAvailable: number; changedSinceStart: number;
  disabledSource: number; nativeContext: number; staleStatus: number; outsideScope: number;
  eligible: number; insufficientTerms: number; superseded: number; duplicate: number;
  overBudget: number; selected: number;
};

const K1 = 1.2;
const B = 0.75;
const TOKEN_CAP = 500;
// A note must share at least this many distinct query terms: one common word
// in common ("code", "user") is coincidence, not relevance.
const MIN_MATCHED_TERMS = 2;
const STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_TITLE_RE = /\b(status|progress|next steps?|todo|wip|in progress)\b/i;

export type ShadowSelection = {
  selectorVersion: typeof CANDIDATE_VERSION;
  diagnostics: SelectionDiagnostics;
  lessonIds: string[];
  estimatedTokens: number;
  targetProjectIdentity: string | null;
  reason: 'selected' | 'no_match' | 'consent_off' | 'project_excluded' | 'trial_running';
  /** Notes this session could have been given at all. */
  poolSize: number;
  /** Eligible notes that existed before the session but changed after it began, so were left out. */
  changedSinceStart: number;
};

const title = (row: LessonRow): string => row.text_masked.split('\n', 1)[0].trim();

/** Rough, model-agnostic: about four characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * The host already has this note in context, so re-injecting it only spends
 * the budget. Claude loads the memory folder of the project it runs in; Codex
 * and Gemini load their global file in every session. A Claude note from the
 * SAME project but another checkout's folder (D: vs F:) is not loaded, and is
 * exactly what sharing is for.
 */
function nativelyLoaded(row: LessonRow, host: LessonSource, projectDir: string): boolean {
  if (row.source_cli !== host) return false;
  if (host !== 'claude') return true;
  return sameClaudeSlug(basename(dirname(dirname(row.source_path))), claudeProjectSlug(projectDir));
}

function staleStatus(row: LessonRow, now: number): boolean {
  return STATUS_TITLE_RE.test(title(row)) && now - Date.parse(row.source_mtime) > STATUS_TTL_MS;
}

/**
 * Which rows may reach this project at all: its own project's notes (any
 * scope, quarantined included, since they never leave the project), plus other
 * projects' user/machine notes that are not quarantined.
 */
function eligible(row: LessonRow, targetIdentity: string): boolean {
  if (row.project_identity === targetIdentity) return true;
  return row.scope !== 'project' && row.quarantined === 0;
}

/**
 * BM25 of each candidate against the query. Collection statistics (document
 * frequency, average length) come from the WHOLE lessons table: computed over
 * the few eligible candidates they would make any shared word look rare.
 */
function rank(query: string, candidates: LessonRow[], collection: LessonRow[]): Array<{ row: LessonRow; score: number; matched: number }> {
  // Scored on sub-tokens (recall), gated on whole words: `git-bash` expands to
  // three terms but is one word, and one word must not clear the two-word bar.
  const terms = [...new Set(termsFor(query).filter(term => !STOPWORDS.has(term)))];
  const words = [...new Set(termsFor(query, false).filter(word => !STOPWORDS.has(word)))];
  const docs = new Map(collection.map(row => [row.id, termsFor(row.text_masked)]));
  const avg = [...docs.values()].reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.size, 1);
  const df = new Map(terms.map(term => [term, [...docs.values()].filter(doc => doc.includes(term)).length]));
  const needed = Math.min(MIN_MATCHED_TERMS, words.length);
  return candidates.map(row => {
    const doc = docs.get(row.id) ?? termsFor(row.text_masked);
    const docWords = new Set(termsFor(row.text_masked, false));
    const matched = words.filter(word => docWords.has(word)).length;
    let score = 0;
    for (const term of terms) {
      const tf = doc.filter(token => token === term).length;
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.size - n + 0.5) / (n + 0.5));
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / Math.max(avg, 1))));
    }
    return { row, score: matched >= needed ? score : 0, matched };
  });
}

/**
 * Deterministic, non-delivering candidate for explicit count-only preview.
 * Never called by the shadow trial; refused while that trial is running.
 *
 * `asOf` is when the session began. Only notes as they were then count: a note
 * harvested later did not exist for this session, and one that changed since
 * no longer has the text it had then, so both are left out. lessons.updated_at
 * moves only when a note's content changes (store.ts syncLessons), which is
 * what makes this cut exact; tests/lessons/trial.test.ts holds it to that.
 */
export function selectLessonsCandidate(input: { query: string; targetProjectDir: string; targetHost: LessonSource; now?: number; asOf?: number }): ShadowSelection {
  const diagnostics: SelectionDiagnostics = {
    total: 0, notYetAvailable: 0, changedSinceStart: 0, disabledSource: 0,
    nativeContext: 0, staleStatus: 0, outsideScope: 0, eligible: 0,
    insufficientTerms: 0, superseded: 0, duplicate: 0, overBudget: 0, selected: 0,
  };
  const none = { selectorVersion: CANDIDATE_VERSION as typeof CANDIDATE_VERSION, diagnostics, lessonIds: [], estimatedTokens: 0, poolSize: 0, changedSinceStart: 0 };
  if (!isLessonsSharingEnabled()) return { ...none, targetProjectIdentity: null, reason: 'consent_off' };
  if (trialPhase() === 'running') return { ...none, targetProjectIdentity: null, reason: 'trial_running' };
  const targetIdentity = resolveProjectIdentity(input.targetProjectDir);
  if (isProjectExcluded(targetIdentity)) return { ...none, targetProjectIdentity: targetIdentity, reason: 'project_excluded' };
  const now = input.asOf ?? input.now ?? Date.now();
  const disabled = disabledLessonSources();
  const everything = getDb().prepare('SELECT * FROM lessons').all() as LessonRow[];
  diagnostics.total = everything.length;
  const asOf = input.asOf;
  const existedThen = (row: LessonRow): boolean => asOf === undefined || Date.parse(row.updated_at) <= asOf;
  const all = everything.filter(existedThen);
  const usable = (row: LessonRow): boolean =>
    !disabled.has(row.source_cli)
    && !nativelyLoaded(row, input.targetHost, input.targetProjectDir)
    && !staleStatus(row, now)
    && eligible(row, targetIdentity);
  // Exclusive counters: each row exits at its first rejection; remaining rows
  // exit at exactly one ranking/budget stage below.
  const candidates: LessonRow[] = [];
  for (const row of everything) {
    if (!existedThen(row)) {
      if (asOf !== undefined && Date.parse(row.created_at) <= asOf) diagnostics.changedSinceStart++;
      else diagnostics.notYetAvailable++;
    } else if (disabled.has(row.source_cli)) diagnostics.disabledSource++;
    else if (nativelyLoaded(row, input.targetHost, input.targetProjectDir)) diagnostics.nativeContext++;
    else if (staleStatus(row, now)) diagnostics.staleStatus++;
    else if (!eligible(row, targetIdentity)) diagnostics.outsideScope++;
    else candidates.push(row);
  }
  diagnostics.eligible = candidates.length;
  const changedSinceStart = asOf === undefined ? 0
    : everything.filter(row => !existedThen(row) && Date.parse(row.created_at) <= asOf && usable(row)).length;

  // Relevance first, then newest source on ties; a note without enough query
  // terms in common is not selected at all, however much budget is left.
  const ranked = rank(input.query, candidates, all)
    .filter(entry => { if (entry.score > 0) return true; diagnostics.insufficientTerms++; return false; })
    .sort((a, b) => b.score - a.score || Date.parse(b.row.source_mtime) - Date.parse(a.row.source_mtime) || a.row.id.localeCompare(b.row.id));

  // Newest wins on conflict: the same entry held in several places (one memory
  // file copied into the D:, F: and G: checkouts' folders) counts once, as its
  // newest version, even when an older copy ranks higher. Identical text from
  // different entries is served once too. Same-named files of two different
  // projects are two entries.
  const newestByEntry = new Map<string, LessonRow>();
  for (const row of candidates) {
    const held = newestByEntry.get(lessonEntryKey(row));
    if (!held || Date.parse(row.source_mtime) > Date.parse(held.source_mtime)
      || (row.source_mtime === held.source_mtime && row.id.localeCompare(held.id) < 0)) newestByEntry.set(lessonEntryKey(row), row);
  }

  const chosen: LessonRow[] = [];
  const seenText = new Set<string>();
  let tokens = 0;
  for (const { row } of ranked) {
    if (newestByEntry.get(lessonEntryKey(row)) !== row) { diagnostics.superseded++; continue; }
    if (seenText.has(row.text_masked)) { diagnostics.duplicate++; continue; }
    const estimate = estimateTokens(row.text_masked);
    if (tokens + estimate > TOKEN_CAP) { diagnostics.overBudget++; continue; }
    chosen.push(row);
    seenText.add(row.text_masked);
    tokens += estimate;
  }
  return {
    selectorVersion: CANDIDATE_VERSION,
    diagnostics: { ...diagnostics, selected: chosen.length },
    lessonIds: chosen.map(row => row.id),
    estimatedTokens: tokens,
    targetProjectIdentity: targetIdentity,
    reason: chosen.length ? 'selected' : 'no_match',
    poolSize: candidates.length,
    changedSinceStart,
  };
}
