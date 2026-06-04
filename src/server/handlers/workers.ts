// Tools that are pure delegations to the 2-phase agentic worker loop
// (handleAgenticWorker). They need only the call args — no server-local state —
// which makes them the cleanest first domain to migrate off the switch.

import { handleAgenticWorker } from '../scan-core.js';
import type { HandlerMap, ToolHandler } from '../registry.js';
import type { WorkerAgentType } from '../../agents/types.js';

/** Builds a handler that routes a tool straight to a worker agent. */
function worker(name: string, agent: WorkerAgentType, defaultTask: string): ToolHandler {
  return (ctx) => handleAgenticWorker(name, ctx.args, agent, defaultTask);
}

export const workerHandlers: HandlerMap = {
  veto_code_review:    worker('veto_code_review', 'reviewer', 'Review the following code.'),
  veto_security_scan:  worker('veto_security_scan', 'security-scanner', 'Scan the following code for vulnerabilities.'),
  veto_secrets_scan:   worker('veto_secrets_scan', 'secrets', 'Scan for exposed secrets.'),
  veto_summarize:      worker('veto_summarize', 'documentation', 'Summarize this project/file.'),
  veto_type_coverage:  worker('veto_type_coverage', 'reviewer', 'Analyze TypeScript type coverage and suggest improvements.'),
  veto_test_gaps:      worker('veto_test_gaps', 'tester', 'Identify untested paths and suggest test cases.'),
  veto_lint_rules:     worker('veto_lint_rules', 'reviewer', 'Analyze and generate lint rules.'),
  veto_api_contract:   worker('veto_api_contract', 'api', 'Analyze or generate API contracts.'),
  veto_merge_conflict: worker('veto_merge_conflict', 'debugger', 'Resolve git merge conflicts.'),
  veto_translate:      worker('veto_translate', 'documentation', 'Translate text.'),
  veto_a11y_advisor:   worker('veto_a11y_advisor', 'accessibility', 'Analyze accessibility.'),
  veto_semantic_search: worker('veto_semantic_search', 'search-agent', 'Perform semantic search.'),
  veto_sdd_agent:      worker('veto_sdd_agent', 'task-planner', 'Execute SDD actions.'),
  veto_playwright:     worker('veto_playwright', 'tester', 'Coordinate Playwright browser session.'),

  // agent type depends on whether a file path was supplied
  veto_explain: (ctx) => handleAgenticWorker(
    'veto_explain',
    ctx.args,
    ctx.args?.file_path ? 'coder' : 'debugger',
    String(ctx.args?.text || 'Explain this.'),
  ),
};
