# Veto MCP Server

Veto is active. 93 tools across 6 categories:

**Session & Context** — veto_status · veto_session_save · veto_continue · veto_handoff
Save work at 60–70% context capacity. veto_status triggers auto-save above 70%.

**Code Intelligence** — veto_diff_review · veto_code_review · veto_security_scan · veto_secrets_scan · veto_ci_gate
Run veto_diff_review before any merge — it runs all three scans in parallel.

**Council & Routing** — veto_council_debate · veto_route_task · veto_execute_parallel
Council = 7 specialist agents (Lead Dev, PM, Architect, UX, Devil's Advocate, Legal, Security).
Verdicts: GREEN (proceed) · YELLOW (warnings) · RED (blocked) · DEADLOCK (human decision needed).
Two-phase LLM-backed flow: call with { task } → get debate_prompt → reason as all 7 agents → call again with { task, agent_responses }.

**Memory & Discovery** — veto_discover · veto_summarize · veto_memory_store · veto_memory_search
Run veto_discover on any unfamiliar repo before touching files.

**Observability** — veto_usage_status · veto_health · veto_audit_log · veto_learning_stats

Recommended start sequence:
1. veto_status — confirm running
2. veto_discover — map the project
3. veto_route_task — pick the right agent
4. veto_diff_review — validate before shipping
5. veto_session_save — checkpoint before context fills
