# veto

> **47 agents. 28 skills. 3 AIs. Self-learning. Zero extra cost.**

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

## What's Built (Phase 1)

- MCP server skeleton — connects to Claude Code via stdio
- SQLite memory (zero setup, works offline) using Node.js built-in `node:sqlite`
- `veto_status` — server health check
- `veto_session_save` — compress and save session context
- `veto_session_restore` — restore any previous session by ID
- `veto_sessions_list` — list all saved sessions

---

## Roadmap

| Phase | Status | Feature |
|-------|--------|---------|
| 1 | ✅ Done | MCP skeleton + SQLite memory + session save/restore |
| 2 | Planned | Router — complexity scorer, rate limit monitor, tier assignment |
| 3 | Planned | Council — 6 agents debate every task before execution |
| 4 | Planned | 47 worker agents + 28 skills |
| 5 | Planned | Memory agents + cross-session continuity |
| 6 | Planned | Self-learning — 4 learning loops |
| 7 | Planned | Cross-platform — Codex + Gemini adapters |
| 8 | Planned | Full release + benchmarks |

---

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js 22+
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Memory:** `node:sqlite` (built-in, zero deps)
- **Distribution:** npm / npx

---

## License

MIT © 2026 Jigyasu Dham
