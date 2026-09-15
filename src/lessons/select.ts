import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { getDb } from '../memory/local.js';
import { tokenize } from '../transcripts/tokenize.js';
import { STOPWORDS } from '../transcripts/stopwords.js';
import { isLessonsSharingEnabled } from '../memory/config.js';
import type { LessonSource } from './adapters/index.js';
import { resolveProjectIdentity } from './identity.js';
import { claudeProjectSlug, sameClaudeSlug } from './source-project.js';
import { disabledLessonSources, type LessonRow } from './store.js';

const K1 = 1.2;
const B = 0.75;
const TOKEN_CAP = 500;
// A note must share at least this many distinct query terms: one common word
// in common ("code", "user") is coincidence, not relevance.
const MIN_MATCHED_TERMS = 2;
const STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_TITLE_RE = /\b(status|progress|next steps?|todo|wip|in progress)\b/i;

export type ShadowSelection = {
  lessonIds: string[];
  estimatedTokens: number;
  targetProjectIdentity: string | null;
  reason: 'selected' | 'no_match' | 'consent_off';
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
  const terms = [...new Set(tokenize(query).filter(term => !STOPWORDS.has(term)))];
  const words = [...new Set(tokenize(query, false).filter(word => !STOPWORDS.has(word)))];
  const docs = new Map(collection.map(row => [row.id, tokenize(row.text_masked)]));
  const avg = [...docs.values()].reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.size, 1);
  const df = new Map(terms.map(term => [term, [...docs.values()].filter(doc => doc.includes(term)).length]));
  const needed = Math.min(MIN_MATCHED_TERMS, words.length);
  return candidates.map(row => {
    const doc = docs.get(row.id) ?? tokenize(row.text_masked);
    const docWords = new Set(tokenize(row.text_masked, false));
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

/** Deterministic, non-delivering selection used only for prospective shadow logs. */
export function selectLessonsForShadow(input: { query: string; targetProjectDir: string; targetHost: LessonSource; now?: number }): ShadowSelection {
  if (!isLessonsSharingEnabled()) return { lessonIds: [], estimatedTokens: 0, targetProjectIdentity: null, reason: 'consent_off' };
  const targetIdentity = resolveProjectIdentity(input.targetProjectDir);
  const now = input.now ?? Date.now();
  const disabled = disabledLessonSources();
  const all = getDb().prepare('SELECT * FROM lessons').all() as LessonRow[];
  const candidates = all.filter(row =>
    !disabled.has(row.source_cli)
    && !nativelyLoaded(row, input.targetHost, input.targetProjectDir)
    && !staleStatus(row, now)
    && eligible(row, targetIdentity));

  // Relevance first, then newest source on ties; a note without enough query
  // terms in common is not selected at all, however much budget is left.
  const ranked = rank(input.query, candidates, all)
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.row.source_mtime) - Date.parse(a.row.source_mtime) || a.row.id.localeCompare(b.row.id));

  // Newest wins on conflict: the same entry held in several places (one memory
  // file copied into the D:, F: and G: checkouts' folders) counts once, as its
  // newest version, even when an older copy ranks higher. Identical text from
  // different entries is served once too.
  const entryKey = (row: LessonRow) => `${basename(row.source_path).toLowerCase()}#${row.section_anchor}`;
  const newestByEntry = new Map<string, LessonRow>();
  for (const row of candidates) {
    const held = newestByEntry.get(entryKey(row));
    if (!held || Date.parse(row.source_mtime) > Date.parse(held.source_mtime)) newestByEntry.set(entryKey(row), row);
  }

  const chosen: LessonRow[] = [];
  const seenText = new Set<string>();
  let tokens = 0;
  for (const { row } of ranked) {
    if (newestByEntry.get(entryKey(row)) !== row || seenText.has(row.text_masked)) continue;
    const estimate = estimateTokens(row.text_masked);
    if (tokens + estimate > TOKEN_CAP) continue;
    chosen.push(row);
    seenText.add(row.text_masked);
    tokens += estimate;
  }
  return {
    lessonIds: chosen.map(row => row.id),
    estimatedTokens: tokens,
    targetProjectIdentity: targetIdentity,
    reason: chosen.length ? 'selected' : 'no_match',
  };
}

/** Append-only prospective evidence. It records IDs and metadata, never delivery. */
export function logShadowSelection(input: { query: string; targetHost: LessonSource; selection: ShadowSelection }): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO lesson_shadow_log (id, query, target_project_identity, target_host, lesson_ids, estimated_tokens, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.query, input.selection.targetProjectIdentity ?? '', input.targetHost, JSON.stringify(input.selection.lessonIds),
      input.selection.estimatedTokens, input.selection.reason, new Date().toISOString());
  return id;
}
