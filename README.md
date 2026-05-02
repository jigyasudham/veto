# veto

> **50 agents. 33 tools. 3 AIs. Self-learning. Zero extra cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, and Gemini CLI using your existing subscriptions — giving every AI a council of specialist agents, persistent cross-platform memory, a self-learning router, reactive file watching, sequential agent pipelines, and the ability to say no to bad decisions.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 22.5.0 or higher | Required — uses the built-in `node:sqlite` module (no native compilation). Download at [nodejs.org](https://nodejs.org). |
| **At least one AI CLI** | Latest | Claude Code, Gemini CLI, or Codex CLI — whichever you use. Veto works with all three. See below. |

**Check your Node version:**
```bash
node --version   # must be v22.5.0 or higher
```

If you're on an older version, update Node before continuing — Veto will fail silently on Node 18 or 20 because `node:sqlite` does not exist in those versions.

**Install whichever AI CLI(s) you use — Veto works with all of them:**

| Platform | Install | Auth |
|---|---|---|
| **Claude Code** | [claude.ai/code](https://claude.ai/code) | Sign in via browser |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | `gemini auth` |
| **Codex CLI** | `npm install -g @openai/codex` | `export OPENAI_API_KEY=your-key` |

You only need one to get started. Install more to enable cross-platform handoff.

---

## Quick Start

```bash
npx @jigyasudham/veto@latest init
```

The `init` command detects your installed AI tools and prints the exact config snippet for each. Paste it into your MCP config file:

| Platform | Config file |
|---|---|
| **Claude Code** | `~/.claude/mcp_servers.json` |
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Codex CLI** | `~/.codex/config.json` |
| **Cursor** | `~/.cursor/mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **VS Code** | `.vscode/mcp.json` |

```json
{
  "mcpServers": {
    "veto": {
      "command": "veto-server"
    }
  }
}
```

VS Code uses `"servers"` with `"type": "stdio"`:

```json
{
  "servers": {
    "veto": {
      "type": "stdio",
      "command": "veto-server"
    }
  }
}
```

---

## What Veto Does

**Council** — Before any significant task, 7 specialist agents debate it in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict. Bad decisions get blocked before any code is written.

**Codebase-aware agents** — Pass `project_dir` to any tool and Veto auto-reads `package.json`, detects your tech stack, and injects recent `git diff` context. Agents respond to your actual project, not generic templates.

**Structured output** — Every agent result carries `confidence`, `severity`, `recommendation`, `affected_files`, and `line_refs` — composable, actionable, not just text blobs.

**Router** — Every task is scored locally (zero tokens) and sent to the right model tier. Rate limits are tracked across all 3 platforms. The router self-adjusts over time from recorded outcomes.

**50 Agents** — Domain experts for every task type. Each agent knows when it is the right tool and when to defer to another.

**Memory** — Sessions, decisions, knowledge, and coding patterns persist across every conversation and every platform.

**File watching** — `veto_watch` monitors your project directory and tells you which agent to call when files change. Reactive, not on-command.

**Sequential pipelines** — `veto_workflow` runs a chain of agents with pass/fail gates. Define a coder → reviewer → tester → reporter pipeline and let Veto run it end to end.

**File explanation** — `veto_explain` reads any file and routes it to the best-fit expert agent automatically.

**Plugin system** — Drop a `.js` file in `~/.veto/agents/` and it registers as a custom agent available in every tool.

**MCP Resources** — Read Veto's memory, sessions, patterns, and project maps directly as MCP Resources — no tool call required.

**MCP Prompts** — Reusable prompt templates: `code-review`, `security-audit`, `deploy-checklist`, `explain-file`.

**Cross-platform handoff** — Claude hitting its rate limit? Call `veto_handoff`, open Gemini or Codex, call `veto_continue`. Full context restored in seconds. Nothing re-explained.

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

## MCP Tools (33)

| Category | Tools |
|---|---|
| Session | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` |
| Router | `veto_route_task` · `veto_rate_status` |
| Council | `veto_council_debate` |
| Agents | `veto_agent_plan` · `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_execute_parallel` · `veto_explain` |
| Pipelines | `veto_workflow` |
| Watching | `veto_watch` · `veto_watch_poll` · `veto_watch_stop` |
| Memory | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| Learning | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| Handoff | `veto_handoff` · `veto_continue` · `veto_platform_setup` |
| Plugins | `veto_plugins` |

## MCP Resources

Read Veto's internal state directly — no tool call needed:

| Resource URI | What it returns |
|---|---|
| `veto://sessions` | All saved sessions across platforms |
| `veto://project-map?dir=<path>` | Stored project structure map |
| `veto://memory?q=<query>` | Knowledge base search results |
| `veto://patterns` | Learned coding patterns |

## MCP Prompts

Reusable task templates your AI can invoke directly:

| Prompt | What it does |
|---|---|
| `code-review` | Full code review — paste code, get scored findings |
| `security-audit` | OWASP Top 10 scan with CWE references |
| `deploy-checklist` | Council reviews your deployment plan before you ship |
| `explain-file` | Expert explanation of any file, auto-routed by type |

---

## Codebase-Aware Agents

Pass `project_dir` to any agent tool and Veto auto-injects:
- Your `package.json` name, version, and full dependency list
- Detected tech stack (React, Next.js, Prisma, Express, etc.)
- Recent `git diff --stat` and last 5 commits
- Detected config files (tsconfig, vite.config, tailwind, etc.)

```
veto_council_debate {
  task: "migrate from REST to tRPC",
  project_dir: "/your/project"   ← agents now know your actual stack
}
```

---

## Sequential Pipelines

Chain agents with pass/fail gates:

```
veto_workflow {
  steps: [
    { id: "code",   agent: "coder",    task: "implement auth middleware", gate: 70 },
    { id: "review", agent: "reviewer", task: "review the implementation", gate: 75 },
    { id: "test",   agent: "tester",   task: "write test cases",          gate: 70 },
    { id: "report", agent: "reporter", task: "summarise changes" }
  ],
  project_dir: "/your/project"
}
```

If any step's confidence falls below the gate, the pipeline stops and returns `partial` with the exact failure point.

---

## Reactive File Watching

```
veto_watch { project_dir: "/your/project" }
→ { watch_id: "a3f2b1c0" }

# make some changes, then:
veto_watch_poll { watch_id: "a3f2b1c0" }
→ [
    { file: "src/auth.ts",    recommended_agent: "code-quality", suggested_tool: "veto_code_review" },
    { file: "package.json",   recommended_agent: "dependency-audit", suggested_tool: "veto_agent_plan" },
    { file: ".env",           recommended_agent: "secrets", suggested_tool: "veto_secrets_scan" }
  ]
```

---

## Plugin System

Register custom agents without forking:

```
~/.veto/agents/my-agent.js

export function plan(task, context) {
  return {
    agent: 'my-agent',
    task,
    tier: 2,
    approach: '...',
    steps: [...],
    checklist: [...],
    pitfalls: [...],
    patterns: [...],
    duration_estimate: '1-2 hours',
  };
}
```

Veto loads it on start. Use it in `veto_agent_plan { agent: "my-agent" }` or `veto_execute_parallel`.

---

## Cross-Platform Handoff

No accounts. No cloud services. Works on the same machine or across machines.

**Rate limit mid-task:**
```
Claude at 90%  →  veto_handoff { summary, context }
Open Gemini    →  veto_continue
Full context restored. Continue exactly where you stopped.
```

**Switch machines:**
```
Machine A  →  veto_memory_export  →  veto-export.json
               copy file any way (Dropbox, USB, scp)
Machine B  →  veto_memory_import
               veto_session_restore  →  resume instantly
```

**Platform support:**

| Platform | Works with Veto |
|---|---|
| Claude Code | ✅ Native MCP |
| Gemini CLI | ✅ MCP support |
| Codex CLI | ✅ MCP support |
| Cursor | ✅ MCP support |
| Windsurf | ✅ MCP support |
| VS Code | ✅ MCP support |

---

## Self-Learning Router

The router gets smarter as you use it:

1. Complete a task → `veto_record_outcome` with quality score (0–100)
2. After 20+ outcomes → `veto_learning_apply`
3. Tier thresholds adjust — over-routed tasks self-correct over time

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
| 11 — Smarter Council + Predictive Routing + Auto Project Map | 🔄 In Progress | v0.11.0 |
| 12 — CLI Subcommands + Diff Review + VS Code Extension | ⏳ Planned | v1.0.0 |

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+ (required — uses built-in `node:sqlite`)
- **Dependencies:** `@modelcontextprotocol/sdk` only — one package, no native addons
- **Memory:** SQLite via `node:sqlite` — zero native compilation, zero configuration, works offline
- **Cross-machine:** File-based JSON export/import — no external services, no accounts

---

## License

MIT © 2026 Jigyasu Dham
