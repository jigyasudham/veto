// Skill: context-compress — when and how to compress context before model calls

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

const TEMPLATE = `
// ── Context Compression Protocol ─────────────────────────────────────────
//
// Apply when token count > 8,000 or before any cross-platform handoff.
// Target: < 30% of original token count, zero loss of active constraints.
//
// Compression tiers:
//
// TIER 1 — Keep verbatim (never compress):
//   - Active blockers that require human input
//   - Open decisions that have not been resolved
//   - File paths of files currently being modified
//   - The single next action
//   - Error messages that have not been diagnosed
//
// TIER 2 — Compress to 1–3 sentences:
//   - Completed subtasks (collapse to "✓ Implemented X")
//   - Read-back confirmations ("confirmed the file exists")
//   - Resolved blockers ("fixed: dependency conflict — used --legacy-peer-deps")
//   - Prior session context (collapse to a 2-sentence progress summary)
//
// TIER 3 — Drop entirely:
//   - Superseded decisions (replaced by a newer ADR)
//   - Files read but not modified and not needed going forward
//   - Exploratory steps that led to dead ends and have been abandoned
//   - Console output that has already been analyzed
//
// Compressed context shape:
{
  "phase": "implementing",
  "completed": ["Brief one-liner per completed subtask"],
  "inProgress": "The exact current subtask in one sentence",
  "remaining": ["Ordered list of remaining subtasks"],
  "activeConstraints": ["Each constraint in one sentence"],
  "openDecisions": [{ "question": "...", "options": ["A", "B"] }],
  "blockers": ["Any current blocker with full detail"],
  "keyFiles": ["Only files still needed going forward"],
  "nextAction": "Single concrete step — unambiguous"
}
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'context-compress',
    template: TEMPLATE,
    checklist: [
      'Measure the current context token estimate before compressing',
      'Apply compression only when token count exceeds 8,000 or before a platform handoff',
      'Identify Tier 1 items first — these are never touched',
      'Identify Tier 3 items — drop them completely without summarising',
      'For Tier 2 items: write one sentence per completed subtask; the reader does not need the history',
      'Preserve the full text of any active blocker — the receiving agent must understand it in full',
      'Preserve the nextAction as a concrete step, not "continue the task"',
      'After compressing: verify the compressed context is complete by simulating a cold-start agent reading it',
      'Save the compressed context via veto_session_save before switching context',
      'Target a compression ratio of at least 3:1 — if you cannot achieve this, you have too many Tier 1 items',
      'Do not compress active error messages — they need full context to diagnose',
      'Do not summarise open decisions — they need all options preserved',
    ],
    patterns: [
      'Tier-based compression: verbatim | summarise | drop — never binary keep/delete',
      'Cold-start test: can a fresh agent read the compressed context and continue the task without questions?',
      'Constraint-first ordering: active constraints at the top, history at the bottom',
      'Forward-only compression: compress backward-looking content, not forward-looking content',
    ],
    gotchas: [
      'Compressing active constraints as if they were completed work — causes silent violations in the next session',
      'Summarising blockers instead of preserving them verbatim — the receiving agent gets a vague summary and cannot resolve the blocker',
      'Dropping unresolved error messages — the receiving agent restarts diagnosis from scratch',
      'Targeting a fixed token count without checking completeness — may cut load-bearing context',
      'Not saving the compressed context — the compression is lost on the next context switch',
      'Treating all prior session content as droppable — some prior-session decisions are still active constraints',
    ],
    resources: [
      'Use veto_route_task with context= to get the router\'s compression estimate',
      'Use veto_session_save to persist the compressed context',
      'Use veto_memory_store to permanently record key decisions before they are compressed away',
      'The compression target is based on the router\'s context-compressor module heuristics',
    ],
  };
}
