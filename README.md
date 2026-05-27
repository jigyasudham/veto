# veto

> **62 agentic tools. 50+ specialists. 4 AIs. Self-learning. Zero cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Cursor, Windsurf, Zed, Copilot, and JetBrains using your existing subscriptions — giving every AI a council of specialist agents, local LLM support, SDD agents, playwright automation, persistent cross-platform memory, a self-learning router, CI/CD gates, workspace discovery, and bidirectional IDE communication.

---

## How the Agents Actually Work

**Veto v2.0 is now 100% Agentic.**

Every tool in Veto uses a **2-phase agentic loop pattern** — no API keys required, zero extra cost, working identically across Claude Code, Gemini CLI, Antigravity CLI, and Codex CLI.

### The 2-Phase Agentic Loop
1.  **Phase 1 (Sampling):** The tool first attempts real LLM reasoning via **MCP Sampling** (the host AI's native ability to "create a message"). If supported by your client (like Claude Code or Gemini CLI), the agent performs deep reasoning and returns a structured plan or analysis instantly.
2.  **Phase 2 (Upgrade Prompt):** If Sampling is unavailable or fails, Veto returns an `llm_upgrade` prompt. You (the host AI) read the specialist's role and task, perform the reasoning yourself, and pass the JSON response back to complete the operation.

### Specialist Roles
Veto provides a council of 7 senior governance agents plus 55+ domain-specific worker agents.

| Agent Group | Specialist Roles |
|---|---|
| **Council** | Lead Dev · PM · Architect · UX · Devil's Advocate · Legal · Security |
| **Development** | Coder · Reviewer · Tester · Debugger · Refactor · Database · API · Frontend · Backend · DevOps · Performance · Migration |
| **Advanced** | Local LLM (Ollama) · Semantic Search · SDD Agent · Playwright · i18n Translate · a11y Advisor |
| **Intelligence** | Task Planner · Researcher · Tech Advisor · Risk Assessor · Cost Analyzer · Ethics/Bias |
| **Workflow** | File Manager · Git Agent · Search Agent · Reporter · Automation |

### All 62 Tools are now 100% Agentic

Every worker agent supports two modes: **LLM-backed** (via MCP Sampling, opt-in per task) and **deterministic fallback** (instant, offline, zero tokens). When multiple agents run, they execute in parallel. No extra API keys or billing — LLM calls delegate back to the AI you're already using.

**Development (12)**
`Coder` · `Code Reviewer` · `Tester` · `Debugger` · `Refactor` · `Database` · `API` · `Frontend` · `Backend` · `DevOps` · `Performance` · `Migration`

**Security (6)**
`Security Scanner` · `Auth Agent` · `Data Privacy` · `Secrets Agent` · `Dependency Audit` · `Penetration Tester`

**Memory (5)**
`Context Manager` · `Decision Logger` · `Project Mapper` · `Pattern Learner` · `Knowledge Base`

**Research (7)**
`Researcher` · `Tech Advisor` · `Cost Analyzer` · `Competitor Analyzer` · `Risk Assessor` · `Estimator` · `Ethics & Bias`

**Quality (5)**
`Code Quality` · `Documentation` · `Accessibility` · `Compatibility` · `Error Handling`

**Workflow (7)**
`Task Planner` · `Task Coordinator` · `File Manager` · `Git Agent` · `Search Agent` · `Reporter` · `Automation`

---

## MCP Tools (62)

| Category | Tools |
|---|---|
| **Session** | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` · `veto_autosave_status` · `veto_session_replay` |
| **Router** | `veto_route_task` · `veto_rate_status` |
| **Council** | `veto_council_debate` · `veto_benchmark` · `veto_adr` |
| **Agents** | `veto_agent_plan` · `veto_execute_parallel` · `veto_explain` · `veto_compose_agents` · `veto_delegate` |
| **Review** | `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_diff_review` · `veto_full_review` · `veto_pr_review` |
| **Pipelines** | `veto_pre_commit` · `veto_new_feature` · `veto_workflow` · `veto_task_parse` |
| **Advanced** | `veto_local_llm` · `veto_semantic_search` · `veto_sdd_agent` · `veto_playwright` · `veto_notify_ide` |
| **Quality** | `veto_clone_detector` · `veto_lint_rules` · `veto_api_contract` · `veto_a11y_advisor` · `veto_type_coverage` · `veto_test_gaps` |
| **Watching** | `veto_watch` · `veto_watch_poll` · `veto_watch_stop` |
| **Memory** | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| **Learning** | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| **Handoff** | `veto_handoff` · `veto_continue` · `veto_platform_setup` |
| **Observability** | `veto_usage_status` · `veto_audit_log` · `veto_health` · `veto_metrics` |
| **Discover** | `veto_discover` · `veto_summarize` · `veto_git_blame` · `veto_changelog` · `veto_onboard` · `veto_debt_register` |
| **DevTools** | `veto_docs_fetch` · `veto_context_status` · `veto_openapi_gen` · `veto_flag_auditor` · `veto_env_setup` · `veto_commit_message` · `veto_pr_description` · `veto_pr_post` · `veto_prompt_optimizer` · `veto_sre_advisor` · `veto_diagram` · `veto_rca` · `veto_translate` · `veto_merge_conflict` |
| **Plugins** | `veto_plugins` |

## MCP Resources

| URI | What it returns |
|---|---|
| `veto://sessions` | All saved sessions across platforms |
| `veto://project-map?dir=<path>` | Stored project structure map |
| `veto://memory?q=<query>` | Knowledge base search results |
| `veto://patterns` | Learned coding patterns |

## MCP Prompts

| Prompt | What it does |
|---|---|
| `code-review` | Full code review — paste code, get scored findings |
| `security-audit` | OWASP Top 10 scan with CWE references |
| `deploy-checklist` | Council reviews your deployment plan before you ship |
| `explain-file` | Expert explanation of any file, auto-routed by type |

---

## CLI Commands

```bash
veto init                        # Configure all AI tools + scan project
veto doctor                      # Check MCP registrations + system health
veto status                      # Version, DB path, session/memory/outcome counts
veto version                     # Alias for veto status
veto sessions                    # List last 20 saved sessions ([auto] badge on auto-saves)
veto sessions --clean            # Remove auto-saves older than 7 days
veto memory [query]              # Search knowledge base (blank = all entries)
veto patterns [prefix]           # List learned agent/routing patterns
veto hook install                # Install pre-commit secrets scan hook
veto hook remove                 # Remove the veto pre-commit hook
veto check                       # Scan staged changes for secrets (used by hook)
veto help                        # Commands + MCP tools reference
veto help --troubleshoot         # Full troubleshooting guide (14 scenarios)
```

`veto help` shows all CLI commands, all 49 MCP tool names, MCP Resources, and MCP Prompts.

### `veto doctor`

```
veto doctor

  Veto Doctor — system health check
  ─────────────────────────────────────────────────────
  ✓ Node.js v22.5.0
  ✓ ~/.veto exists
  ✓ Database ~/.veto/veto.db
    17 sessions · 12 memories · 3 patterns

  MCP Registrations
  ─────────────────────────────────────────────────────
  ✓ Claude Code — registered
  ✓ Gemini CLI — registered
  · Codex CLI — not installed
  · Zed — not installed

  ✓ All checks passed — Veto is healthy!
```

---

## Council Debate

Two-phase flow — works on Claude Code, Gemini CLI, Antigravity CLI, and Codex CLI with no API keys:

```
# Phase 1 — call with task, get instant deterministic result + LLM upgrade prompt
veto_council_debate {
  task: "migrate auth from sessions to JWTs",
  project_dir: "/your/project",
  strictness: "standard"
}
→ {
    llm_backed: false,
    final_verdict: "YELLOW",
    votes: { lead_dev: {...}, architect: {...}, security: {...}, ... },
    llm_upgrade: {
      available: true,
      instruction: "Read debate_prompt, reason as all 7 agents, call again with agent_responses",
      debate_prompt: "You are running a Veto Council debate. Analyze the task as each specialist..."
    }
  }

# Phase 2 — reason as all 7 agents, pass responses back → get LLM-backed verdict
veto_council_debate {
  task: "migrate auth from sessions to JWTs",
  agent_responses: {
    lead_dev:  { verdict: "warn",    reason: "Stateless JWTs complicate logout — need blocklist", concerns: ["Refresh token rotation must be atomic"], recommendation: "Use short-lived access tokens (15m) + httpOnly refresh tokens" },
    pm:        { verdict: "approve", reason: "JWT migration unblocks mobile clients", concerns: [], recommendation: "Ship behind a feature flag, roll back if logout issues" },
    architect: { verdict: "approve", reason: "Good fit for stateless microservice boundary", concerns: ["Clock skew can break expiry across services"], recommendation: "Add NTP sync check; use relative expiry not absolute timestamps" },
    ux:        { verdict: "approve", reason: "No user-visible change if migration is seamless", concerns: [], recommendation: "Silent migration — no logout required for existing sessions" },
    devil:     { verdict: "warn",    reason: "What if the refresh token store goes down at 2AM?", concerns: ["Redis outage = all users logged out", "Token replay attack window between rotation and invalidation"], recommendation: "Fallback to session auth if Redis is down; use short rotation window" },
    legal:     { verdict: "approve", reason: "JWTs are industry standard, no new compliance risk", concerns: [], recommendation: "Document token storage in privacy policy" },
    security:  { verdict: "warn",    reason: "Refresh token rotation must be atomic — TOCTOU risk", concerns: ["localStorage storage of access token is XSS-vulnerable"], recommendation: "Store access token in memory only; refresh token in httpOnly Secure SameSite=Strict cookie" }
  }
}
→ {
    llm_backed: true,
    final_verdict: "YELLOW",
    block_reasons: [],
    warnings: ["Refresh token rotation must be atomic...", "What if the refresh token store goes down..."],
    recommended: "Proceed with JWT. Use httpOnly cookies for refresh tokens, memory-only for access tokens..."
  }
```

When the task presents a binary choice, agents name the option they prefer and the output includes a `🎯 Council leans toward:` line:

```
veto_council_debate {
  task: "Should we add an Express HTTP layer or keep Veto pure MCP with an external adapter?"
}
→ formatted_output includes:
    🎯 Council leans toward: "pure MCP with an external adapter" (5 agents prefer it)
    Lead Dev:  [Express HTTP vs external adapter] ... [WARN]
               recommendation: Prefer "external adapter" — Express adds new infrastructure...
    Security:  [Express HTTP vs external adapter] ... [WARN]
               recommendation: Prefer "external adapter" — keeps the threat model local-only...
```

---

## Session Tagging + Search

Tag sessions when saving to make them findable later:

```
# Let Veto generate the summary from conversation context
veto_session_save {
  auto_summarize: true,
  tags: ["auth", "jwt", "middleware"]
}

# Or write it manually
veto_session_save {
  summary: "Implemented JWT auth middleware",
  context: "...",
  tags: ["auth", "jwt", "middleware"]
}

# Find it weeks later:
veto_sessions_list { query: "auth" }
→ sessions matching "auth" in summary, context, tags, or project_dir
```

---

## New in v1.4.4

### Token count now updates from `veto_session_save`

Previously, token count and context window usage only updated when `veto_status { token_count: N }` was called. Saving a session without calling status first left the VS Code extension and autosave status showing stale or zero values.

Now `veto_session_save { token_count: N }` directly:
- Calls `trackTokens()` to update the daily rate tracker
- Upserts into the new `context_usage` table with `usage_pct` computed from the model's actual context window

```
veto_session_save {
  summary: "...",
  context: "...",
  token_count: 45000,          ← now updates live display immediately
  platform: "claude",
  model: "claude-sonnet-4-6"   ← resolves exact 1M window for accurate %
}
→ { usage_pct: 4.5, auto_summarized: false, ... }
```

### `context_usage` table — live DB polling for VS Code extension

A new single-row-per-platform table in `~/.veto/veto.db` that always holds the latest known context state. Your VS Code extension can poll or watch this table directly:

```sql
SELECT platform, model, token_count, context_window, usage_pct, updated_at
FROM context_usage
ORDER BY updated_at DESC
```

Updated by both `veto_session_save` and `veto_status` whenever `token_count > 0` is passed. `veto_autosave_status` now includes `live_context_usage` in its response.

---

## New in v1.4.3

### Council debate + session save — work on Gemini CLI, Antigravity CLI, and Codex CLI

MCP Sampling (`server.createMessage`) is not yet implemented by any of the four CLI hosts. Previously this meant the council always used deterministic fallbacks and `auto_summarize` never ran on any platform.

**v1.4.3 introduces the agentic loop pattern** — no API keys, no sampling dependency, works on all four platforms identically.

#### Council debate — two-phase LLM upgrade

```
# Phase 1 — always returns an instant deterministic result
veto_council_debate { task: "migrate auth to JWT" }
→ {
    llm_backed: false,
    final_verdict: "YELLOW",
    votes: { ... },           ← deterministic agent analysis
    llm_upgrade: {
      available: true,
      instruction: "Read debate_prompt, reason as all 7 agents, call again with agent_responses",
      debate_prompt: "You are running a Veto Council debate. Analyze the task as each specialist..."
    }
  }

# Phase 2 — call again with your agent_responses → get the LLM-backed verdict
veto_council_debate {
  task: "migrate auth to JWT",
  agent_responses: {
    lead_dev:  { verdict: "warn", reason: "...", concerns: [], recommendation: "..." },
    pm:        { verdict: "approve", ... },
    architect: { verdict: "warn", ... },
    ux:        { verdict: "approve", ... },
    devil:     { verdict: "warn", ... },
    legal:     { verdict: "warn", ... },
    security:  { verdict: "warn", ... }
  }
}
→ { llm_backed: true, final_verdict: "YELLOW", votes: { ... } }
```

The host AI (Claude, Gemini, or Codex) reads the `debate_prompt`, reasons as all 7 specialists, and passes the structured JSON back. Veto runs the verdict engine on the real LLM output.

#### Session save — agentic fallback

When `auto_summarize: true` and MCP Sampling is unavailable, `veto_session_save` now returns a structured template and instructions for the calling AI to fill in and call again — instead of silently saving nothing:

```
veto_session_save { auto_summarize: true }
→ {
    mode: "agentic",
    instruction: "Generate the session summary yourself from the conversation above, then call veto_session_save again with the filled-in fields.",
    summarize_prompt: "Review the conversation above and produce a session checkpoint...",
    template: {
      auto_summarize: false,
      summary: "<one sentence describing what was accomplished>",
      context: "{ task, decisions[], findings[] with file:line }",
      task_state: "{ completed[], remaining[], nextAction: 'Edit src/X.ts line N — ...' }"
    }
  }
```

---

## New in v1.4.2

### `veto_session_save` — LLM auto-summarization

Pass `auto_summarize: true` and Veto reads the full conversation via MCP Sampling, then generates an accurate, structured session checkpoint itself — you don't write summary, context, or task_state manually.

```
# Simplest possible save — Veto does the work
veto_session_save {
  auto_summarize: true,
  project_dir: "/your/project",
  tags: ["auth", "migration"]
}
→ {
    success: true,
    auto_summarized: true,
    session_id: "abc-123",
    summary: "Implemented JWT auth middleware with refresh token rotation",
    context: {
      task: "migrate session auth to JWT",
      decisions: [{ decision: "store refresh token in httpOnly cookie", rationale: "XSS protection" }],
      findings: ["src/auth.ts:142 — refreshToken handler, needs rotation logic next"]
    },
    task_state: {
      completed: ["access token generation", "middleware wiring"],
      remaining: ["refresh token rotation", "logout blocklist"],
      nextAction: "Edit src/auth.ts line 142 — implement rotation: invalidate old refresh token, issue new one, update DB row"
    }
  }
```

Veto generates `nextAction` as a **concrete, file+line instruction** the next AI can execute without re-reading any source files. On restore, the `resume_instructions` field tells the AI to trust this and start immediately.

When MCP Sampling is unavailable (all platforms currently), returns an agentic template asking the host AI to generate the summary from the conversation and call back with filled-in fields — see v1.4.3.

---

## New in v1.4.1

### Council debate — decision-aware verdicts

When your task presents a binary architectural choice ("should we X or Y", "A vs B"), every council agent now identifies which option it prefers and names it explicitly. The output includes a `🎯 Council leans toward:` line counting how many agents favour each option.

Before — agents fired generic keyword-matched concerns unrelated to the choice:
```
Lead Dev: "Persistent memory stores grow unbounded..."  ← nothing to do with the question
```

After — agents address the specific choice:
```
Lead Dev:  [Express-bundled vs external-adapter] reason [WARN]
           recommendation: Prefer "external-adapter" — "Express-bundled" adds new
           infrastructure to maintain; validate real demand before building.
🎯 Council leans toward: "external adapter pattern" (4 agents prefer it)
```

In the agentic loop (phase 2), the host AI is explicitly instructed to name the preferred option in its recommendation for each agent role.

### `veto_session_restore` — resume instructions

The restore response now includes a `resume_instructions` field that tells the AI exactly what to do:

```
veto_session_restore { session_id: "..." }
→ {
    resume_instructions: "Context restored. Trust the summary, context, and task_state
      above. Do NOT re-read source files to orient yourself — only open a file if you
      are about to EDIT it. Start immediately with: [nextAction from task_state].",
    session_id: "...",
    summary: "...",
    context: { ... },
    task_state: { nextAction: "Edit src/server.ts line 302, add zod validation..." },
    ...
  }
```

This fixes the core issue where AI sessions were re-reading the entire codebase on restore instead of trusting the saved context.

### `veto_session_save` — input validation

`summary`, `context`, and `task_state` now have enforced size limits. Oversized inputs are truncated with a warning rather than silently stored or crashing.

| Field | Limit |
|---|---|
| `summary` | 2,000 chars |
| `context` | 50,000 chars |
| `task_state` | 20,000 chars |

```
veto_session_save { summary: "...(very long)..." }
→ { success: true, truncation_warnings: ["summary truncated to 2000 chars (was 8432)"] }
```

---

## New in v1.4.0

### `veto_metrics` — usage dashboard

```
veto_metrics {}
→ {
    sessions: { total: 45, today: 2, this_week: 8 },
    council:  { total: 24, today: 1, by_verdict: { GREEN: 12, YELLOW: 9, RED: 3 } },
    agents:   [ { agent: "coder", calls: 38, avg_quality: 86 }, ... ],
    quality:  { overall_avg: 86, trend: [{ date: "2026-05-17", avg: 89, count: 5 }] },
    knowledge:{ total_entries: 12, by_type: { solution: 6, decision: 4, pattern: 2 } },
    patterns: { total: 10 }
  }
```

### `veto_changelog` — git changelog

```
veto_changelog { project_dir: "/your/project" }
→ {
    since_tag: "v1.3.0",
    total_commits: 23,
    sections: [
      { section: "Features",    items: [{ message: "Add council strictness param", hash: "a3f2b1c0", ... }] },
      { section: "Bug Fixes",   items: [...] },
      { section: "Refactoring", items: [...] }
    ]
  }
```

### `veto_git_blame` — ownership data

```
veto_git_blame { file_path: "/your/project/src/auth.ts" }
→ {
    path: "/your/project/src/auth.ts",
    total_commits: 14,
    contributors: [
      { commits: 9, author: "Jigyasu Dham" },
      { commits: 5, author: "contributor" }
    ],
    last_modified_at: "2026-05-16 18:30:00 +0530",
    last_author: "Jigyasu Dham",
    last_commit_message: "fix: JWT expiry check for clock skew"
  }
```

### `veto_explain` — now accepts raw text

```
# Error message / stack trace
veto_explain { text: "TypeError: Cannot read properties of undefined (reading 'id')\n  at auth.ts:42" }
→ debugger agent explains the error and suggests root causes

# Still works for files
veto_explain { file_path: "/your/project/src/auth.ts", depth: "detailed" }
```

### Council `strictness` parameter

```
veto_council_debate { task: "...", strictness: "fast" }   # 3 agents, instant
veto_council_debate { task: "...", strictness: "standard" } # 7 agents, default
veto_council_debate { task: "...", strictness: "strict" }   # 7 + devil rebuttal
```

---

## Workspace Discovery

```
veto_discover { "project_dir": "/your/project" }
→ {
    git:        { branch: "main", commit: "a3f2b1", dirty_files: [], recent_commits: [...] },
    ecosystems: { node: "my-app v2.1.0" },
    tech_stack: ["TypeScript", "React", "Prisma"],
    key_files:  ["tsconfig.json", "prisma/schema.prisma", ".env.example"],
    total_files: 142
  }
```

---

## Diff Review

```
veto_diff_review { project_dir: "/your/project" }
→ {
    verdict: "warn",
    files_changed: 4,
    code_review: { score: 78, critical: 0, high: 2, findings: [...] },
    security:    { score: 91, critical: 0, high: 0, findings: [...] },
    secrets:     { findings: [] },
    summary: "⚠️  WARN — 4 file(s) changed..."
  }
```

---

## Sequential Pipelines

```
veto_workflow {
  steps: [
    { id: "code",     agent: "coder",           task: "implement auth middleware", gate: 70 },
    { id: "review",   agent: "reviewer",         task: "review the implementation", gate: 75 },
    { id: "security", agent: "security-scanner", task: "scan for vulnerabilities",  gate: 80 },
    { id: "test",     agent: "tester",           task: "write test cases" }
  ],
  project_dir: "/your/project"
}
→ { verdict: "passed", steps_passed: 4, steps_failed: 0, results: [...] }
```

---

## Self-Learning Router

Every agent tool auto-records a quality signal when it completes. After any working session, `veto_learning_stats` shows live data and `veto_learning_apply` adjusts tier thresholds automatically after ~20 calls.

```bash
veto_route_task { task: "debug auth issue", file_ext: ".ts" }
→ { ..., recommended_agent: "debugger" }   # ← predicted from history
```

---

## Plugin System

```js
// ~/.veto/agents/my-agent.js
export function plan(task, context) {
  return {
    agent: 'my-agent', task, tier: 2,
    approach: 'Your custom approach...',
    steps: ['Step 1', 'Step 2'],
    checklist: ['[ ] Check 1'],
    pitfalls: ['Pitfall 1'],
    patterns: ['Pattern 1'],
    duration_estimate: '1-2 hours',
  };
}
```

---

## Cross-Platform Handoff

```
Claude at 90%  →  veto_handoff { summary, context }
Open Gemini    →  veto_continue { resuming_as: "gemini" }
Full context restored. Continue exactly where you stopped.
```

Token usage is manually reported — pass `token_count` to `veto_status` or `veto_session_save` and Veto stores it per platform per day. `veto_rate_status` shows what you've reported; nothing is counted automatically. Platform switching is also manual — Veto surfaces which platform has budget remaining, you decide when to switch.

| Platform | Support |
|---|---|
| Claude Code | ✅ Native MCP |
| Gemini CLI | ✅ MCP support |
| Antigravity CLI | ✅ MCP support |
| Codex CLI | ✅ MCP support |
| Cursor | ✅ MCP support |
| Windsurf | ✅ MCP support |
| Zed | ✅ MCP support (`context_servers`) |

---

## Roadmap

| Phase | Status | Version |
|---|---|---|
| 1–12 — Foundation through CLI + Diff Review | ✅ Complete | v0.1.0 – v1.0.0 |
| 13 — Developer Intelligence + Auto Docs | ✅ Complete | v1.1.0 |
| 14 — Observability + Usage Stats + Audit Log | ✅ Complete | v1.2.0 |
| 15 — CI/CD Gates + GitHub PR Review | ✅ Complete | v1.2.5 |
| 16 — Workspace Discovery + Summarization + Doctor | ✅ Complete | v1.2.8 |
| 17 — VS Code Extension + Token Budget + Risk Annotations | ✅ Complete | v1.2.14 |
| 18 — Extension Upgrades | ✅ Complete | veto-vscode v0.6.0 |
| 19 — Auto-Learning Hooks | ✅ Complete | v1.2.15 |
| 20 — Auto-Store Memory on RED | ✅ Complete | v1.2.16 |
| 21 — Closing the Loop (auto-thresholds, pre-commit hook, benchmark) | ✅ Complete | v1.2.18 |
| 22 — LLM Council (MCP Sampling, per-model context windows) | ✅ Complete | v1.3.0 |
| 23 — Quality + Features (TTL cache, metrics, git blame, changelog, Zed, session tags) | ✅ Complete | v1.4.0 |

---

## Changelog

### v1.4.0
- **feat:** `veto_metrics` — live usage dashboard (sessions, council verdicts, top agents, quality trend, knowledge stats). Pure SQLite reads, zero cost.
- **feat:** `veto_changelog` — structured changelog from git history since last tag, grouped by conventional commit type.
- **feat:** `veto_git_blame` — file/directory ownership data from local git (contributors, commit counts, last-modified metadata).
- **feat:** Council `strictness` param — `fast` (3 core agents, instant) / `standard` (7 agents, default) / `strict` (7 + Devil's Advocate rebuttal round on most critical blocker).
- **feat:** Session tagging — `veto_session_save` accepts `tags: string[]`; `veto_sessions_list` accepts `query` for full-text search across summary, context, tags, and project_dir.
- **feat:** Zed editor support — `veto init` now auto-configures Zed via `~/.config/zed/settings.json` (`context_servers` key).
- **feat:** `veto_explain` accepts raw `text` — error messages, stack traces, and compiler output are auto-routed to the debugger agent.
- **fix:** `task_plans` TTL — cached plans older than 7 days are no longer returned; `veto_task_parse` checks cache before running the planner agent.
- **fix:** Complexity scorer — word-count cap raised from 20→25 pts; +5 bonus for tasks over 60 words.
- **fix:** Path sanitization — `readProjectContext` now validates that the resolved path is a directory before running any `git` commands.
- **refactor:** Tool definitions extracted from `server.ts` into `src/tools/definitions.ts` (49 tools, grouped by category). `server.ts` reduced from 2640 → 1907 lines.

### v1.3.0
- **feat:** Council agents are now LLM-backed via MCP Sampling — all 7 agents call the host LLM in parallel and return real reasoning, not deterministic templates. Deterministic fallback per agent if sampling is unavailable.
- **feat:** Full agent reasoning returned — `votes` now includes each agent's complete `reason`, `concerns`, and `recommendation`.
- **feat:** Knowledge retrieval pre-hook — council searches `knowledge_base` for similar past decisions before each debate.
- **feat:** `veto_benchmark` runs two LLM council debates in parallel.
- **feat:** Auto-store on YELLOW — significant YELLOW verdicts now stored in knowledge base with per-agent reasoning.
- **feat:** Per-model context windows — `veto_status` and `veto_session_save` accept `model` param for exact window resolution.

### v1.2.19
- **fix:** `veto_session_save` accepts optional `session_id` — updates that row in-place instead of inserting a new one.

### v1.2.18
- **feat:** Auto-apply learned thresholds after every 20 `autoRecord()` calls.
- **feat:** `veto hook install` / `veto hook remove` — pre-commit secrets scan hook.
- **feat:** `veto check` — fast secrets scan on staged changes.
- **feat:** `veto_benchmark` (tool #46) — two approaches → two parallel council debates → structured winner.

### v1.2.17
- **fix:** `veto version` no longer shows "Unknown command".
- **fix:** Unknown commands show a short 2-line error.
- **fix:** `veto help` is now ~50 lines; full troubleshooting moved to `veto help --troubleshoot`.
- **feat:** Sessions track `save_type` (`manual` | `auto`); `veto sessions --clean` removes old auto-saves.

### v1.2.15 – v1.2.16
- Auto-learning hooks — `learning_data` fills automatically from every agent-producing tool.
- Auto-store knowledge entries on RED council verdict and critical scan failures.

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+ (built-in `node:sqlite` — no native compilation)
- **Dependencies:** `@modelcontextprotocol/sdk` only — one package, zero native addons
- **Memory:** Local SQLite — zero config, works offline, portable via JSON export
- **Platforms:** Claude Code · Gemini CLI · Codex CLI · Cursor · Windsurf · Zed

---

## License

MIT © 2026 Jigyasu Dham
