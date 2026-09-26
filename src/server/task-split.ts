// Split a natural-language request into tasks, deterministically.
//
// veto_task_parse used to answer "Add pagination to GET /users, then write
// tests, then update the README" with the task-planner's generic advice ("State
// the goal in one sentence…"), every task assigned to `coder`. This splits the
// request the user actually wrote into its clauses, keeps the order they gave,
// and routes each clause to the agent its words point at. An LLM step can
// refine it; without one, this is a real answer rather than filler.

export type SplitTask = { id: string; agent: string; task: string; dependencies: string[] };

const AGENT_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(tests?|specs?|coverage|e2e|unit|integration test)\b/i, 'tester'],
  [/\b(readme|docs?|documentation|changelog|comments?|jsdoc|guide)\b/i, 'documentation'],
  [/\b(secrets?|api keys?|credentials?|tokens? leak)\b/i, 'secrets'],
  [/\b(auth|login|oauth|jwt|session|password|permission|rbac)\b/i, 'auth'],
  [/\b(vulnerab|xss|csrf|injection|owasp|security|harden)\w*/i, 'security-scanner'],
  [/\b(migrat\w*|schema change)\b/i, 'migration'],
  [/\b(database|db|sql|query|index|table|postgres|mysql|sqlite|mongo)\b/i, 'database'],
  [/\b(deploy\w*|ci|cd|pipeline|docker\w*|kubernetes|k8s|terraform|github actions)\b/i, 'devops'],
  [/\b(perf\w*|slow|latency|optimi[sz]e|cache|caching|memory leak)\b/i, 'performance'],
  [/\b(refactor\w*|clean ?up|restructure|extract)\b/i, 'refactor'],
  [/\b(bug|fix|crash|error|broken|debug\w*|regression)\b/i, 'debugger'],
  [/\b(ui|ux|css|component|page|button|form|frontend|react|vue|layout|style)\b/i, 'frontend'],
  [/\b(endpoint|api|route|rest|graphql|pagination|webhook)\b/i, 'api'],
  [/\b(a11y|accessib\w*|wcag|screen reader)\b/i, 'accessibility'],
];

export function agentFor(text: string): string {
  for (const [re, agent] of AGENT_KEYWORDS) if (re.test(text)) return agent;
  return 'coder';
}

/** Clauses of a request: list items first, else sentences and "then/and then/;" joins. */
export function splitTask(description: string, max = 20): SplitTask[] {
  const text = description.trim();
  let parts: string[];
  let ordered: boolean;
  const listItems = text.split(/\r?\n/).map(l => l.trim()).filter(l => /^([-*•]|\d+[.)])\s+/.test(l));
  if (listItems.length >= 2) {
    parts = listItems.map(l => l.replace(/^([-*•]|\d+[.)])\s+/, ''));
    ordered = /^\d/.test(listItems[0]);
  } else {
    ordered = /\b(then|after that|afterwards|next|finally|first)\b/i.test(text);
    parts = text
      .split(/(?:[.;!?]\s+|\s*,?\s*\b(?:and then|then|after that|afterwards|next|finally)\b\s*,?\s*)/i)
      .map(p => p.replace(/^(first|and|also)\b[\s,]*/i, '').trim())
      .filter(p => p.length > 2);
  }
  if (!parts.length) parts = [text];
  return parts.slice(0, max).map((task, i) => ({
    id: `task-${i + 1}`,
    agent: agentFor(task),
    task: task.replace(/[.;]+$/, ''),
    dependencies: ordered && i > 0 ? [`task-${i}`] : [],
  }));
}
