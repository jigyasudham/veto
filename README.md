# veto

> **50 agents. 28 skills. 3 AIs. Self-learning. Zero extra cost.**

An MCP server that runs locally on your machine, plugs into Claude Code, Codex CLI, and Gemini CLI using your existing subscriptions — giving every AI a council of specialist agents, persistent cross-platform memory, a self-learning router, and the ability to say no to bad decisions.

---

## Quick Start

```bash
npx veto@latest init
```

Then add to your Claude Code MCP config (`~/.claude/mcp_servers.json`):

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

## What's Built (v0.5.0 — Phase 5 Complete)

### Memory (Phase 1)
- SQLite at `~/.veto/veto.db` — zero setup, works offline
- `veto_session_save` / `veto_session_restore` / `veto_sessions_list`

### Router (Phase 2)
- Local complexity scoring (0–100, zero tokens)
- Rate limit monitoring across all 3 AI platforms
- Context compression (typical 92% reduction)
- `veto_route_task` / `veto_rate_status`

### Council (Phase 3)
- 7 specialist agents debate every task in parallel before execution
- GREEN / YELLOW / RED / DEADLOCK verdicts
- `veto_council_debate`

### Core Agents (Phase 4)
- 18 worker agents: 12 development + 6 security
- Parallel execution engine
- `veto_agent_plan` / `veto_code_review` / `veto_security_scan` / `veto_secrets_scan` / `veto_execute_parallel`

### Memory System (Phase 5)
- 5 memory agents: context manager, decision logger, project mapper, pattern learner, knowledge base
- Searchable knowledge base with full-text search
- Project structure map — navigate codebase without filesystem scans
- Coding pattern store with confidence scoring
- File-based cross-machine export/import (no external services)
- `veto_memory_store` / `veto_memory_search` / `veto_project_map_update` / `veto_project_map_get` / `veto_pattern_store` / `veto_patterns_list` / `veto_memory_export` / `veto_memory_import`

---

## Cross-Machine Memory Transfer

No accounts. No cloud services. No configuration.

```
Machine A  →  veto_memory_export  →  veto-export.json
              copy file any way you like (Dropbox, USB, scp)
Machine B  →  veto_memory_import  →  all sessions, knowledge, patterns restored
              veto_session_restore  →  continue exactly where you stopped
```

---

## Platform Support

| Platform | MCP Support | Works with Veto |
|---|---|---|
| Claude Code | Native | ✅ Full support |
| Gemini CLI | Experimental | ✅ Works |
| Codex CLI | Plugin system | ✅ Works |
| ChatGPT web/app | None | ❌ No MCP support |

---

## Roadmap

| Phase | Status | Feature |
|---|---|---|
| 1 — Foundation | ✅ Complete | MCP server + SQLite + session save/restore |
| 2 — Router | ✅ Complete | Complexity scorer + rate monitor + tier assignment |
| 3 — Council | ✅ Complete | 7-agent council + GREEN/YELLOW/RED/DEADLOCK |
| 4 — Core Agents | ✅ Complete | 18 worker agents + parallel execution + 10 skills |
| 5 — Memory System | ✅ Complete | 5 memory agents + knowledge base + project map + export/import |
| 6 — Self-Learning | 🔜 Next | 4 learning loops + router self-adjustment |
| 7 — Cross-Platform | ⏳ Planned | Codex + Gemini adapters + AI switch in < 3s |
| 8 — Complete | ⏳ Planned | All 50 agents, 28 skills, benchmarks, demo GIFs |
| 9 — Launch | ⏳ Planned | Public release |

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22.5+ (uses built-in `node:sqlite`)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official)
- **Memory:** SQLite via `node:sqlite` — zero native compilation, works offline
- **Cross-machine:** File-based JSON export/import — no external services
- **Distribution:** npm / npx

---

## License

MIT © 2026 Jigyasu Dham
