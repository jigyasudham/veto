// Decision-drift enforcement. The #1 complaint about AI coding tools is that
// they forget architectural decisions and re-litigate them sessions later.
// Veto already *stores* decisions; this module makes them *enforceable*: a
// decision carries forbidden patterns, and diff reviews flag any added line
// that violates one — "we chose Postgres" becomes a constraint that fires
// when an AI quietly adds mongoose to the imports.

import { randomUUID } from 'node:crypto';
import { getDb } from './local.js';

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

export function addConstraint(input: {
  rule: string;
  forbidden_patterns: string[];
  why?: string;
  file_scope?: string;
  severity?: ConstraintSeverity;
  project_dir?: string;
}): DecisionConstraint {
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
    .filter(c => !dir || c.project_dir === null || c.project_dir === dir);
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

// A pattern is a case-insensitive regex; if it doesn't compile, it degrades to
// a case-insensitive substring match so user input can never break the check.
function patternMatches(pattern: string, line: string): boolean {
  try { return new RegExp(pattern, 'i').test(line); } catch { return line.toLowerCase().includes(pattern.toLowerCase()); }
}

export function checkDiffAgainstConstraints(diff: string, project_dir?: string): DriftViolation[] {
  const constraints = listConstraints(project_dir);
  if (constraints.length === 0 || !diff.trim()) return [];

  const violations: DriftViolation[] = [];
  let currentFile = '';
  for (const raw of diff.split('\n')) {
    const fileHeader = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) { currentFile = fileHeader[1]; continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    for (const c of constraints) {
      if (!scopeMatches(c.file_scope, currentFile)) continue;
      for (const pattern of c.forbidden_patterns) {
        if (pattern && patternMatches(pattern, line)) {
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
