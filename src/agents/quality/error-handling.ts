import { AgentPlan, AgentAnalysis, AgentFinding, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'error-handling' as WorkerAgentType,
    task,
    tier: 2,
    approach: 'Audit error handling for the three failure classes: expected failures (validation, not found, auth), unexpected failures (bugs, network failures, DB errors), and catastrophic failures (process crash, OOM). Each class needs a different treatment. Expected failures return structured error responses. Unexpected failures are logged with context and surfaced as generic errors to users. Catastrophic failures are captured by a top-level handler and alert.',
    steps: [
      'Identify all async operations: DB calls, HTTP requests, file I/O, external APIs',
      'Verify every async call has a try/catch or .catch() — no floating promises',
      'Check that catch blocks do not silently swallow errors — log OR rethrow, never neither',
      'Verify error messages to users do not leak stack traces or internal details in production',
      'Check that typed errors are used — no throw new Error("raw string") for domain errors',
      'Verify HTTP error codes are semantically correct: 400 vs 422, 401 vs 403, 404 vs 410',
      'Check that errors include enough context to diagnose: which record, which operation, what input',
      'Verify the top-level process error handler is in place: uncaughtException, unhandledRejection',
      'Check that external API timeouts are configured — no indefinite hangs',
      'Test each error path: does the system recover gracefully or leave state corrupted?',
    ],
    checklist: [
      '[ ] No floating promises — every async call awaited or .catch() chained',
      '[ ] No empty or silent catch blocks',
      '[ ] Stack traces never exposed to users in production',
      '[ ] Typed domain errors — not raw Error strings',
      '[ ] HTTP status codes semantically correct',
      '[ ] Error log includes context (what failed, on what input)',
      '[ ] process.on("uncaughtException") and ("unhandledRejection") registered',
      '[ ] All external HTTP calls have a timeout configured',
      '[ ] Error paths tested — system recovers without corrupting state',
    ],
    pitfalls: [
      'Catch-and-log without rethrowing — the caller assumes success when the operation failed',
      'Using the same error type for expected and unexpected failures — callers cannot distinguish',
      'Not including the original error in a re-thrown wrapper — stack trace lost',
      'Logging only the error message without the input that caused it — impossible to reproduce',
      'Catching Error but not checking error.name — all errors look the same',
    ],
    patterns: [
      'Error taxonomy: expected (return structured error) | unexpected (log + generic response) | catastrophic (alert)',
      'Context-rich errors: every thrown error includes the operation, input, and correlation ID',
      'Fail-fast on programming errors: throw immediately on invalid arguments — do not try to recover',
      'Structured error types: one class per error category with a code field for programmatic handling',
    ],
    duration_estimate: '2-4 hours',
  };
}

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];

  // Empty catch blocks
  const emptyCatch = (code.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) ?? []).length;
  if (emptyCatch > 0) {
    findings.push({ severity: 'critical', category: 'silent-failure', description: `${emptyCatch} empty catch block(s) — exceptions silently swallowed`, fix: 'Log the error and/or rethrow. Never swallow exceptions silently.' });
  }

  // Catch with only console.log (no rethrow)
  const logOnlyCatch = (code.match(/catch\s*\([^)]*\)\s*\{[^}]*console\.[a-z]+[^}]*\}/g) ?? [])
    .filter(block => !block.includes('throw')).length;
  if (logOnlyCatch > 0) {
    findings.push({ severity: 'high', category: 'swallowed-error', description: `${logOnlyCatch} catch block(s) log but do not rethrow — caller assumes success`, fix: 'After logging, either rethrow the error or return a typed error result to the caller.' });
  }

  // Floating promises
  const floatingPromise = (code.match(/(?<!\bawait\s)(?<!\breturn\s)\b\w+\([^)]*\)\.then\(/g) ?? []).length;
  if (floatingPromise > 1) {
    findings.push({ severity: 'high', category: 'floating-promise', description: `Potential floating promise(s) detected`, fix: 'Ensure all Promise chains are awaited or have a .catch() handler.' });
  }

  // Raw Error strings
  const rawThrows = (code.match(/throw new Error\(['"`][^'"`]{1,50}['"`]\)/g) ?? []).length;
  if (rawThrows > 2) {
    findings.push({ severity: 'medium', category: 'untyped-errors', description: `${rawThrows} raw Error string throws — callers cannot distinguish error types`, fix: 'Create typed error classes (class NotFoundError extends Error) for each distinct error category.' });
  }

  // No timeout on fetch/axios
  if (/fetch\(|axios\.|got\(|request\(/.test(code) && !/timeout/.test(code)) {
    findings.push({ severity: 'medium', category: 'missing-timeout', description: 'External HTTP call detected without apparent timeout configuration', fix: 'Add a timeout to all external HTTP calls. Unconfigured calls hang indefinitely on network issues.' });
  }

  const critCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const score = Math.max(0, 100 - critCount * 30 - highCount * 20 - findings.filter(f => f.severity === 'medium').length * 10);

  return {
    agent: 'error-handling' as WorkerAgentType,
    subject: context ?? 'code',
    findings,
    score,
    verdict: score >= 85 ? 'approved' : score >= 65 ? 'approved_with_warnings' : score >= 40 ? 'needs_revision' : 'rejected',
    summary: findings.length === 0 ? 'Error handling looks solid.' : `${findings.length} error handling issue(s). Top: ${findings[0].description}`,
    critical_count: critCount,
    high_count: highCount,
  };
}
