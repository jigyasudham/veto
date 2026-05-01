// Skill: rate-watch — monitor AI rate limits and trigger platform switches proactively

export interface SkillInput { task: string; context?: string; options?: Record<string, unknown>; }
export interface SkillOutput { skill: string; template?: string; checklist: string[]; patterns: string[]; gotchas: string[]; resources: string[]; }

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'rate-watch',
    template: `
// ── Rate Limit Thresholds ─────────────────────────────────────────────────
//
//  0–69%   Green zone  — normal routing, no action needed
// 70–89%   Warning     — Tier 1/2 auto-routes to Gemini/Codex
//                        Tier 3 stays on Claude (too important to downgrade)
// 90%+     Critical    — all tasks routed to Gemini/Codex
//                        Non-urgent work queued for reset
//
// Cross-platform switch (manual):
//
//   Claude at 90%+ mid-task?
//   1. Call veto_session_save (capture current state)
//   2. Note the session ID
//   3. Open Gemini terminal
//   4. Call veto_session_restore {session_id}
//   5. Continue — Gemini has full context
//   Total interruption: under 10 seconds
//
// All platforms at limit simultaneously?
//   Check veto_rate_status for reset times
//   Work on tasks that don't need AI (docs, planning, code review checklists)
//   Auto-resumes when first platform resets
`.trim(),
    checklist: [
      'Call veto_rate_status at the start of long sessions to check headroom',
      'At 70%: start Tier 1/2 tasks on Gemini/Codex proactively instead of waiting for auto-routing',
      'At 80%: save the current session via veto_session_save as a precaution',
      'At 90%: switch platform manually using veto_session_save → veto_session_restore',
      'At 100%: check reset times from veto_rate_status, switch to non-AI tasks until reset',
      'After a platform switch: verify the session restored correctly before continuing',
      'Prefer Gemini for T1/T2 overflow — it has higher rate limits on the free tier',
    ],
    patterns: [
      'Proactive switch at 80%: switching before hitting 90% avoids a mid-task interruption',
      'Session save at 70%: ensures context is preserved if a hard limit is hit unexpectedly',
      'Platform diversity: using two platforms in parallel halves the effective rate limit pressure',
      'Tier-based overflow: only T1/T2 overflow — never route T3 to a lower-capability model',
    ],
    gotchas: [
      'Switching platforms without saving the session — the receiving platform starts blind',
      'Routing Tier 3 tasks to Gemini Flash or Haiku to avoid rate limits — quality loss is not worth it',
      'Not checking rate status before a long task — hitting the limit mid-migration is high risk',
      'Forgetting that rate limits reset daily at midnight UTC — a limit today may reset in 2 hours',
    ],
    resources: [
      'veto_rate_status — current usage % and advisory for all platforms',
      'veto_route_task — routes tasks to the least-loaded platform automatically',
      'veto_session_save — save context before switching platforms',
      'veto_session_restore — restore on the receiving platform',
    ],
  };
}
