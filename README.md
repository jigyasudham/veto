# veto

> **50 agents. 28 skills. 3 AIs. Self-learning. Zero extra cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, and Gemini CLI using your existing subscriptions — giving every AI a council of specialist agents, persistent cross-platform memory, a self-learning router, and the ability to say no to bad decisions.

---

## Quick Start

```bash
npx veto@latest init
```

Add to your Claude Code MCP config (`~/.claude/mcp_servers.json`):

```json
{
  "mcpServers": {
    "veto": {
      "command": "node",
      "args": ["/path/to/dist/server.js"]
    }
  }
}
```

---

## What Veto Does

**Council** — Before any significant task, 7 specialist agents debate it in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict. Bad decisions get blocked before any code is written.

**Router** — Every task is scored locally (zero tokens) and sent to the right model tier. Rate limits are tracked across all 3 platforms. The router self-adjusts over time from recorded outcomes.

**50 Agents** — Domain experts for every task type. Each agent knows when it is the right tool and when to defer to another.

**Memory** — Sessions, decisions, knowledge, and coding patterns persist across every conversation and every platform.

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

## MCP Tools (29)

| Category | Tools |
|---|---|
| Session | `veto_status` · `veto_session_save` · `veto_session_restore` · `veto_sessions_list` |
| Router | `veto_route_task` · `veto_rate_status` |
| Council | `veto_council_debate` |
| Agents | `veto_agent_plan` · `veto_code_review` · `veto_security_scan` · `veto_secrets_scan` · `veto_execute_parallel` |
| Memory | `veto_memory_store` · `veto_memory_search` · `veto_memory_delete` · `veto_project_map_update` · `veto_project_map_get` · `veto_pattern_store` · `veto_patterns_list` · `veto_memory_export` · `veto_memory_import` |
| Learning | `veto_record_outcome` · `veto_learning_stats` · `veto_learning_apply` |
| Handoff | `veto_handoff` · `veto_continue` · `veto_platform_setup` |

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
| ChatGPT web | ❌ No MCP |

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
| 9 — Launch | ⏳ Planned | v1.0.0 |

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+
- **MCP SDK:** `@modelcontextprotocol/sdk` (official)
- **Memory:** SQLite via `node:sqlite` — zero native compilation, works offline
- **Cross-machine:** File-based JSON export/import — no external services

---

## License

MIT © 2026 Jigyasu Dham
