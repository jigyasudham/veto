# veto

> **50 agents. 45 tools. 3 AIs. Self-learning. Zero extra cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, and Gemini CLI using your existing subscriptions — giving every AI a council of specialist agents, persistent cross-platform memory, a self-learning router, live usage tracking, CI/CD pipeline gates, workspace discovery, live documentation fetching, auto session save, and the ability to say no to bad decisions.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 22.5.0 or higher | Required — uses the built-in `node:sqlite` module (no native compilation). Download at [nodejs.org](https://nodejs.org). |
| **At least one AI CLI** | Latest | Claude Code, Gemini CLI, or Codex CLI — whichever you use. Veto works with all three. |

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

The `-s user` flag registers Veto at user scope so it is available in **every VS Code window and project** without re-running anything. `veto init` does this automatically.

### Other platforms

| Platform | Config file written by `veto init` |
|---|---|
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Codex CLI** | `~/.codex/config.json` |
| **Cursor** | `~/.cursor/mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |

All config files are home-directory relative — they apply globally across all projects and windows. Restart the AI client after `veto init` to pick up the new config.

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

**Council** — Before any significant task, 7 specialist agents debate it in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict. Bad decisions get blocked before any code is written.

**Codebase-aware agents** — Pass `project_dir` to any tool and Veto auto-reads `package.json`, detects your tech stack, and injects recent `git diff` context. Every agent responds to your actual project, not generic templates.

**Structured output** — Every agent result carries `confidence`, `severity`, `recommendation`, `affected_files`, and `line_refs` — composable and actionable.

**Router** — Every task is scored locally (zero tokens) and sent to the right model tier. Rate limits are tracked across all 3 platforms. The router self-adjusts from recorded outcomes and learns which agents perform best per file type.

**50 Agents** — Domain experts for every task type. Each agent knows when it is the right tool and when to defer.

**Memory** — Sessions, decisions, knowledge, and coding patterns persist across every conversation and every platform. Memory is automatically scoped to the active session's project directory — two instances working on different projects stay isolated without any extra configuration.

**Workspace discovery** — `veto_discover` scans a project once and builds a rich context map: git state, tech stack, file tree, dependencies, and key config files. Stored in Veto memory so every agent has accurate project context without re-reading files each time.

**Project summarization** — `veto_summarize` generates a concise expert briefing of a project, directory, or file in seconds. Use it at the start of a session to orient yourself on unfamiliar code.

**Diff review** — `veto_diff_review` runs code review, security scan, and secrets scan in parallel across a git diff. Returns a pass/warn/fail verdict with per-file findings — ready for CI and pre-commit hooks.

**File watching** — `veto_watch` monitors your project and tells you which agent to call when files change.

**Sequential pipelines** — `veto_workflow` runs a chain of agents with pass/fail gates end to end.

**File explanation** — `veto_explain` reads any file and routes it to the best-fit expert agent automatically.

**Plugin system** — Drop a `.js` file in `~/.veto/agents/` and it registers as a custom agent available in every tool.

**MCP Resources + Prompts** — Read Veto's memory as MCP Resources. Use built-in Prompts as reusable task templates.

**Cross-platform handoff** — Claude hitting its rate limit? `veto_handoff` → open Gemini → `veto_continue`. Full context restored in seconds.

---

## The 50 Agents

### Council Layer (8) — runs before any code is written
`Lead Developer` · `Product Manager` · `System Architect` · `UX Designer` · `Devil's Advocate` · `Legal & Compliance` · `Security` · `Decision Engine`

### Development (12)
`Coder` · `Code Reviewer` · `Tester` · `Debugger` · `Refactor` · `Database` · `API` · `Frontend` · `Backend` · `DevOps` · `Performance` · `Migration`

### Security (6)
`Security Scanner` · `Auth Agent` · `Data Privacy` · `Secrets Agent` · `Dependency Audit` · `Penetration Tester`

### Memory (5)
`Context Manager` · `Decision Logger` · `Project Mapper` · `Pattern Learner` · `Knowledge Base`

### Research (7)
`Researcher` · `Tech Advisor` · `Cost Analyzer` · `Competitor Analyzer` · `Risk Assessor` · `Estimator` · `Ethics & Bias`

### Quality (5)
`Code Quality` · `Documentation` · `Accessibility` · `Compatibility` · `Error Handling`

### Workflow (7)
`Task Planner` · `Task Coordinator` · `File Manager` · `Git Agent` · `Search Agent` · `Reporter` · `Automation`

---

## MCP Tools (45)

| Category | Tools |
|---|---|
| **Session** | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` · `veto_autosave_status` |
| **Router** | `veto_route_task` · `veto_rate_status` |
| **Council** | `veto_council_debate` |
| **Agents** | `veto_agent_plan` · `veto_execute_parallel` · `veto_explain` |
| **Review** | `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_diff_review` |
| **Pipelines** | `veto_workflow` |
| **Watching** | `veto_watch` · `veto_watch_poll` · `veto_watch_stop` |
| **Memory** | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| **Learning** | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| **Handoff** | `veto_handoff` · `veto_continue` · `veto_platform_setup` |
| **Intelligence** | `veto_docs_fetch` · `veto_context_status` · `veto_task_parse` |
| **Observability** | `veto_usage_status` · `veto_audit_log` · `veto_health` |
| **CI/CD** | `veto_ci_gate` · `veto_pr_review` |
| **Discover** | `veto_discover` · `veto_summarize` |
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

Use these from any terminal to inspect Veto's brain without opening an AI session.

After installing globally (`npm i -g @jigyasudham/veto`) or via npx:

```bash
veto init                        # Configure all AI tools + scan project
veto doctor                      # Check MCP registrations + system health
veto status                      # Version, DB path, session/memory/outcome counts
veto sessions                    # List last 20 saved sessions
veto memory [query]              # Search knowledge base (blank = all entries)
veto patterns [prefix]           # List learned agent/routing patterns
veto help                        # Full command + MCP tools reference

# Without installing:
npx @jigyasudham/veto help       # Same help output, no install needed
npx @jigyasudham/veto status     # Check status from any machine
npx @jigyasudham/veto doctor     # Diagnose MCP setup from any machine
```

`veto help` shows all CLI commands, all 45 MCP tool names, MCP Resources, and MCP Prompts — the full reference in one place.

### `veto doctor`

Diagnoses your full Veto setup in one command:

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
  · Cursor — not installed

  ✓ All checks passed — Veto is healthy!
```

Run `veto init` to repair any failing check.

---

## Workspace Discovery

`veto_discover` scans a project once and stores a rich context map in Veto memory. Every subsequent agent call can read from this map instead of re-scanning files.

```
veto_discover { "project_dir": "/your/project" }
→ {
    git:        { branch: "main", commit: "a3f2b1", dirty_files: [], recent_commits: [...] },
    ecosystems: { node: "my-app v2.1.0" },
    tech_stack: ["TypeScript", "React", "Prisma"],
    key_files:  ["tsconfig.json", "prisma/schema.prisma", ".env.example"],
    total_files: 142,
    structure:  ["src/", "  components/", "  api/", ...]
  }
```

Three depth levels: `quick` (git + package metadata only), `standard` (+ file tree, default), `full`.

---

## Project Summarization

`veto_summarize` gives you a concise expert briefing on any project or file — useful when starting work on unfamiliar code.

```
veto_summarize { "project_dir": "/your/project" }
→ {
    subject: "project",
    tech_stack: ["TypeScript", "Next.js", "Prisma"],
    summary: {
      bullets: [
        "Full-stack Next.js app with Prisma ORM and PostgreSQL",
        "Auth via NextAuth — sessions stored in DB, not JWT",
        "API routes under /src/app/api — RESTful, no tRPC",
        "Background jobs via BullMQ with Redis",
        "Deployed on Vercel — preview branches auto-deploy"
      ]
    }
  }

# File-level:
veto_summarize { "file_path": "/your/project/src/auth.ts", "focus": "security" }

# Detailed prose instead of bullets:
veto_summarize { "project_dir": "/your/project", "format": "detailed" }
```

---

## Codebase-Aware Agents

Pass `project_dir` to any agent tool — Veto auto-injects:
- Project name, version, dependency list
- Detected tech stack (React, Next.js, Prisma, Express, MCP, etc.)
- Recent `git diff --stat` and last 5 commits
- Config files present (tsconfig, vite.config, tailwind, etc.)

```
veto_council_debate {
  task: "migrate auth from sessions to JWTs",
  project_dir: "/your/project"   ← agents now know your actual stack
}
```

---

## Diff Review

Auto-reads `git diff HEAD` from `project_dir`, or pass a diff string directly:

```
veto_diff_review { project_dir: "/your/project" }
→ {
    verdict: "warn",
    files_changed: 4,
    code_review:   { score: 78, critical: 0, high: 2, findings: [...] },
    security:      { score: 91, critical: 0, high: 0, findings: [...] },
    secrets:       { findings: [] },
    summary: "⚠️  WARN — 4 file(s) changed\nCode: approved_with_warnings (78/100)\n..."
  }
```

Works as a pre-commit hook or CI step. The `summary` field is a single string ready to post as a PR comment.

---

## GitHub PR Review

Pass a PR URL — Veto fetches the diff and runs the full triple-scan automatically:

```
veto_pr_review { pr_url: "https://github.com/owner/repo/pull/42" }
→ {
    verdict: "warn",
    pr: { title: "Add auth middleware", author: "jigyasudham", changed_files: 6, ... },
    checks: {
      code_review: { score: 78, critical: 0, high: 2 },
      security:    { score: 91, critical: 0, high: 0 },
      secrets:     { clean: true }
    },
    review_comment: "## ⚠️ Veto Review — WARN\n...",  ← paste directly into GitHub
    blocking_issues: []
  }
```

Set `GITHUB_TOKEN` in your environment for private repos. Public repos need no auth.

---

## Sequential Pipelines

```
veto_workflow {
  steps: [
    { id: "code",     agent: "coder",    task: "implement auth middleware", gate: 70 },
    { id: "review",   agent: "reviewer", task: "review the implementation", gate: 75 },
    { id: "security", agent: "security-scanner", task: "scan for vulnerabilities", gate: 80 },
    { id: "test",     agent: "tester",   task: "write test cases" }
  ],
  project_dir: "/your/project"
}
→ { verdict: "passed", steps_passed: 4, steps_failed: 0, results: [...] }
```

If any step's confidence falls below its gate, the pipeline halts and returns `partial` with the exact failure point.

---

## Reactive File Watching

```bash
veto_watch { project_dir: "/your/project" }
→ { watch_id: "a3f2b1c0" }

# make some changes, then:
veto_watch_poll { watch_id: "a3f2b1c0" }
→ [
    { file: "src/auth.ts",  recommended_agent: "code-quality", suggested_tool: "veto_code_review" },
    { file: "package.json", recommended_agent: "dependency-audit", suggested_tool: "veto_agent_plan" },
    { file: ".env",         recommended_agent: "secrets", suggested_tool: "veto_secrets_scan" }
  ]
```

---

## Self-Learning Router

The router gets smarter as you use it:

```bash
# After completing a task:
veto_record_outcome {
  task_type: "fix-auth-bug",
  complexity: 45,
  model_tier: 2,
  output_quality: 88,
  agent: "debugger",
  file_ext: ".ts"         # ← teaches the router which agent works best for .ts files
}

# After 20+ outcomes:
veto_learning_apply       # adjusts tier thresholds from your actual data

# Next route_task call:
veto_route_task { task: "debug auth issue", file_ext: ".ts" }
→ { ..., recommended_agent: "debugger" }   # ← predicted from history
```

---

## Plugin System

Register custom agents without forking:

```js
// ~/.veto/agents/my-agent.js
export function plan(task, context) {
  return {
    agent: 'my-agent',
    task,
    tier: 2,
    approach: 'Your custom approach...',
    steps: ['Step 1', 'Step 2'],
    checklist: ['[ ] Check 1'],
    pitfalls: ['Pitfall 1'],
    patterns: ['Pattern 1'],
    duration_estimate: '1-2 hours',
  };
}
```

Veto loads it on start. Use it in `veto_agent_plan { agent: "my-agent" }` or `veto_execute_parallel`.

---

## Cross-Platform Handoff

**Rate limit mid-task:**
```
Claude at 90%  →  veto_handoff { summary, context }
Open Gemini    →  veto_continue { resuming_as: "gemini" }
Full context restored. Continue exactly where you stopped.
```

Every session tracks two fields:
- `created_by` — which AI originally saved the session
- `active_client` — which AI last resumed it (updated on every `veto_continue` or `veto_session_restore`)

**Multiple AIs on different projects simultaneously:** Each MCP server process is independent. Sessions are always separate. Memory is automatically scoped to each process's active project — no cross-contamination.

**Switch machines:**
```
Machine A  →  veto_memory_export  →  veto-export.json
Machine B  →  veto_memory_import  →  veto_session_restore
```

| Platform | Support |
|---|---|
| Claude Code | ✅ Native MCP |
| Gemini CLI | ✅ MCP support |
| Codex CLI | ✅ MCP support |
| Cursor | ✅ MCP support |
| Windsurf | ✅ MCP support |

---

## Roadmap

| Phase | Status | Version |
|---|---|---|
| 1 — Foundation | ✅ Complete | v0.1.0 |
| 2 — Router | ✅ Complete | v0.2.0 |
| 3 — Council | ✅ Complete | v0.3.0 |
| 4 — Core Agents | ✅ Complete | v0.4.0 |
| 5 — Memory System | ✅ Complete | v0.5.0 |
| 6 — Self-Learning | ✅ Complete | v0.6.0 |
| 7 — Cross-Platform | ✅ Complete | v0.7.0 |
| 8 — All 50 Agents | ✅ Complete | v0.8.0 |
| 9 — Codebase Context + Structured Output + MCP Resources/Prompts | ✅ Complete | v0.9.0 |
| 10 — Watch, Workflow, Explain, Plugins | ✅ Complete | v0.10.0 |
| 11 — Smarter Council + Predictive Routing + Auto Project Map | ✅ Complete | v0.11.0 |
| 12 — CLI Subcommands + Diff Review | ✅ Complete | v1.0.0 |
| 13 — Developer Intelligence + Auto Docs | ✅ Complete | v1.1.0 |
| 14 — Observability + Usage Stats + Audit Log | ✅ Complete | v1.2.0 |
| 15 — CI/CD Gates + GitHub PR Review | ✅ Complete | v1.2.5 |
| 16 — Workspace Discovery + Summarization + Doctor | ✅ Complete | v1.2.8 |

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+ (built-in `node:sqlite` — no native compilation)
- **Dependencies:** `@modelcontextprotocol/sdk` only — one package, zero native addons
- **Memory:** Local SQLite — zero config, works offline, portable via JSON export
- **Platforms:** Claude Code · Gemini CLI · Codex CLI · Cursor · Windsurf

---

## License

MIT © 2026 Jigyasu Dham
