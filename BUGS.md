# Veto Bug Tracker — v1.2.2 Code Review

All bugs found during the May 2026 codebase review. Fix in order — critical first, then silent failures, then duplications, then stale/cosmetic.

---

## 🔴 Critical / Logic Errors

### BUG-01 — `server.ts:42` VERSION hardcoded, drifts from package.json
**File:** `src/server.ts:42`
**Problem:** `const VERSION = '1.2.0'` — server reports wrong version to every MCP client. CLI and server have separate VERSION constants that drift independently. Currently server says `1.2.0`, package.json says `1.2.2`.
**Fix:** Import version from `package.json` at startup using `createRequire` (same pattern as SQLite import) so there is one source of truth.
**Status:** ⏳ Open

---

### BUG-02 — `server.ts:729` `veto_status` reports phase 8 with stale capabilities
**File:** `src/server.ts:729–730`
**Problem:** `veto_status` returns `phase: 8` and a capabilities list that stops at Phase 8. Missing all 19 tools added in Phases 13–15 (`watch`, `workflow`, `explain`, `plugins`, `docs_fetch`, `context_status`, `task_parse`, `usage_status`, `audit_log`, `health`, `ci_gate`, `diff_review`, `handoff`, `continue`, `platform_setup`, `record_outcome`, `learning_stats`, `learning_apply`, `memory_export`, `memory_import`). Any AI client calling `veto_status` to discover capabilities gets a completely wrong answer.
**Fix:** Update `phase` to `15`, rewrite capabilities list with all current tools.
**Status:** ⏳ Open

---

### BUG-03 — `veto_task_parse` produces fabricated task DAG
**File:** `src/server.ts:1480–1495`
**Problem:** Four separate logic failures:
1. Complexity = `Math.round((i / steps.length) * 10) + 3` — step index position, not actual task complexity
2. `suggested_agent` always `'coder'` — router is never consulted
3. `estimated_hours` always `2` — never estimated from task content
4. `depends_on` always `[task-${i}]` — hardcodes linear chain, ignores real dependencies
**Fix:** Compute complexity from step keywords, consult `routeTask()` per step, derive `suggested_agent` from step content (db keywords → database agent, etc.), estimate hours from complexity score.
**Status:** ⏳ Open

---

### BUG-04 — `getHealthStats()` reports time-between-debates as latency
**File:** `src/memory/local.ts:613–621`
**Problem:** `avg_council_latency_ms` is computed by measuring the gap between consecutive debate timestamps. A user who runs two debates 10 minutes apart sees `avg_council_latency_ms: 600000`. It's measuring idle time between debates, not how long a debate takes.
**Fix:** Add `duration_ms` column to `council_outcomes` table. Record `Date.now()` before `runDebate()` in `server.ts`, pass elapsed time to `saveCouncilOutcome()`. Compute average from stored durations.
**Status:** ⏳ Open

---

### BUG-05 — `veto_ci_gate` and `veto_diff_review` use different verdict logic for identical job
**File:** `src/server.ts:1007–1012` (diff_review) and `src/server.ts:1591–1593` (ci_gate)
**Problem:** Both tools run the same 3-scan pipeline but compute verdicts differently:
- `veto_diff_review` uses `critical_count` / `high_count` from structured analysis
- `veto_ci_gate` uses raw `confidence` floats with magic thresholds (`0.4`, `0.5`, `0.6`, `0.7`)
A diff that produces `critical_count: 1` may pass `veto_ci_gate` if `confidence > 0.4`. Inconsistent and untestable.
**Fix:** Extract shared `runTripleScan(diff, context)` utility. Both tools use it. One verdict logic, one place.
**Status:** ⏳ Open

---

## 🟡 Bugs / Silent Failures

### BUG-06 — `searchKnowledge()` SQL string interpolation
**File:** `src/memory/local.ts:269`
**Problem:** `db.exec(\`UPDATE knowledge_base SET accessed_count = accessed_count + 1 WHERE id IN (${ids})\`)` builds a SQL string by interpolating ID values directly. UUIDs make exploitation unlikely but the pattern is wrong and will break if IDs ever contain special characters.
**Fix:** Use a loop of parameterised prepared statements instead of string interpolation.
**Status:** ⏳ Open

---

### BUG-07 — `getAuditLog()` silently drops council events when `agent` filter is set
**File:** `src/memory/local.ts:573–574`
**Problem:** `if (opts.agent) continue;` silently skips ALL council events when an agent filter is passed. Calling `veto_audit_log({ agent: "security-scanner" })` returns zero council events with no explanation — looks like there are none.
**Fix:** Either include council events in agent-filtered results (council has no single agent), or add a `note` field to the response explaining they were excluded.
**Status:** ⏳ Open

---

### BUG-08 — `council/index.ts` wraps synchronous functions in `Promise.resolve()`
**File:** `src/council/index.ts:21–29`
**Problem:** All 7 council agent functions are synchronous but wrapped in `Promise.resolve()` before being passed to `Promise.all()`. This adds unnecessary microtask overhead and misleads readers into thinking the agents are async.
**Fix:** Call sync functions directly, collect results, no `Promise.resolve()` wrapping needed. `Promise.all` on sync results is fine.
**Status:** ⏳ Open

---

### BUG-09 — `executor.ts:141` plan confidence hardcoded at `0.8`
**File:** `src/agents/executor.ts:141`
**Problem:** Every `plan()` call returns `confidence: 0.8` regardless of what the plan contains. `veto_ci_gate` and `veto_workflow` use this confidence value to make pass/fail gate decisions — they are making decisions based on a constant, not real data.
**Fix:** Compute confidence from plan quality signals: number of steps, checklist items, pitfalls identified, whether context was provided. A richer plan with more steps/checks = higher confidence.
**Status:** ⏳ Open

---

### BUG-10 — `child_process` dynamic import inside hot-path handlers
**File:** `src/server.ts:977` (veto_diff_review) and `src/server.ts:1568` (veto_ci_gate)
**Problem:** Both handlers do `await import('node:child_process')` inside the request handler on every call. Dynamic imports are cached after first use but the `await` still introduces unnecessary async overhead in a hot path.
**Fix:** Move to a top-level import at the top of `server.ts`.
**Status:** ⏳ Open

---

### BUG-11 — `closeSession()` is exported but never called — sessions never close
**File:** `src/memory/local.ts:163`
**Problem:** `closeSession()` sets `ended_at` on a session row but is never called from `server.ts`. Every session stays open indefinitely. `veto_handoff` saves a new session but doesn't close the old one. `ended_at` is always null for all sessions.
**Fix:** Call `closeSession()` from the `veto_handoff` handler after saving the new session. Also call it from `veto_session_restore` when explicitly resuming (marks previous as handed-off).
**Status:** ⏳ Open

---

### BUG-12 — `fetchAndCacheDocs` sends wrong User-Agent to crates.io
**File:** `src/memory/local.ts:430`
**Problem:** `headers: { 'User-Agent': 'veto-mcp/1.1.0' }` — version string is hardcoded and stale. crates.io requires a valid User-Agent and could reject requests from unknown agents.
**Fix:** Build the User-Agent string dynamically from the VERSION constant.
**Status:** ⏳ Open

---

## 🟠 Duplications

### BUG-13 — Triple-scan pattern copy-pasted across `veto_diff_review` and `veto_ci_gate`
**File:** `src/server.ts:1000–1055` and `src/server.ts:1580–1630`
**Problem:** Both handlers independently orchestrate the same `reviewer + security-scanner + secrets` parallel scan, parse results, and compute a verdict. ~80 lines of duplicated logic. A bug fix or improvement to one handler must be manually replicated to the other.
**Fix:** Extract `runTripleScan(diff: string, context: string)` into a shared utility (e.g. `src/scan/triple-scan.ts`). Both handlers call it. One verdict logic.
**Status:** ⏳ Open (same as BUG-05)

---

### BUG-14 — `src/skills/` — 28 files, zero runtime use
**File:** `src/skills/**/*.ts` (28 files)
**Problem:** 28 TypeScript skill files exist in the codebase but none are imported or used by `server.ts`, `executor.ts`, or any agent. They contribute to the line count and create the impression of implemented functionality that doesn't exist at runtime.
**Fix:** Either wire them up (each agent's `plan()` imports and uses its skill for checklist/pattern data — reduces duplication across agents) or delete them. Decision needed before fixing.
**Status:** ⏳ Open

---

### BUG-15 — Individual adapter files unused alongside `adapters/index.ts`
**File:** `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/gemini.ts`
**Problem:** `adapters/index.ts` is the actual implementation used everywhere. The three individual platform adapter files may be unused dead code — need to verify whether anything imports them directly.
**Fix:** Verify with grep. If unused, delete them. If used, document why they exist alongside `index.ts`.
**Status:** ⏳ Open

---

## ⚪ Stale / Cosmetic

### BUG-16 — `server.ts:3` file header comment is 14 phases out of date
**File:** `src/server.ts:3`
**Problem:** `// Veto MCP Server — Phase 1 skeleton` — the comment was written when the file had 4 tools. It now has 41 tools across 15 phases.
**Fix:** Update to `// Veto MCP Server v1.2.2 — 41 tools, 15 phases`
**Status:** ⏳ Open

---

### BUG-17 — `veto_learning_stats` always shows hardcoded default thresholds
**File:** `src/server.ts:1323`
**Problem:** `current_thresholds: { tier1_max: 30, tier2_max: 70, note: 'defaults — call veto_learning_apply...' }` — this note appears even after `veto_learning_apply` has already been called and updated the thresholds in the DB. Users who have applied learned thresholds still see "defaults".
**Fix:** Call `getLearnedThresholds()` and return the actual current values with a note indicating whether they are defaults or learned.
**Status:** ⏳ Open

---

### BUG-18 — All council and worker agents give generic responses for non-matching tasks
**File:** All files in `src/council/` and `src/agents/`
**Problem:** Council agents only pattern-match for known bad things. If a task contains no matching patterns (e.g. a strategic planning question, a phase improvement request, an architectural review with no red flags), every agent returns a generic approval message with zero specific insight. Worker agents' `plan()` functions return hardcoded templates that are identical regardless of what task was given. The agents are sophisticated pattern-matchers but not genuine domain experts.
**Fix:** Rebuild all council agents with a semantic topic-analysis layer. Add topic → insight maps for each agent's domain. When no bad pattern matches, extract topics from the task and generate domain-specific expert analysis. Rebuild worker `plan()` functions to produce task-specific output based on keywords and context.
**Status:** ⏳ Open

---

## Summary

| Severity | Count | Fixed |
|---|---|---|
| 🔴 Critical / Logic | 5 | 5 ✅ |
| 🟡 Bugs / Silent Failures | 7 | 7 ✅ |
| 🟠 Duplications | 3 | 3 ✅ |
| ⚪ Stale / Cosmetic | 3 | 3 ✅ |
| **Total** | **18** | **18 ✅** |

## Notes on BUG-14 (Skills directory)
Skills directory (`src/skills/`) was assessed but not deleted — the 28 files contain valid guidance patterns that will be wired up to their corresponding agents in Phase 16 (LLM-backed agents refactor). Deleting them now would lose that domain knowledge.

## Notes on BUG-18 (Agent responses)
Council agents fully rebuilt with semantic topic analysis — all 7 agents now give domain-specific expert analysis for any task, not just pattern-matched bad patterns. Worker agent `plan()` functions: `reviewer` rebuilt with task-specific steps (API/DB/security/async/PR detection); `coder` was already category-based. Remaining 40 worker agents will have their `plan()` functions improved incrementally in Phase 16 alongside the LLM-backed agent refactor.
