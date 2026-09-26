// Decision-drift enforcement. The #1 complaint about AI coding tools is that
// they forget architectural decisions and re-litigate them sessions later.
// Veto already *stores* decisions; this module makes them *enforceable*: a
// decision carries forbidden patterns, and diff reviews flag any added line
// that violates one — "we chose Postgres" becomes a constraint that fires
// when an AI quietly adds mongoose to the imports.

import { randomUUID } from 'node:crypto';
import { getDb } from './local.js';
import { projectKey } from '../transcripts/project-key.js';

export type ConstraintSeverity = 'block' | 'warn';

export type DecisionConstraint = {
  id: string;
  project_dir: string | null;
  rule: string;
  why: string | null;
  forbidden_patterns: string[];
  file_scope: string | null;
  severity: ConstraintSeverity;
  active: boolean;
  created_at: string;
};

export type DriftViolation = {
  constraint_id: string;
  rule: string;
  why: string | null;
  severity: ConstraintSeverity;
  file: string;
  line: string;
  matched_pattern: string;
};

type Row = {
  id: string; project_dir: string | null; rule: string; why: string | null;
  forbidden_patterns: string; file_scope: string | null; severity: string;
  active: number; created_at: string;
};

function rowToConstraint(r: Row): DecisionConstraint {
  let patterns: string[] = [];
  try { patterns = JSON.parse(r.forbidden_patterns); } catch { /* corrupt row — no patterns, never matches */ }
  return {
    id: r.id,
    project_dir: r.project_dir,
    rule: r.rule,
    why: r.why,
    forbidden_patterns: Array.isArray(patterns) ? patterns.map(String) : [],
    file_scope: r.file_scope,
    severity: r.severity === 'warn' ? 'warn' : 'block',
    active: r.active === 1,
    created_at: r.created_at,
  };
}

function normalizeDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ─── Pattern safety ───────────────────────────────────────────────────────────
// Constraints run inside veto_diff_review and veto_ci_gate, so one bad pattern
// must never wedge them. addConstraint is the only way into the table, and it
// refuses a pattern that fails these checks; a pattern stored before they
// existed degrades to a literal substring match at check time instead.

export const MAX_PATTERN_LENGTH = 200;

// True when a repeated group contains a repeat of its own — (a+)+, (\w*)*,
// ((ab)+c){2,} — the shape behind catastrophic backtracking. Deliberately
// over-approximate: refusing a safe pattern costs the user one rewrite,
// accepting a bad one can hang every review that follows.
function hasNestedQuantifier(src: string): boolean {
  const groups: boolean[] = [];   // per open group: does its body repeat anything?
  let closedGroupRepeats = false; // the group that closed on the previous character
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const afterRepeatingGroup = closedGroupRepeats;
    closedGroupRepeats = false;
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { groups.push(false); continue; }
    if (ch === ')') {
      closedGroupRepeats = groups.pop() ?? false;
      if (closedGroupRepeats && groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    if (ch === '+' || ch === '*' || (ch === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i)))) {
      if (afterRepeatingGroup) return true;
      if (groups.length > 0) groups[groups.length - 1] = true;
    }
  }
  return false;
}

function compiles(pattern: string): boolean {
  try { new RegExp(pattern, 'i'); return true; } catch { return false; }
}

// Why each pattern is unsafe to run against every future diff; [] means all are safe.
// A pattern that does not compile is not a problem: it is matched as plain text.
export function validateForbiddenPatterns(patterns: string[]): string[] {
  const problems: string[] = [];
  for (const p of patterns) {
    if (p.length > MAX_PATTERN_LENGTH) {
      problems.push(`"${p.slice(0, 40)}…" is ${p.length} characters; the limit is ${MAX_PATTERN_LENGTH}.`);
    } else if (compiles(p) && hasNestedQuantifier(p)) {
      problems.push(`"${p}" repeats a group that already repeats, which can hang diff review on some inputs. Drop the outer repeat — "(a+)+" matches the same lines as "a+".`);
    }
  }
  return problems;
}

export function addConstraint(input: {
  rule: string;
  forbidden_patterns: string[];
  why?: string;
  file_scope?: string;
  severity?: ConstraintSeverity;
  project_dir?: string;
}): DecisionConstraint {
  const problems = validateForbiddenPatterns(input.forbidden_patterns);
  if (problems.length > 0) throw new Error(`Unsafe forbidden_patterns: ${problems.join(' ')}`);
  const db = getDb();
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO decision_constraints (id, project_dir, rule, why, forbidden_patterns, file_scope, severity, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    normalizeDir(input.project_dir),
    input.rule,
    input.why ?? null,
    JSON.stringify(input.forbidden_patterns),
    input.file_scope ?? null,
    input.severity === 'warn' ? 'warn' : 'block',
    created_at,
  );
  return listConstraints().find(c => c.id === id)!;
}

// Project-scoped constraints apply to their project; null-scoped apply everywhere.
export function listConstraints(project_dir?: string, include_inactive = false): DecisionConstraint[] {
  const db = getDb();
  const dir = normalizeDir(project_dir);
  const rows = db.prepare('SELECT * FROM decision_constraints ORDER BY created_at DESC').all() as Row[];
  return rows
    .map(rowToConstraint)
    .filter(c => include_inactive || c.active)
    .filter(c => !dir || c.project_dir === null || projectKey(c.project_dir) === projectKey(dir));
}

export function setConstraintActive(id: string, active: boolean): boolean {
  const db = getDb();
  const res = db.prepare('UPDATE decision_constraints SET active = ? WHERE id = ?').run(active ? 1 : 0, id) as { changes: number };
  return res.changes > 0;
}

// ─── Diff checking ────────────────────────────────────────────────────────────

// Minimal glob: "**/" matches zero or more whole path segments (so
// "src/**/*.ts" matches "src/db.ts" too), "**" matches anything, "*" stays
// within one segment. Paths normalized to forward slashes. Spaces are used as
// intermediate placeholders — globs never legitimately contain them mid-token.
function scopeMatches(scope: string | null, file: string): boolean {
  if (!scope) return true;
  const re = '^' + scope
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, '  ')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/ {2}/g, '(?:.*/)?')
    .replace(/ /g, '.*') + '$';
  try { return new RegExp(re, 'i').test(file.replace(/\\/g, '/')); } catch { return true; }
}

// A pattern is a case-insensitive regex. One that doesn't compile — or that
// validateForbiddenPatterns would refuse, e.g. stored before those checks
// existed — degrades to a case-insensitive substring match, so user input can
// never break or hang the check.
function toMatcher(pattern: string): (line: string) => boolean {
  if (validateForbiddenPatterns([pattern]).length === 0) {
    try { const re = new RegExp(pattern, 'i'); return line => re.test(line); } catch { /* not a regex */ }
  }
  const needle = pattern.toLowerCase();
  return line => line.toLowerCase().includes(needle);
}

// A check must finish. Only the first MAX_LINE_CHARS of each added line are
// tested (a minified bundle can put 100KB on one line), and once the check has
// run for budgetMs it stops and reports a warning — so a slow rule degrades
// review and CI to a warning instead of wedging them.
export const MAX_LINE_CHARS = 2_000;
export const CHECK_BUDGET_MS = 2_000;

export function checkDiffAgainstConstraints(diff: string, project_dir?: string, budgetMs = CHECK_BUDGET_MS): DriftViolation[] {
  const constraints = listConstraints(project_dir).map(c => ({
    ...c,
    matchers: c.forbidden_patterns.filter(Boolean).map(pattern => ({ pattern, test: toMatcher(pattern) })),
  }));
  if (constraints.length === 0 || !diff.trim()) return [];

  const deadline = Date.now() + budgetMs;
  const violations: DriftViolation[] = [];
  let currentFile = '';
  for (const raw of diff.split('\n')) {
    if (Date.now() >= deadline) {
      violations.push({
        constraint_id: 'veto:check-budget',
        rule: `Decision check stopped after ${budgetMs}ms; the rest of this diff was not checked.`,
        why: 'A constraint is too slow for this diff. Find it with veto_decisions list, then simplify or disable it.',
        severity: 'warn',
        file: currentFile || '(diff)',
        line: '',
        matched_pattern: '',
      });
      break;
    }
    const fileHeader = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) { currentFile = fileHeader[1]; continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1, 1 + MAX_LINE_CHARS);
    for (const c of constraints) {
      if (!scopeMatches(c.file_scope, currentFile)) continue;
      for (const { pattern, test } of c.matchers) {
        if (test(line)) {
          violations.push({
            constraint_id: c.id,
            rule: c.rule,
            why: c.why,
            severity: c.severity,
            file: currentFile || '(unknown file)',
            line: line.trim().slice(0, 200),
            matched_pattern: pattern,
          });
          break; // one violation per constraint per line
        }
      }
    }
  }
  return violations;
}

// ─── Invitations ──────────────────────────────────────────────────────────────
// v3.3 step 1 (council 27cf8bcb). decision_constraints held 0 rows after four
// months of use, and the council read that as a discoverability failure:
// nothing ever asked. So after a verdict, Veto asks ONCE whether it should
// become a constraint, and records the answer, so "is the answer ever yes?"
// can be read locally. Nothing leaves the machine. An invitation is:
//   accepted   — veto_decisions add was called with its id
//   declined   — veto_decisions decline was called with its id
//   unanswered — never surfaced, judged not applicable by the host, or ignored;
//                these three are indistinguishable from here, so it is never
//                counted as a "no".

export type InvitationSource = 'council' | 'adr';
export type InvitationAnswer = 'accepted' | 'declined';

export type ConstraintInvitation = {
  id: string;
  source_kind: InvitationSource;
  source_id: string | null;
  project_dir: string | null;
  offered_at: string;
  answer: InvitationAnswer | null;
  answered_at: string | null;
  constraint_id: string | null;
};

// Records an offer, or returns null when this source (a council outcome) has
// already been offered — one question per verdict, however many tools see it.
export function offerInvitation(input: {
  source_kind: InvitationSource;
  source_id?: string;
  project_dir?: string;
}): ConstraintInvitation | null {
  const db = getDb();
  const id = randomUUID();
  const res = db.prepare(
    `INSERT OR IGNORE INTO constraint_invitations (id, source_kind, source_id, project_dir, offered_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.source_kind, input.source_id ?? null, normalizeDir(input.project_dir), new Date().toISOString()) as { changes: number };
  return res.changes > 0 ? getInvitation(id) : null;
}

export function getInvitation(id: string): ConstraintInvitation | null {
  const row = getDb().prepare('SELECT * FROM constraint_invitations WHERE id = ?').get(id) as ConstraintInvitation | undefined;
  return row ?? null;
}

// An invitation is answered once; a second answer is refused so the counts
// cannot drift from what the user actually said.
export function answerInvitation(
  id: string,
  answer: InvitationAnswer,
  constraint_id?: string,
): 'recorded' | 'not_found' | 'already_answered' {
  const res = getDb().prepare(
    'UPDATE constraint_invitations SET answer = ?, answered_at = ?, constraint_id = ? WHERE id = ? AND answer IS NULL'
  ).run(answer, new Date().toISOString(), constraint_id ?? null, id) as { changes: number };
  if (res.changes > 0) return 'recorded';
  return getInvitation(id) ? 'already_answered' : 'not_found';
}

// Across all projects: the question is whether anyone ever says yes, not where.
export function invitationStats(): { offered: number; accepted: number; declined: number; unanswered: number } {
  const r = getDb().prepare(
    `SELECT COUNT(*) AS offered,
            COALESCE(SUM(answer = 'accepted'), 0) AS accepted,
            COALESCE(SUM(answer = 'declined'), 0) AS declined,
            COALESCE(SUM(answer IS NULL), 0) AS unanswered
       FROM constraint_invitations`
  ).get() as { offered: number; accepted: number; declined: number; unanswered: number };
  return { offered: r.offered, accepted: r.accepted, declined: r.declined, unanswered: r.unanswered };
}

// The text a tool result carries to the host AI. Fixed wording, no derived
// content: the rule is written in the user's words when they say yes, so what
// ends up enforced is text the user authored or confirmed.
export function invitationPayload(invitation_id: string) {
  return {
    invitation_id,
    instruction:
      'Ask the user once, in one line, whether this verdict should become an enforceable rule: Veto would then flag any future diff that breaks it. ' +
      'Ask only if the verdict settles a lasting choice (e.g. "we use Postgres, not Mongo"); if it settles nothing lasting, skip the question without mentioning it. ' +
      'If they say yes, call veto_decisions with { action: "add", invitation_id, rule (in the user\'s words), forbidden_patterns, why }. ' +
      'If they say no, call veto_decisions with { action: "decline", invitation_id }. Never raise it again for this verdict.',
  };
}
