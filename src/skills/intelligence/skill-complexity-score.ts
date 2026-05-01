// Skill: complexity-score — how to write task descriptions that route correctly

export interface SkillInput { task: string; context?: string; options?: Record<string, unknown>; }
export interface SkillOutput { skill: string; template?: string; checklist: string[]; patterns: string[]; gotchas: string[]; resources: string[]; }

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'complexity-score',
    template: `
// ── Complexity Scoring Cheat Sheet ───────────────────────────────────────
//
// The router scores 0–100 from five factors:
//
// Factor 1: Word count        0–20 pts  (1 pt per 3 words, cap 20)
// Factor 2: Tech keywords     0–30 pts  HIGH +5, MEDIUM +2
// Factor 3: Task depth        0–20 pts  conjunctions, commas, length
// Factor 4: Files affected    0–20 pts  3 pts per file
// Factor 5: Council bonus     +10 pts   security/auth/migration keywords
//
// Tier thresholds (defaults, adjusted by learning loop):
//   Tier 1: score 0–30   → Haiku / Flash  (fast, cheap)
//   Tier 2: score 31–70  → Sonnet / Pro   (daily coding)
//   Tier 3: score 71+    → Sonnet / Advanced  (hard problems)
//
// To get a higher tier: add detail, technical keywords, or pass files_affected
// To get a lower tier: simplify the description or scope down the task
//
// Example — under-scored:
//   "write tests"  →  score 9  →  Tier 1  (too short)
//
// Example — correctly scored:
//   "write unit and integration tests for the JWT auth middleware, covering
//    token expiry, refresh rotation, and concurrent request edge cases"
//   →  score 47  →  Tier 2
//
// Example — correctly scored, high complexity:
//   "migrate user authentication from session cookies to JWT with refresh
//    token rotation — update middleware, session store, and all auth tests"
//   →  score 78  →  Tier 3 (contains 'migrate', 'authentication', 'jwt')
`.trim(),
    checklist: [
      'Call veto_route_task to see the current score before submitting a task',
      'If the score is too low: add technical keywords and more specific detail to the description',
      'If the score is too high: simplify the description or split into sub-tasks',
      'Pass files_affected if the task touches multiple files — adds 3 pts per file',
      'Use force_council=true to bypass scoring and go straight to Tier 3',
      'After completing a task: call veto_record_outcome with the actual quality (0–100)',
      'After 20+ outcomes: call veto_learning_apply to update the router thresholds',
    ],
    patterns: [
      'Specificity → score: more specific descriptions score higher and route to better models',
      'Keyword density: security/auth/migration keywords add +5 each and trigger council',
      'files_affected multiplier: 5 files = +12 pts — use this for multi-file refactors',
      'Outcome feedback: recording actuals enables the learning loop to tune thresholds over time',
    ],
    gotchas: [
      'Short task descriptions under-score — "fix auth bug" scores ~9, Tier 1 is almost certainly wrong for auth',
      'The learning loop needs 20 outcomes before it adjusts thresholds — the router is static until then',
      'force_council=true always routes to Tier 3 regardless of score — use sparingly',
      'Council auto-triggers on: architecture, security, auth, migration, drop table — you cannot suppress this',
    ],
    resources: [
      'veto_route_task — score a task and see the tier before submitting',
      'veto_record_outcome — record output quality to feed the learning loop',
      'veto_learning_apply — apply learned thresholds after 20+ recorded outcomes',
      'veto_learning_stats — see current tier distribution and suggested thresholds',
    ],
  };
}
