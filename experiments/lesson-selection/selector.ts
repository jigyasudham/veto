// Offline experiment only. No store, configuration, host files, or trial imports.
import { tokenize } from '../../src/transcripts/tokenize.js';
import { STOPWORDS } from '../../src/transcripts/stopwords.js';

export type Note = {
  id: string;
  text: string;
  project: string;
  scope: 'project' | 'user' | 'machine';
  quarantined?: boolean;
  disabled?: boolean;
  native?: boolean;
  stale?: boolean;
  createdAt: number;
  updatedAt: number;
  // Explicitly authored, independent lessons; never automatic sentence cuts.
  units?: string[];
};
export type Input = {
  query: string;
  project: string;
  asOf: number;
  consent: boolean;
  excluded?: boolean;
  notes: Note[];
};
const ALIASES: Record<string, string> = {
  pwsh: 'powershell', 'powershell.exe': 'powershell',
  'utf-8': 'utf8', 'utf_8': 'utf8',
  'node.js': 'nodejs',
};
const estimate = (text: string) => Math.ceil(text.length / 4);
const alias = (word: string) => Object.hasOwn(ALIASES, word) ? ALIASES[word] : word;
const words = (text: string, improved: boolean) => [...new Set(
  tokenize(text, false).map(word => improved ? alias(word) : word)
    .filter(word => !STOPWORDS.has(word)),
)];

/** Counts only: no rejected text or query is returned in diagnostics. */
export function evaluate(input: Input, improved = true) {
  const counts = {
    total: input.notes.length, disabled: 0, native: 0, stale: 0,
    scope: 0, notYetCreated: 0, changed: 0, eligible: 0,
    insufficientTerms: 0, overBudget: 0, duplicate: 0, selected: 0,
  };
  const selected: Array<{ noteId: string; unit: number; text: string }> = [];
  const result = (reason: string, tokens = 0) => ({ reason, counts, selected, tokens });
  if (!input.consent) return result('consent_off');
  if (input.excluded) return result('project_excluded');
  const queryWords = words(input.query, improved);
  // A future trigger policy, not a change to trial 2's first-request policy.
  if (improved && (/^\s*(?:please\s+)?(?:continue|resume|go ahead|yes)[.!\s]*$/i.test(input.query)
    || /^\s*veto_continue(?:\s|$)/i.test(input.query))) return result('await_task');

  const candidates: Array<{ note: Note; text: string; unit: number }> = [];
  for (const note of input.notes) {
    // Sequential, exclusive exclusion counters: each rejected note counted once.
    if (note.createdAt > input.asOf) { counts.notYetCreated++; continue; }
    if (note.updatedAt > input.asOf) { counts.changed++; continue; }
    if (note.disabled) { counts.disabled++; continue; }
    if (note.native) { counts.native++; continue; }
    if (note.stale) { counts.stale++; continue; }
    if (note.project !== input.project && (note.scope === 'project' || note.quarantined)) {
      counts.scope++; continue;
    }
    counts.eligible++;
    const units = improved && note.units?.length ? note.units : [note.text];
    units.forEach((text, unit) => candidates.push({ note, text, unit }));
  }
  // BM25 collection stats use all time-eligible notes, as in the production selector.
  // Experimental units are indexed independently; eligibility is never widened.
  const collection = input.notes.filter(n => n.createdAt <= input.asOf && n.updatedAt <= input.asOf)
    .flatMap(n => improved && n.units?.length ? n.units : [n.text]);
  const terms = (text: string) => tokenize(improved
    ? tokenize(text, false).map(alias).join(' ') : text).filter(t => !STOPWORDS.has(t));
  const docs = collection.map(terms);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const queryTerms = [...new Set(terms(input.query))];
  const ranked = candidates.map(candidate => {
    const docWords = new Set(words(candidate.text, improved));
    const matched = queryWords.filter(w => docWords.has(w)).length;
    if (!queryWords.length || matched < Math.min(2, queryWords.length)) {
      counts.insufficientTerms++;
      return { ...candidate, score: 0 };
    }
    const doc = terms(candidate.text);
    const score = queryTerms.reduce((sum, term) => {
      const tf = doc.filter(t => t === term).length;
      const df = docs.filter(d => d.includes(term)).length;
      return sum + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
        * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / Math.max(average, 1)));
    }, 0);
    return { ...candidate, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score
    || b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id) || a.unit - b.unit);
  let tokens = 0;
  const seen = new Set<string>();
  for (const candidate of ranked) {
    if (seen.has(candidate.text)) { counts.duplicate++; continue; }
    const cost = estimate(candidate.text);
    if (tokens + cost > 500) { counts.overBudget++; continue; }
    seen.add(candidate.text);
    tokens += cost;
    selected.push({ noteId: candidate.note.id, unit: candidate.unit, text: candidate.text });
    counts.selected++;
  }
  return result(selected.length ? 'selected' : 'no_match', tokens);
}
