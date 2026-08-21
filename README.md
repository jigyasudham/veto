# veto

[![npm version](https://img.shields.io/npm/v/@jigyasudham/veto)](https://www.npmjs.com/package/@jigyasudham/veto)
[![npm downloads](https://img.shields.io/npm/dt/@jigyasudham/veto)](https://www.npmjs.com/package/@jigyasudham/veto)
[![license](https://img.shields.io/npm/l/@jigyasudham/veto)](https://github.com/jigyasudham/veto/blob/main/LICENSE)

> **93 agentic tools. 49 specialists. Every major AI CLI. Self-learning. Zero extra cost on subscriptions.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Cursor, Windsurf, Zed, and JetBrains using your existing subscriptions — giving every AI a council of specialist agents, local LLM support, SDD agents, playwright automation, persistent cross-platform memory, a self-learning router that re-tunes its tier thresholds automatically every 20 recorded task outcomes (reviews record outcomes for you; configurable via `auto_apply_learning`), CI/CD gates, workspace discovery, and bidirectional IDE communication.

> **Billing note:** "Zero cost" applies to subscription plans (Claude Max, Gemini Advanced, etc.). If you are on API/pay-per-token billing, LLM reasoning done for Veto agents (via the agentic loop or MCP Sampling) counts toward your token usage like any other turn. `veto init` detects API key environment variables and warns you automatically.

---

## Getting Started

```bash
# 1. Install the CLI — puts the bare `veto` command on your PATH
npm i -g @jigyasudham/veto

# 2. Register Veto with every AI client you use (Claude Code, Gemini, Codex, Cursor, …)
veto init
```

Prefer not to install anything? Every command also works via npx:

```bash
npx -y @jigyasudham/veto@latest init
```

The two are independent by design. `veto init` writes MCP configs that launch the server with `npx -y --package @jigyasudham/veto@latest veto-server` — npx re-resolves `@latest` against the registry on every client restart, so the **MCP server auto-updates itself** and a global copy can never pin it to an old version. The **global install only provides the CLI** (`veto doctor`, `veto sessions`, the statusline, …); keep it current with `npm i -g @jigyasudham/veto@latest` when `veto doctor` says it's behind.

---

## How the Agents Work

**No API keys, zero extra cost.** Every worker agent is a deterministic expert module at its core, with two optional layers of LLM reasoning on top — all of it delegated to the AI you're already paying for.

### Default — Deterministic expert modules
Out of the box, each of the 42 worker agents runs as a hand-written expert module (`plan()` / `analyze()` in `src/agents/`) — **not** an LLM. They always run, work offline, and cost zero tokens. Their depth varies by design: analysis agents (security scanner, secrets, dependency audit, clone detector, privacy, auth, performance, compatibility, …) apply real algorithms — regex/AST detection, OWASP/CWE rules, hash-based clone matching — while planning agents (coder, debugger, tester, …) are structured expert playbooks: curated steps, checklists, and pitfalls for the task category, built to be reasoned over by the AI you already pay for rather than to reason themselves.

### Path A — Agentic loop (most clients: Claude Code, Cursor, Windsurf)
Veto returns the specialist's role, rubric, and an output contract as an `llm_upgrade` prompt. The host AI reasons as the specialist and passes structured JSON back to complete the operation. This is the primary path — it costs nothing beyond your existing subscription and works on every client.

### Path B — MCP Sampling (clients that support `server.createMessage`)
Where Sampling is available, the same upgrade happens server-side without the extra round-trip. Note: the July 2026 MCP spec revision deprecates Sampling protocol-wide (12-month sunset), so the agentic loop (Path A) is Veto's long-term default; Sampling remains a transparent optimization where it exists.

The 7-agent **Council** is LLM-first — its value is the multi-agent debate — but it too falls back to a deterministic verdict when no LLM path is available. When multiple agents run, they execute in parallel.

---

## Specialist Roles

**49 specialists: 42 deterministic worker agents across 6 domains + a 7-agent Council.** The Council debates trade-offs before you build; the worker agents do the hands-on analysis and planning. Each is a deterministic expert module that can upgrade to LLM reasoning — see [How the Agents Work](#how-the-agents-work). List them anytime with `veto agents`.

**Council (7)**
`Lead Dev` · `PM` · `Architect` · `UX` · `Devil's Advocate` · `Legal` · `Security`

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

## MCP Tools (93)

| Category | Tools |
|---|---|
| **Session** | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` · `veto_autosave_status` · `veto_session_replay` |
| **Router** | `veto_route_task` · `veto_rate_status` |
| **Council** | `veto_council_debate` · `veto_benchmark` · `veto_adr` |
| **Agents** | `veto_agent_plan` · `veto_execute_parallel` · `veto_explain` · `veto_compose_agents` · `veto_delegate` |
| **Review** | `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_diff_review` · `veto_full_review` · `veto_pr_review` |
| **Pipelines** | `veto_ci_gate` · `veto_pre_commit` · `veto_new_feature` · `veto_workflow` · `veto_task_parse` |
| **Advanced** | `veto_local_llm` · `veto_semantic_search` · `veto_sdd_agent` · `veto_playwright` · `veto_notify_ide` |
| **Quality** | `veto_clone_detector` · `veto_lint_rules` · `veto_api_contract` · `veto_a11y_advisor` · `veto_type_coverage` · `veto_test_gaps` |
| **Advisors** | `veto_dep_advisor` · `veto_dep_verify` · `veto_query_advisor` · `veto_bundle_advisor` · `veto_dead_code` · `veto_hitl_checkpoint` · `veto_drift_check` |
| **Watching** | `veto_watch` · `veto_watch_poll` · `veto_watch_stop` |
| **Memory** | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_decisions` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| **Learning** | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| **Handoff** | `veto_handoff` · `veto_continue` · `veto_platform_setup` |
| **Observability** | `veto_usage_status` · `veto_audit_log` · `veto_health` · `veto_metrics` · `veto_snapshot` |
| **Discover** | `veto_discover` · `veto_summarize` · `veto_git_blame` · `veto_changelog` · `veto_onboard` · `veto_debt_register` |
| **DevTools** | `veto_docs_fetch` · `veto_context_status` · `veto_openapi_gen` · `veto_flag_auditor` · `veto_env_setup` · `veto_commit_message` · `veto_pr_description` · `veto_pr_post` · `veto_prompt_optimizer` · `veto_sre_advisor` · `veto_diagram` · `veto_rca` · `veto_doc_gen` · `veto_postmortem` · `veto_release_notes` · `veto_translate` · `veto_merge_conflict` |
| **Plugins** | `veto_plugins` |

## Compact Mode — 93 tools without the context tax

93 tool schemas cost a client ~20K context tokens before the user types a word. Compact mode advertises a surface that is **5–6× smaller**: seven core tools (`veto_status`, `veto_session_save`, `veto_session_restore`, `veto_route_task`, `veto_council_debate`, `veto_memory_search`, `veto_record_outcome`) plus two meta-tools — `veto_find_tools` searches the full catalog by keyword and returns matching schemas on demand; `veto_call` invokes any catalog tool by name. Every tool remains directly callable in both modes; compact only changes what is advertised up front.

Enable it with `VETO_COMPACT=1` in your MCP server config env, or `"compact_tools": true` in `~/.veto/config.json`:

```jsonc
{
  "mcpServers": {
    "veto": {
      "command": "npx",
      "args": ["-y", "--package", "@jigyasudham/veto@latest", "veto-server"],
      "env": { "VETO_COMPACT": "1" }
    }
  }
}
```

## Dependency-Hallucination Guard

LLMs propose plausible-but-nonexistent package names, and adversaries register those names on public registries (slopsquatting) — a supply-chain attack class with no pre-install check in most AI workflows. `veto_dep_verify` checks every proposed package against the live registry **before** you install:

```
veto_dep_verify { packages: ["axios", "axois", "left-padd"], ecosystem: "npm" }
→ axios      verified    (14 years old, 40M downloads/month)
→ axois      HIGH_RISK   (1 edit from "axios" — possible typosquat)
→ left-padd  NOT_FOUND   (likely hallucinated — do NOT retry the install later:
                          nonexistent AI-suggested names are prime slopsquat targets)
```

Signals per package: registry existence, age, monthly downloads, version history, deprecation, and typo-distance from popular packages. Supports npm, PyPI, and crates.io. Network failures return `unverifiable` — never silently safe.

## Decision-Drift Enforcement

AI assistants forget architectural decisions and re-litigate them sessions later — the most common complaint about long-running AI projects. Veto's memory doesn't just store decisions; it **enforces** them. Record a decision once as a machine-checkable constraint:

```
veto_decisions {
  action: "add",
  rule: "We use Postgres — no Mongo",
  why: "Decided 2026-05: relational data, team expertise",
  forbidden_patterns: ["mongoose", "mongodb"],
  severity: "block"
}
```

From then on, `veto_diff_review` and `veto_ci_gate` automatically fail any diff whose **added lines** match a forbidden pattern — when an AI quietly adds `mongoose` to the imports three sessions later, the review fails with the rule and the rationale attached. Patterns are case-insensitive regexes (with substring fallback), optionally scoped to a file glob (`src/**/*.ts`), per-project or global, severity `block` or `warn`. Manage with `action: list / check / disable / enable`.

## Compounding-Error Circuit Breaker

Agents fail silently in loops — retrying the same broken call, re-hitting the same error, thrashing between two tools — and burn a whole session before anyone notices. `veto_drift_check` scans the recent tool-call trace for that pattern mid-flight and trips a breaker before the spiral compounds:

```
veto_drift_check
→ DRIFT DETECTED
  • 4 consecutive failed calls (veto_diff_review)
  • same error repeated 3× ("no diff provided")
  • tool veto_route_task called 6× in a row
→ remediation (debugger agent): stop retrying; the diff is empty —
  point at a project_dir with uncommitted changes or pass `diff` explicitly.
```

It looks for three drift signals — consecutive failures, duplicate error messages, and single-tool repetition — and when any trips, it runs the `debugger` agent over the trace for a concrete recovery step instead of letting the loop continue. Call it as a periodic checkpoint in long agentic runs.

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

These work standalone in any terminal — no AI client needed. The bare `veto` command comes from the global install (`npm i -g @jigyasudham/veto`, see [Getting Started](#getting-started)); without it, prefix any command with `npx -y @jigyasudham/veto@latest`.

```bash
veto init                        # Configure all AI tools + scan project
veto doctor                      # Check MCP registrations + system health
veto status                      # Version, DB path, session/memory/outcome counts
veto version                     # Alias for veto status
veto sessions                    # List last 20 saved sessions ([auto] badge on auto-saves)
veto sessions --clean            # Remove auto-saves older than 7 days
veto memory [query]              # Search knowledge base (blank = all entries)
veto patterns [prefix]           # List learned agent/routing patterns
veto tools [filter]              # List all 93 MCP tools (--json for machine output)
veto agents [filter]             # List all 49 specialists — workers + council (--json)
veto routing [status|log|reset]  # Inspect the opt-in routing feedback loop
veto transcripts <sub>           # Opt-in transcript capture (off by default) —
                                 #   enable|status|sources|list|show|purge|disable
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
  ✓ Node.js v22.13.0
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

The loop also feeds itself **implicitly**: `veto_learning_stats` mines the tool-call trace for signals nobody recorded manually — an agent-backed tool that returned an error, or the same analysis tool re-run within minutes in one session (which usually means the first answer didn't satisfy) — and records them as low-quality outcomes automatically.

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

## Session Transcript Capture (opt-in)

`veto_session_save` writes a ~1k-token summary. That is enough to resume, but not enough to answer *"three weeks ago, what exactly did we conclude, and when?"* Transcript capture keeps the detail a summary throws away and makes it searchable — with no API keys, no per-query cost, and nothing leaving your machine. It is a metadata table-of-contents plus a portable BM25 index built on core SQLite only — no FTS5, so it works on every supported Node — fused with local semantic search, and your AI as the reranker.

> ### ⚠️ Read this before you enable it
>
> **Veto copies your AI client's own conversation memory.** On save, Veto archives a byte-for-byte copy of the host CLI's transcript file — every message you sent, every reply, and all tool activity — into its own local store.
>
> - **The copy is independent.** The original file is never modified, but Veto's copy outlives it. Clearing your AI client's history, or the client rotating its own logs, will **not** remove the archive. Only `veto transcripts purge` or the retention window does.
> - **It inherits whatever was in the session.** Secrets, customer data, third parties' information — if you pasted it, it is in the archive. Detected secrets are masked everywhere an AI can read them, but the raw archive on disk is private data. Treat it like your shell history.
> - **Local only.** Nothing is uploaded or shared. The archive directory deliberately avoids cloud-synced folders, and a sync path is flagged if one is detected.
> - **Off until you say so.** Capture is disabled by default. `veto transcripts enable` prints this disclosure in full and records versioned consent; if the disclosure materially changes, you are re-prompted.

```bash
veto transcripts enable          # Opt in — prints what/where/retention, records consent
veto transcripts status          # State, archive dir, retention, disk usage
veto transcripts sources         # Per-CLI: where sessions live + what Veto can see
veto transcripts list            # Archived sessions
veto transcripts show <id>       # One session's table-of-contents + facts
veto transcripts purge <id>      # Delete an archive (also --project=<dir> | --all)
veto transcripts disable         # Stop capturing (existing archives are kept)
```

### Works in Claude Code, Codex CLI and Gemini CLI

All three are captured and recalled through the same pipeline, each with its own
format adapter. Claude Code reports its session through Veto's statusline; Codex
and Gemini expose no such hook, so Veto locates their session files on disk
instead — `veto transcripts sources` shows exactly what it can see for each.
Pass the CLI you are running in as `platform` when you save, and recall works the
same everywhere. Each adapter was written against real transcripts rather than
docs, which is how two format traps got handled: Codex records every message on
two parallel streams, and Gemini's chat log appends a fresh copy of a message
each time it grows. Both would otherwise put several copies of the same message
into the index.


Recall runs through `veto_session_replay` as a two-call loop — search, then expand:

```
{ query: "npm E404 publish" }   →  table-of-contents + top hits with snippets
{ expand: { event_id: 412 } }   →  the exact lines, masked, with a turn + timestamp citation
```

Claude Code is the only adapter in 3.1.0; Codex and Gemini follow.

### Semantic recall — finding what you can't quite remember

Keyword search fails on the question you actually have. You remember *what was
decided*, not the words it was written in — so "why did the upload fail" never
finds the note that says "the credentials had expired".

Veto searches meaning as well as words. Each captured event is split into
overlapping windows and embedded locally; a query is embedded the same way, and
the two rankings — keywords and meaning — are fused so neither can bury the
other. An exact identifier like `E404` still ranks first, and a question sharing
no vocabulary with its answer still finds it.

**This runs entirely on your machine.** No API key, no per-query cost, no text
leaving the disk, and it works offline. What buys that is a **7 MB embedding
table** installed as a normal dependency:

- It is **downloaded once per machine** by npm's shared cache, not per project.
- It ships with Veto whether or not you enable transcript capture. That is the
  honest cost of the design: pinning an immutable package means the bytes can
  never change under a released version, and it removes the runtime download,
  checksum and mirror machinery that a fetch-on-demand model would need.
- It is loaded **lazily, at the first semantic query — never at startup.** If it
  is missing or damaged, search silently falls back to keywords only and Veto
  keeps working.

The table is [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M)
by [Minish Lab](https://github.com/MinishLab/model2vec) (MIT), distilled from
`baai/bge-base-en-v1.5` and repacked to int8. It is a static lookup table, not a
neural network: there is no model running at query time, which is why a search
costs milliseconds. The inference code is Veto's own.

---

## Release Notes

### 3.1.2
- **The embedding table Veto installs is now a signed artifact.** Veto pins `@jigyasudham/veto-model` to an exact version, and that pin now points at `1.0.1`, which was published from CI with provenance — a signed attestation linking the package to the repository, workflow and commit that built it. `1.0.0` was published by hand and can never be attested, so the pin was the only way to close the gap. The payload itself is byte-for-byte identical between the two versions: same embeddings, same scales, same tokenizer, same vectors. Nothing about search behaviour, results or ranking changes.

### 3.1.1
- **Bug fix: `veto memory export --markdown` always failed.** The markdown export assembled its query with the project filter placed after `ORDER BY`, which is not valid SQL, so the export reported failure instead of writing a file. Because the CLI always filters by the current project, the command could never succeed; the MCP tool `veto_memory_export` failed the same way whenever a project was specified. Exports without a project filter were unaffected, which is why this went unnoticed. Both queries are corrected and covered by regression tests.

### 3.1.0
- **Semantic recall — search finds what you meant, not just what you typed.** Transcript search now fuses the existing keyword index with local semantic search, so a question that shares no vocabulary with its answer still finds it: "why did the upload fail" surfaces the note saying "the credentials had expired". Each captured event is split into overlapping windows and scored by its best match, because embedding a whole event dilutes the one sentence that answers the question. Exact identifiers are unaffected — `E404` still ranks first. The two rankings are fused by reciprocal rank rather than blended scores, so neither ranker can bury the other.
- **It runs on your machine, offline, at no per-query cost.** What pays for that is a 7 MB embedding table — [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) by [Minish Lab](https://github.com/MinishLab/model2vec) (MIT), distilled from `baai/bge-base-en-v1.5`, repacked to int8, shipped as the pinned package `@jigyasudham/veto-model`. npm's cache downloads it once per machine. It installs with Veto whether or not you enable capture: pinning an immutable version means the bytes can never change under a release, with no download, checksum or mirror machinery at runtime. It is a static lookup table, not a neural network — nothing executes at query time, and the inference code is Veto's own.
- **The model is never load-bearing.** It resolves at the first semantic query and never at startup, so a missing or damaged copy degrades search to keyword-only with everything else untouched. Veto's own package is unchanged in size; the table is a dependency, not contents.
- **Search got roughly 5x faster at scale, keyword search included.** Project-wide recall over a 50-session archive went from 178 ms to 38 ms, and keyword-only from 65 ms to 13 ms, by loading the index once instead of re-reading it per query. That also removes a latency ceiling that affected 3.0.0. Beyond roughly 100 archived sessions in one project, recall degrades gradually and remains usable.
- **Correction to 3.0.0's release note:** it described transcript search as "SQLite FTS5/BM25". FTS5 was removed before 3.0.0 shipped precisely because it is absent on some Node builds; the index has always been portable BM25 on core SQLite.

### 3.0.0
- **Never lose a session again — opt-in transcript capture with vectorless recall.** A saved session has always carried a ~1k-token summary, which is enough to resume but cannot answer "what exactly did we conclude three weeks ago, and when?" Veto can now archive a copy of your host CLI's own conversation transcript and build a memory pyramid over it — the raw gzipped original, deterministic facts, the conversation spine, and the existing summary — then search it with a metadata table-of-contents plus a portable BM25 index that uses core SQLite only, so it runs on every supported Node. No embeddings, no model downloads, no API keys, no new runtime dependencies. Recall is a two-call loop through `veto_session_replay`: query for a table-of-contents and ranked snippets, then expand a hit into the exact source lines with a turn-and-timestamp citation. Validated against a real 784-line session, where recall pinpointed a conclusion the summary could not reconstruct. Claude Code is the only adapter in this release.
- **Capture is off until you turn it on, and it tells you exactly what it takes.** `veto transcripts enable` prints a plain-language disclosure — that Veto copies the AI client's own session memory, that the copy outlives the client's own history, that the archive inherits the sensitivity of anything you pasted, and where on disk it lands — then records versioned consent, re-prompting if that disclosure ever materially changes. Archives stay on your machine, are kept out of cloud-synced directories, are pruned on a configurable retention window, and are removed by `veto transcripts purge` as a true cascade with no orphan rows.
- **Secrets cannot transit into an AI context.** Detected credentials are masked to `REDACTED[sha256:…]` on the way into every derived layer *and* again on every byte range served back out of the raw archive — so a secret sitting in an untouched original still cannot reach a model through recall. Recalled content is returned as data-not-instructions, and tool results are treated as untrusted input.
- **`veto.db` is untouched.** All capture state lives in a sidecar `transcripts.db`, leaving the VS Code HUD's read-contract unaffected.

### 2.9.0
- **Four more agents do real analysis.** The privacy, performance, auth, and compatibility agents were structured playbooks; they are now dual-mode analyzers with hand-written deterministic checks — PII/PHI handling, runtime anti-patterns, auth defects (e.g. JWT `alg: none`), and outdated-API usage — growing the analyze-capable roster from 8 to 12. Each is scoped to avoid duplicating the security scanner's and secrets agent's findings, and all keep their LLM upgrade path.
- **Agent-backed tools can now complete the LLM upgrade round-trip.** All 19 agent-backed advisor, generator, and git tools used to emit an `llm_upgrade` prompt with no way to hand the reasoning back. Each now accepts an `agent_response` parameter: call the tool, reason as the specialist, then call again with the structured JSON to get the upgraded result. The deterministic answer is always returned either way — the upgrade attaches alongside it, never replaces it.
- **Council verdicts are scoped to the project.** The latest-verdict shown in the VS Code HUD and the CLI status line used to be the globally-newest council debate, so it could display a result from a different workspace. Council outcomes now carry a `project_dir` (a one-time idempotent migration adds the column and backfills existing rows from their linked session), the status line scopes the verdict to the active workspace, and a debate run without an explicit `project_dir` falls back to the active project instead of being stored unscoped. When a project has no debate yet, the verdict segment simply drops rather than borrowing another folder's.
- **Veto tools are called, not re-implemented.** Weaker models (e.g. Gemini Flash) sometimes read a bare `veto_*` command as a task to do by hand — reverse-engineering the tool from source, writing throwaway scripts, and poking the database directly, which produced fabricated, wrongly-scoped results. An always-present usage directive plus explicit triggers on `veto_continue` / `veto_handoff` / `veto_session_save` now tell every client to invoke the live MCP tools directly.

### 2.8.0
- **Deterministic council verdicts are honest again.** When the council runs without an LLM-backed path, each specialist used to emit canned, task-irrelevant "topic" warnings — broad keyword matches (a task mentioning "test" or "plan") produced boilerplate concerns that piled up and forced YELLOW verdicts with no real signal. Those topic insights are now **non-voting advice**: the agent votes approve and surfaces the guidance as a 💡 `[advisory]` note that never moves the verdict. The Devil's Advocate still always challenges, but its topic probes no longer escalate. Concrete rule matches (hardcoded secrets, `localStorage` tokens, GPL licenses, missing rate limits, …) escalate exactly as before.
- **VS Code HUD now finds sessions and memory on every workspace.** Sessions and memory are matched to a workspace by `project_dir`, but it was stored with whatever drive-letter case the caller passed (usually uppercase `D:\`), while the extension queries with VS Code's `fsPath` (lowercase drive, case-sensitive) — so the HUD showed "No active session" / "0 memory entries" even after a successful save. `project_dir` is now canonicalized (lowercase Windows drive letter) at every read and write, with a one-time idempotent migration that fixes existing rows on next start.

### 2.7.4
- **Server survives runtimes without `node:sqlite`.** The sqlite built-in (Node ≥ 22.5) is now loaded lazily on first database use instead of at import time. On runtimes that lack it — older Nodes, registry capability scanners — the server now starts, answers `initialize`, and lists all 93 tools; only the persistence tools (memory, sessions, learning) return a clear "upgrade Node" error instead of the whole process dying before the MCP handshake. No behavior change on supported Nodes: same database, same schema, same queries.
- The crash-proof statusline `print` gets the same treatment: its read-only DB open now requires sqlite inside the existing never-throws guard.

### 2.7.3
- **Global CLI install restored as the documented path.** 2.7.1 removed all `npm i -g` recommendations because a global copy could shadow npx and pin the MCP server to an old version — but 2.7.1's own `@latest` pin made that shadowing impossible, leaving the README documenting 15 bare `veto` commands with no way to get `veto` on PATH. `npm i -g @jigyasudham/veto` is now the documented way to install the CLI (new [Getting Started](#getting-started) section); the MCP server keeps auto-updating via the pinned-npx config regardless.
- **`veto doctor` no longer condemns a global install.** It now reports a global CLI install as healthy, warns only when it's behind the registry (with the `npm i -g @latest` fix), and shows an informational hint when no global install exists. Troubleshooting text and the startup update nudge were updated to match — "update the global" instead of "delete the global".
- **`veto statusline install` checks PATH.** The statusline hot path invokes bare `veto` (npx is too slow to run on every prompt render), so install now warns when `veto` isn't on PATH instead of silently rendering nothing.
- **npm package slimmed 22.6 MB → 2.2 MB unpacked.** `package.json` now has a `files` allowlist (`dist/` + `server.json`), so local working files — including a 20 MB `mcp-publisher.exe` that had been shipping since 2.5.0 — are no longer packed. Faster npx cold starts for everyone.

### 2.7.2
- **`veto init` self-repairs a broken Claude Code registration.** If the user-scope `veto` MCP entry launches `node <script>` and that script no longer exists — the classic case being an old entry pinned to a global install's `dist/server.js` after `npm rm -g` removed it — `init` now re-registers it with the canonical pinned-npx command instead of skipping it as "already registered". It only touches a demonstrably-dead `node`-path entry, never a working or custom config.
- **Windows: Claude registration uses `npx.cmd`.** `veto init` now registers Claude Code with `npx.cmd` on Windows (Claude Code cannot resolve a bare `npx` there), matching the form that connects reliably.

### 2.7.1
- **Fix: `npx` could silently run a stale version.** The generated MCP config used an unpinned `--package @jigyasudham/veto`, so npx would reuse a cached or globally-installed copy instead of fetching the latest — reinstalling and restarting never upgraded. Every generated config and documented register command now pins **`@latest`**, which npx must re-resolve against the registry each launch, so a client restart auto-updates. All `npm i -g @jigyasudham/veto` recommendations were removed (a global install is what shadows npx in the first place).
- **Startup update nudge.** When a newer Veto is published, the running server surfaces a one-line "update available — restart to pick it up" tip to the agent via the MCP `instructions` field. Non-blocking and offline-safe: it reads a cached latest version and refreshes it in the background at most once per day; it self-resolves once you're current.
- **`veto --version` / `-v`.** Previously returned "Unknown command". `veto doctor` now also reports whether a newer version is available and flags a shadowing global install with the `npm rm -g` fix.
- **Honesty fix.** Registry/directory description changed "zero API cost" → "no API keys" (Sampling calls do cost on pay-per-token API billing).

### 2.7.0
- **Statusline shows LIVE session gauges, not a frozen tally.** The old token segment read Veto's own `rate_usage` table, which only Veto's tools increment — so it sat frozen during normal use. `veto statusline print` now reads the JSON Claude Code pipes to a `statusLine` command on stdin and renders three live gauges: `ctx N%` (context-window used), `5h N%` (5-hour rate limit), and `7d N%` (weekly rate limit). Each colors yellow ≥70 / red ≥90 and drops when its value is unavailable (early session / post-`/compact`). It renders e.g. `⬡ veto GREEN · router 94% · ctx 37% · 5h 74% · 7d 8% · mem 15`, degrades to a neutral `⬡ veto`, and stays crash-proof and non-blocking (TTY-guarded, 200 ms timeout). Veto's own per-platform daily accounting remains available via `veto_rate_status` / `veto_snapshot`.
- **First-run statusline nudge.** Until the statusline is installed, Veto surfaces a one-line offer to the agent via the MCP `instructions` field, so the feature is discoverable instead of hidden behind a command. Consent-preserving (never edits `settings.json` without the user agreeing) and self-resolving (the nudge disappears once installed).
- **`veto statusline print --capture <file>`.** Diagnostic aid that appends the raw Claude Code payload alongside the rendered line, so the live gauges can be verified against the values the client actually sent. Off by default; best-effort and never blocks the render.

### 2.6.0
- **`veto statusline` — a compact Veto line under any AI CLI prompt.** `veto statusline install` wires a `statusLine` command into Claude Code's settings.json (backed up; `uninstall` restores it byte-for-byte). The `print` hot path is read-only, fast, and crash-proof — it renders e.g. `⬡ veto GREEN · router 94% · claude 42% · mem 15` and degrades to a neutral `⬡ veto` if the DB is missing or locked. Lives in the CLI so every Veto user gets it in any terminal, not just the VS Code HUD.
- **`veto_snapshot` — one-call editor/HUD aggregate.** Returns `{ session, council, routerTop, rate, memoryCount, health }` in a single read-only call, so editor integrations (veto-vscode) can stop reading internal tables directly. Tool count is now **93**.
- **Stable read-contract versioning.** `veto.db` now stamps `PRAGMA user_version` (`VETO_DB_SCHEMA_VERSION`) on every open, so external readers can detect schema drift and degrade gracefully instead of silently blanking.

### 2.5.0
- **`veto_drift_check` — compounding-error circuit breaker.** Scans the recent tool-call trace for consecutive failures, repeated error messages, and single-tool thrashing, then runs the `debugger` agent for a concrete recovery step. See [Compounding-Error Circuit Breaker](#compounding-error-circuit-breaker).
- **Council calibration fixes.** Tightened the deterministic council's pattern triggers so they no longer false-fire on generic words (e.g. "server", "transport") or semver strings like `v2.5.0`, and removed stale hardcoded tool counts from agent reasoning.

### 2.4.0
- **`veto_decisions` — decision-drift enforcement.** Record an architectural decision once as a machine-checkable constraint; `veto_diff_review` and `veto_ci_gate` then auto-fail any diff whose added lines reintroduce a forbidden pattern. See [Decision-Drift Enforcement](#decision-drift-enforcement).

### 2.3.0
- **`veto_dep_verify` — dependency-hallucination guard.** Verifies every proposed package against the live npm/PyPI/crates.io registry before install, flagging hallucinated names and typosquats (slopsquatting defense). See [Dependency-Hallucination Guard](#dependency-hallucination-guard).

### 2.2.0
- **Compact mode** (`VETO_COMPACT=1`) — advertises 9 tools incl. `veto_find_tools` / `veto_call` meta-tools, ~5–6× schema reduction. See [Compact Mode](#compact-mode--92-tools-without-the-context-tax).
- **Implicit outcome mining** — `veto_learning_stats` now mines outcomes automatically from the tool-call trace (errored calls, rapid re-runs), no manual `veto_record_outcome` needed.
- **Experimental streamable HTTP transport** (`veto-server --http`). See [HTTP Transport](#http-transport-experimental).

## HTTP Transport (experimental)

`veto-server --http [port]` serves MCP over streamable HTTP at `http://127.0.0.1:<port>/mcp` (default port 3939) instead of stdio — for gateways, remote clients, or anything that can't spawn a subprocess. It runs **stateless** (no session IDs — the direction of the July 2026 MCP spec) and binds loopback only; set `VETO_HTTP_HOST` to expose it deliberately.

## Project Structure

Veto is a single MCP server (`src/server.ts`) that registers 93 tools, MCP Resources, and Prompts, then dispatches every tool call through a per-domain **handler registry** — there is no monolithic switch. Each domain owns a `HandlerMap` module under `src/server/handlers/`:

| Module | Tools | Domain |
|---|---|---|
| `workers.ts` | 15 | single-agent worker delegations (code_review, security_scan, explain, …) |
| `generators.ts` | 11 | single-agent artifact generators (adr, diagram, rca, doc_gen, onboard, …) |
| `memory.ts` | 9 | knowledge base, patterns, project map |
| `observability.ts` | 7 | health, metrics, usage, audit, context/rate status |
| `advisors.ts` | 8 | project scanners (dep, query, bundle, dead-code, flag, openapi, HITL, drift-check) |
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
- **Runtime:** Node.js 22.13+ or 23.4+ (built-in `node:sqlite` — no native compilation). It exists from 22.5 but only behind `--experimental-sqlite`, so 22.13 is the real floor.
- **Dependencies:** `@modelcontextprotocol/sdk` only — one package, zero native addons
- **Memory:** Local SQLite — zero config, works offline, portable via JSON export
- **Platforms:** Claude Code · Gemini CLI · Antigravity CLI · Codex CLI · Cursor · Windsurf · Zed

---

## License

MIT © 2026 Jigyasu Dham
