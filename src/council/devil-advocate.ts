// Devil's Advocate — probes every failure mode, always challenges
import type { AgentVote } from './types.js';

// Devil always warns — never alone blocks, never approves non-trivial tasks
const PROBES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /auth|login|password|session|jwt|oauth/i,
    concern: "What happens when auth fails at 2AM? Lockout policy? Account recovery flow?",
    recommendation: 'Rate-limit auth endpoints. Lock after N failures. Build recovery email flow.',
  },
  {
    pattern: /payment|charge|billing|stripe|invoice|subscription/i,
    concern: "Idempotency keys? Double-charge prevention? What happens when payment webhook retries?",
    recommendation: 'Idempotency keys on all payment mutations. Handle webhook duplicates explicitly.',
  },
  {
    pattern: /deploy|release|rollout|push.{0,15}(prod|main|master)/i,
    concern: "Rollback procedure if this deploy breaks production? How fast can you revert?",
    recommendation: 'Document rollback runbook before deploying. Consider feature flag as kill switch.',
  },
  {
    pattern: /migrat|schema.?change|alter.?table|add.{0,10}column/i,
    concern: "Tested down-migration exists? What if this runs mid-traffic on prod?",
    recommendation: 'Test down-migration on a copy. Use zero-downtime migration patterns (expand/contract).',
  },
  {
    pattern: /\bcache\b|\bredis\b/i,
    concern: "Cache stampede on cold start? Cache poisoning from bad writes? Invalidation race?",
    recommendation: 'Probabilistic early expiry prevents stampede. Lock on cache miss for hot keys.',
  },
  {
    pattern: /email|notification|sms|push.?notif/i,
    concern: "Delivery failure handled? Retry queue? Duplicate notification prevention?",
    recommendation: 'Add retry queue with exponential backoff. Idempotency key per notification.',
  },
  {
    pattern: /webhook|callback.?url/i,
    concern: "Webhook replay attacks? Signature verification? What if your handler is slow?",
    recommendation: 'Verify webhook signatures. Respond 200 immediately, process async.',
  },
  {
    pattern: /\bapi\b|endpoint|http.?client|fetch|axios/i,
    concern: "External API goes down? Timeout set? Circuit breaker? Fallback behavior?",
    recommendation: 'Set explicit timeout (3-5s). Circuit breaker for critical external deps.',
  },
  {
    pattern: /file|upload|s3|blob|storage|bucket/i,
    concern: "Partial upload failure? Storage quota? File type validation before processing?",
    recommendation: 'Handle partial failures. Alert at 80% storage. Validate file type + scan for malware.',
  },
  {
    pattern: /cron|schedule|job|queue|worker/i,
    concern: "Job fails silently? Duplicate concurrent runs? Stuck job detection?",
    recommendation: 'Log all job outcomes. Prevent concurrent runs with distributed lock. Set max duration.',
  },
  {
    pattern: /third.?party|external.{0,15}service|vendor|sdk/i,
    concern: "Vendor going down? SDK breaking changes? Data you do not control changing format?",
    recommendation: 'Wrap in adapter layer. Monitor third-party SLA separately. Pin SDK version.',
  },
  {
    pattern: /delete|remove|drop|destroy|purge/i,
    concern: "Is this reversible? Backup before? What if it runs against wrong environment?",
    recommendation: 'Soft-delete first (add deleted_at). Hard-delete only after confirmed safe.',
  },
  {
    pattern: /rate.?limit|throttle/i,
    concern: "What happens when the rate limit is hit? User notified clearly? Retry-After header?",
    recommendation: 'Return 429 with Retry-After. Show clear user message. Log for monitoring.',
  },
  {
    pattern: /concurren|parallel|race.?condition|mutex|lock/i,
    concern: "Race condition under concurrent requests? Lock contention under load?",
    recommendation: 'Test with concurrent load. Use optimistic locking or distributed mutex.',
  },
  {
    pattern: /secret|key|token|credential|api.?key/i,
    concern: "Rotation strategy? What if this key leaks? Who has access and is it logged?",
    recommendation: 'Rotate keys on schedule. Audit access logs. Use short-lived tokens where possible.',
  },
];

// Topic-specific failure mode probes — fires when no keyword patterns match
const TOPIC_PROBES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /agent|worker|plan|executor/i,
    concern: 'Agent returns empty output with no error — who notices? How does the caller know the agent silently produced nothing useful?',
    recommendation: 'Agents must return a structured error or low-confidence flag on failure, never a silent empty result. The caller should log and surface this.',
  },
  {
    pattern: /memory|session|knowledge|persist/i,
    concern: 'Memory grows indefinitely. At 10,000 entries, search degrades. At 100,000, startup slows. Who cleans stale data?',
    recommendation: 'Define a max entry count per table. Add a background cleanup job or a veto_memory_gc tool. Test with 10k+ entries before shipping.',
  },
  {
    pattern: /llm|model|ai|gpt|claude|gemini/i,
    concern: 'LLM call takes 30 seconds and the MCP client times out. The tool returns nothing. The user retries. Now you have concurrent LLM calls for the same request.',
    recommendation: 'Set MCP tool timeout shorter than your LLM timeout. Return an in-progress token for long operations. Deduplicate concurrent calls by request hash.',
  },
  {
    pattern: /phase|feature|plan|roadmap|build/i,
    concern: 'This feature ships, nobody uses it for 6 months, and then a refactor breaks it silently because there are no tests. When does anyone find out?',
    recommendation: 'Every new feature needs at least one integration test that would fail if the feature stopped working. No tests = no confidence it survives future changes.',
  },
  {
    pattern: /vscode|extension|ide|plugin/i,
    concern: 'VS Code updates break extensions silently. Users on VS Code 1.9x may see a broken extension with no error message. Who monitors extension health?',
    recommendation: 'Test against VS Code stable + insiders in CI. Subscribe to VS Code release notes. Pin the minimum engine version in package.json.',
  },
  {
    pattern: /github|pr|api|integration|webhook/i,
    concern: 'GitHub API rate limit: 5000 requests/hour authenticated. A power user running veto_pr_review on every commit will hit this in minutes.',
    recommendation: 'Cache PR diffs by commit SHA. Show current rate limit usage in the response. Fail gracefully with a clear "rate limited, retry in X minutes" message.',
  },
  {
    pattern: /config|setting|init|setup|install/i,
    concern: 'User runs veto init on a machine where the config file is already correct. Init overwrites it silently. Their custom settings are gone.',
    recommendation: 'Before writing any config, show a diff and ask for confirmation — or at minimum back up the existing config with a .bak extension.',
  },
];

const GENERIC: { concern: string; recommendation: string } = {
  concern: "What is the failure mode here? What breaks at 2AM on a Sunday with no one watching?",
  recommendation: 'Add monitoring, alerting, and a runbook for when this breaks.',
};

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format code|update comment|add comment)\b/i;

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no failure modes to probe.', concerns: [] };
  }

  const matched: Array<{ concern: string; recommendation: string }> = [];

  for (const probe of PROBES) {
    if (probe.pattern.test(task)) {
      matched.push({ concern: probe.concern, recommendation: probe.recommendation });
    }
  }

  // If no specific probes matched, try topic-specific failure mode probes
  if (matched.length === 0) {
    for (const probe of TOPIC_PROBES) {
      if (probe.pattern.test(task)) {
        matched.push({ concern: probe.concern, recommendation: probe.recommendation });
      }
    }
  }

  // Devil always raises at least one concern for non-trivial tasks
  if (matched.length === 0) {
    matched.push(GENERIC);
  }

  const top = matched.slice(0, 3); // cap at 3 concerns to avoid flooding

  return {
    verdict: 'warn',
    reason: top[0].concern,
    concerns: top.slice(1).map(m => m.concern),
    recommendation: top.map(m => m.recommendation).join(' | '),
  };
}
