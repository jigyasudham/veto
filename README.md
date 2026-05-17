# veto

> **50 agents. 49 tools. 3 AIs. Self-learning. Zero extra cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, and Zed using your existing subscriptions — giving every AI a council of specialist agents, persistent cross-platform memory, a self-learning router, CI/CD gates, workspace discovery, live docs, cross-platform handoff, usage metrics, and the ability to say no to bad decisions before any code is written.

---

## How the Agents Actually Work

**This is the most important thing to understand about Veto.**

Veto has two fundamentally different types of agents:

### Council agents — real LLM reasoning (7 agents)

The 7 council agents call your existing AI subscription via MCP Sampling — they do not use a separate API key or cost anything extra. Each agent gets a tight system prompt, reasons independently, and returns a structured JSON verdict.

| Agent | Role |
|---|---|
| Lead Developer | Code quality, maintainability, implementation risk |
| Product Manager | Scope, timeline, business value |
| System Architect | Architecture fit, scalability, coupling |
| UX Designer | User impact, accessibility, friction |
| Devil's Advocate | Challenges assumptions, stress-tests the plan |
| Legal & Compliance | License risks, data handling, regulatory exposure |
| Security | OWASP, auth, injection, data leakage |

Use `strictness` to control depth:
- `fast` — 3 agents (Lead Dev + Architect + Security), instant
- `standard` — all 7 agents, default
- `strict` — all 7 agents + Devil's Advocate rebuttal round on the most critical blocker

`veto_benchmark` also runs LLM council — two debates in parallel for side-by-side approach comparison.

### Expert modules — deterministic, instant, zero tokens (42+ agents)

Every other agent in Veto — coder, reviewer, tester, debugger, security scanner, secrets scanner, database, frontend, devops, and all 30+ others — is a **deterministic expert module**: structured templates, OWASP regex patterns, and domain heuristics compiled into code. They run offline, produce zero token cost, and return results in milliseconds.

```
veto_agent_plan  { agent: "coder", task: "..." }    ← deterministic plan, instant
veto_code_review { code: "..." }                     ← regex + heuristic scanner, instant
veto_secrets_scan{ text: "..." }                     ← pattern matching, instant
veto_council_debate { task: "..." }                  ← 7 LLM calls via MCP Sampling
```

**Why this split?** LLM reasoning costs tokens and latency — it's only worth it for high-stakes decisions before architecture/security/migration work. Pattern-matching is MORE reliable than LLMs for secrets detection and OWASP scanning (no hallucinations). The deterministic agents are the workhorses; the council is the gatekeeper.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 22.5.0 or higher | Required — uses built-in `node:sqlite` (no native compilation). Download at [nodejs.org](https://nodejs.org). |
| **At least one AI CLI** | Latest | Claude Code, Gemini CLI, or Codex CLI — whichever you use. Veto works with all. |

```bash
node --version   # must be v22.5.0 or higher
```

---

## Quick Start

```bash
npx @jigyasudham/veto@latest init
```

`init` auto-detects every AI tool installed on your machine, configures them all in one shot, and builds a project map from your current directory — no manual steps.

### Claude Code (global — works in every window and project)

```bash
claude mcp add veto -s user -- npx -y --package @jigyasudham/veto veto-server
```

The `-s user` flag registers Veto at user scope so it is available in **every window and project** automatically.

### Other platforms

| Platform | Config file written by `veto init` |
|---|---|
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Codex CLI** | `~/.codex/config.toml` |
| **Cursor** | `~/.cursor/mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Zed** | `~/.config/zed/settings.json` · Windows: `%APPDATA%\Zed\settings.json` (`context_servers` key) |

All config files are home-directory relative — they apply globally across all projects. Restart the AI client after `veto init`.

```json
{
  "mcpServers": {
    "veto": {
      "command": "npx",
      "args": ["-y", "--package", "@jigyasudham/veto", "veto-server"]
    }
  }
}
```

---

## What Veto Does

**Council** — Before any significant task, 7 specialist agents (LLM-backed via MCP Sampling) debate it in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict. Bad decisions get blocked before any code is written. Use `strictness: "fast"` for quick checks or `"strict"` for a full rebuttal round.

**Metrics** — `veto_metrics` gives you a live usage dashboard: sessions saved, council verdict breakdown, top agents by call count, 7-day quality trend, and knowledge base stats. Zero cost, pure SQLite.

**Changelog** — `veto_changelog` reads your git history since the last tag, groups commits by conventional type (feat, fix, refactor...), and returns a structured changelog ready to publish.

**Git blame** — `veto_git_blame` returns contribution history for any file or directory — total commits, contributor list with counts, and last-modified metadata. Instant, local, no network.

**Codebase-aware agents** — Pass `project_dir` to any tool and Veto auto-reads `package.json`, detects your tech stack, and injects recent `git diff` context. Every agent responds to your actual project.

**Structured output** — Every agent result carries `confidence`, `severity`, `recommendation`, `affected_files`, and `line_refs` — composable and actionable.

**Router** — Every task is scored locally (zero tokens) and sent to the right model tier. Rate limits are tracked across all platforms. The router self-adjusts from recorded outcomes and learns which agents perform best per file type.

**Memory** — Sessions, decisions, knowledge, and coding patterns persist across every conversation and platform. Sessions are searchable by summary, context, tags, or project path. Tag sessions with `tags: ["auth", "migration"]` and find them later with `query: "auth"`.

**Workspace discovery** — `veto_discover` scans a project once and builds a rich context map: git state, tech stack, file tree, dependencies, and key config files.

**Project summarization** — `veto_summarize` generates a concise expert briefing of a project, directory, or file.

**Explain anything** — `veto_explain` accepts a file path or raw text (error messages, stack traces, compiler output). Auto-routes to the right expert — file extension detection for source files, debugger agent for error-like content.

**Diff review** — `veto_diff_review` runs code review, security scan, and secrets scan in parallel across a git diff. Returns a pass/warn/fail verdict ready for CI and pre-commit hooks.

**File watching** — `veto_watch` monitors your project and tells you which agent to call when files change.

**Sequential pipelines** — `veto_workflow` runs a chain of agents with pass/fail gates end to end.

**Cross-platform handoff** — Claude hitting its rate limit? `veto_handoff` → open Gemini → `veto_continue`. Full context restored in seconds.

**Plugin system** — Drop a `.js` file in `~/.veto/agents/` and it registers as a custom agent available in every tool.

---

## The 50 Agents

### Council Layer — LLM-backed via MCP Sampling (8)

> These agents call your existing AI subscription. Real reasoning, real cost. Used exclusively by `veto_council_debate` and `veto_benchmark`.

`Lead Developer` · `Product Manager` · `System Architect` · `UX Designer` · `Devil's Advocate` · `Legal & Compliance` · `Security` · `Decision Engine`

### Expert Modules — deterministic, instant, zero tokens (42)

> Pattern matching, domain heuristics, and structured templates compiled into code. Offline capable. No LLM calls.

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

## MCP Tools (49)

| Category | Tools |
|---|---|
| **Session** | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` · `veto_autosave_status` |
| **Router** | `veto_route_task` · `veto_rate_status` |
| **Council** | `veto_council_debate` · `veto_benchmark` |
| **Agents** | `veto_agent_plan` · `veto_execute_parallel` · `veto_explain` |
| **Review** | `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_diff_review` |
| **Pipelines** | `veto_workflow` |
| **Watching** | `veto_watch` · `veto_watch_poll` · `veto_watch_stop` |
| **Memory** | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| **Learning** | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| **Handoff** | `veto_handoff` · `veto_continue` · `veto_platform_setup` |
| **Intelligence** | `veto_docs_fetch` · `veto_context_status` · `veto_task_parse` |
| **Observability** | `veto_usage_status` · `veto_audit_log` · `veto_health` · `veto_metrics` |
| **CI/CD** | `veto_ci_gate` · `veto_pr_review` |
| **Discover** | `veto_discover` · `veto_summarize` · `veto_git_blame` · `veto_changelog` |
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

```
veto_council_debate {
  task: "migrate auth from sessions to JWTs",
  project_dir: "/your/project",
  strictness: "standard"      ← fast | standard | strict
}
→ {
    final_verdict: "YELLOW",
    block_reasons: [],
    warnings: ["JWT revocation requires a token blocklist — plan storage", "Clock skew between services can break expiry checks"],
    votes: {
      lead_dev:  { verdict: "warn",    reason: "Stateless JWTs complicate logout flows...", concerns: [...] },
      architect: { verdict: "approve", reason: "Good fit for microservices...", concerns: [...] },
      security:  { verdict: "warn",    reason: "Refresh token rotation must be atomic...", concerns: [...] },
      ...
    },
    recommended: "Proceed with JWT migration. Implement a Redis blocklist for logout..."
  }
```

---

## Session Tagging + Search

Tag sessions when saving to make them findable later:

```
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

| Platform | Support |
|---|---|
| Claude Code | ✅ Native MCP |
| Gemini CLI | ✅ MCP support |
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
