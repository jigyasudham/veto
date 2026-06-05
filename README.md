# veto

> **89 agentic tools. 49 specialists. 4 AIs. Self-learning. Zero extra cost on subscriptions.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Cursor, Windsurf, Zed, and JetBrains using your existing subscriptions — giving every AI a council of specialist agents, local LLM support, SDD agents, playwright automation, persistent cross-platform memory, a self-learning router that re-tunes its tier thresholds automatically every 20 recorded task outcomes (reviews record outcomes for you; configurable via `auto_apply_learning`), CI/CD gates, workspace discovery, and bidirectional IDE communication.

> **Billing note:** "Zero cost" applies to subscription plans (Claude Max, Gemini Advanced, etc.). If you are on API/pay-per-token billing, MCP Sampling calls made by Veto agents will count toward your token usage. `veto init` detects API key environment variables and warns you automatically.

---

## How the Agents Work

**Every tool uses a 2-phase agentic loop — no API keys required, zero extra cost.**

### Phase 1 — MCP Sampling
The tool attempts real LLM reasoning via MCP Sampling (`server.createMessage`). If your client supports it, the agent reasons deeply and returns a structured plan or analysis.

### Phase 2 — Agentic Fallback
If Sampling is unavailable, Veto returns an `llm_upgrade` prompt. The host AI reads the specialist's role, performs the reasoning itself, and passes the JSON response back to complete the operation.

Every worker agent supports both modes. When multiple agents run, they execute in parallel. LLM calls delegate back to the AI you're already using — no extra billing.

---

## Specialist Roles

| Agent Group | Specialist Roles |
|---|---|
| **Council** | Lead Dev · PM · Architect · UX · Devil's Advocate · Legal · Security |
| **Development** | Coder · Reviewer · Tester · Debugger · Refactor · Database · API · Frontend · Backend · DevOps · Performance · Migration |
| **Advanced** | Local LLM (Ollama) · Semantic Search · SDD Agent · Playwright · i18n Translate · a11y Advisor |
| **Intelligence** | Task Planner · Researcher · Tech Advisor · Risk Assessor · Cost Analyzer · Ethics/Bias |
| **Workflow** | File Manager · Git Agent · Search Agent · Reporter · Automation |

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

## MCP Tools (89)

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

## Which tool do I use?

Several tools overlap by design (different granularity or entry point). Quick guide:

**Reviewing code**

| You have… | Use | Note |
|---|---|---|
| A snippet or single file in hand | `veto_code_review` | not `veto_diff_review`, which reads a git diff |
| Uncommitted/changed files (git diff) | `veto_diff_review` | code + security + secrets scans in parallel |
| To gate a commit (hard-block on secrets) | `veto_pre_commit` | tuned for commit-time |
| To gate CI (exit code + pass/warn/fail) | `veto_ci_gate` | for GitHub Actions / GitLab CI |
| A deeper pre-merge/pre-ship pass (+ quality) | `veto_full_review` | richer than `veto_diff_review` |
| A GitHub PR by number/URL | `veto_pr_review` | fetches the diff, returns postable comments |

**Remembering things**

| Want to… | Use |
|---|---|
| Save/recall a solution, decision, or reference | `veto_memory_store` / `veto_memory_search` |
| Track a recurring code convention | `veto_pattern_store` / `veto_patterns_list` |
| Navigate the codebase without scanning the filesystem | `veto_project_map_get` (refresh via `veto_project_map_update`) |

**Running multi-step work**

| Want to… | Use |
|---|---|
| Run several agents at once on one task | `veto_execute_parallel` |
| Run a sequential pipeline with pass/fail gates | `veto_workflow` |
| Turn a PRD / plain English into a task DAG | `veto_task_parse` (feeds `veto_workflow`) |
| Plan a new feature end-to-end (council → plan → tasks) | `veto_new_feature` |

**Sessions**

| Want to… | Use |
|---|---|
| Resume work with full saved context | `veto_session_restore` (or `veto_continue` for the latest) |
| See the event / tool-call timeline of a session | `veto_session_replay` |
| Move work to another AI tool | `veto_handoff` → `veto_continue` |

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
veto help --troubleshoot         # Full troubleshooting guide
```

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
  ✓ Antigravity CLI — registered
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
    devil:     { verdict: "warn",    reason: "What if the refresh token store goes down at 2AM?", concerns: ["Redis outage = all users logged out"], recommendation: "Fallback to session auth if Redis is down; use short rotation window" },
    legal:     { verdict: "approve", reason: "JWTs are industry standard, no new compliance risk", concerns: [], recommendation: "Document token storage in privacy policy" },
    security:  { verdict: "warn",    reason: "Refresh token rotation must be atomic — TOCTOU risk", concerns: ["localStorage storage of access token is XSS-vulnerable"], recommendation: "Store access token in memory only; refresh token in httpOnly Secure SameSite=Strict cookie" }
  }
}
→ {
    llm_backed: true,
    final_verdict: "YELLOW",
    warnings: ["Refresh token rotation must be atomic...", "What if the refresh token store goes down..."],
    recommended: "Proceed with JWT. Use httpOnly cookies for refresh tokens, memory-only for access tokens..."
  }
```

### Council `strictness`

```
veto_council_debate { task: "...", strictness: "fast" }     # 3 agents, instant
veto_council_debate { task: "...", strictness: "standard" } # 7 agents, default
veto_council_debate { task: "...", strictness: "strict" }   # 7 + devil rebuttal
```

---

## Session Tagging + Search

```
veto_session_save {
  auto_summarize: true,
  tags: ["auth", "jwt", "middleware"]
}

veto_sessions_list { query: "auth" }
→ sessions matching "auth" in summary, context, tags, or project_dir
```

Token usage is manually reported — pass `token_count` to `veto_status` or `veto_session_save` and Veto stores it per platform per day. `veto_rate_status` shows what you've reported; nothing is counted automatically.

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

Platform switching is manual — Veto surfaces which platform has budget remaining via `veto_rate_status`, you decide when to switch.

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

## Project Structure

Veto is a single MCP server (`src/server.ts`) that registers 89 tools, MCP Resources, and Prompts, then dispatches every tool call through a per-domain **handler registry** — there is no monolithic switch. Each domain owns a `HandlerMap` module under `src/server/handlers/`:

| Module | Tools | Domain |
|---|---|---|
| `workers.ts` | 15 | single-agent worker delegations (code_review, security_scan, explain, …) |
| `generators.ts` | 11 | single-agent artifact generators (adr, diagram, rca, doc_gen, onboard, …) |
| `memory.ts` | 9 | knowledge base, patterns, project map |
| `observability.ts` | 7 | health, metrics, usage, audit, context/rate status |
| `advisors.ts` | 7 | project scanners (dep, query, bundle, dead-code, flag, openapi, HITL) |
| `session.ts` | 6 | save · restore · list · handoff · continue · replay |
| `review.ts` | 5 | diff · ci · pr · full review + pre-commit pipelines |
| `git.ts` | 5 | blame · changelog · commit message · PR description/post |
| `core.ts` | 5 | status · routing · platform setup · docs fetch · discover |
| `agents.ts` | 5 | agent_plan · execute_parallel · delegate · workflow · task_parse |
| `devtools.ts` | 5 | plugins · local LLM · clone detector · compose · notify IDE |
| `council.ts` | 3 | council_debate · benchmark · new_feature |
| `learning.ts` | 3 | record_outcome · learning_stats · learning_apply |
| `watch.ts` | 3 | watch · poll · stop |

Shared, independently testable internals live in `src/server/`:

- `registry.ts` — the `ToolContext` (`{ request, args, server }`) and `HandlerMap` types
- `runtime.ts` — shared mutable state (active project dir, auto-save, server health, `VERSION`)
- `scan-core.ts` — git-diff reader, triple-scan, and the agentic worker loop (unit-tested)

Every handler module is importable in isolation, so behaviour is covered by `tests/server/dispatch.test.ts` (the `callTool` behavioral net) and `tests/tools/definitions.test.ts` (the 89-tool registry-coverage check).

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+ (built-in `node:sqlite` — no native compilation)
- **Dependencies:** `@modelcontextprotocol/sdk` only — one package, zero native addons
- **Memory:** Local SQLite — zero config, works offline, portable via JSON export
- **Platforms:** Claude Code · Gemini CLI · Antigravity CLI · Codex CLI · Cursor · Windsurf · Zed

---

## License

MIT © 2026 Jigyasu Dham
