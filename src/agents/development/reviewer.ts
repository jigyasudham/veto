import { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity, WorkerAgentType } from '../types.js';

// ─── plan ────────────────────────────────────────────────────────────────────

export function plan(task: string, context?: string): AgentPlan {
  const isApi      = /api|endpoint|route|rest|graphql/i.test(task);
  const isDb       = /database|schema|migrat|sql|query/i.test(task);
  const isSecurity = /auth|jwt|oauth|password|token|secret|crypt/i.test(task);
  const isAsync    = /async|await|promise|concurrent|parallel/i.test(task);
  const isPR       = /pr|pull.?request|diff|patch|commit/i.test(task);
  const hasContext = context && context.length > 50;

  const focusSteps: string[] = [];
  if (isApi)      focusSteps.push('Verify all route handlers validate input with a schema — check for missing type guards on body/params/query');
  if (isDb)       focusSteps.push('Check SQL queries for parameterisation — no string concatenation of user input', 'Verify every write is inside an explicit transaction');
  if (isSecurity) focusSteps.push('Audit authentication and authorisation logic — verify role checks are server-side, not client-supplied', 'Check token expiry, storage location, and revocation path');
  if (isAsync)    focusSteps.push('Trace every Promise — verify all are awaited or explicitly fire-and-forget with error logging', 'Look for race conditions in concurrent operations');
  if (isPR)       focusSteps.push('Focus on changed lines only — do not review unchanged context', 'Check if tests were added for new behavior');

  return {
    agent: 'reviewer' as WorkerAgentType,
    task,
    tier: 2,
    approach: `Systematic review${isApi ? ' of API layer' : isDb ? ' of database layer' : isSecurity ? ' with security focus' : ''}: correctness first, then maintainability, then style. Produce scored findings with actionable fixes.${hasContext ? ' Project context has been injected.' : ''}`,
    steps: [
      'Read the module top-to-bottom to understand its purpose and public contract',
      'Identify all exported symbols and verify they are intentional',
      ...focusSteps,
      'Check function lengths — flag any function exceeding 50 lines for extraction',
      'Assess cyclomatic complexity — any function with more than 10 branches is a risk',
      'Verify every async call is awaited or explicitly fire-and-forget',
      'Check error handling — all try/catch blocks must do something meaningful',
      'Scan for magic numbers and untyped string literals',
      'Measure nesting depth — refactor anything deeper than 3 levels',
      'Review naming — variables, functions, and types should be self-documenting',
      'Verify unused imports and variables are removed',
      isPR ? 'Check that tests were added or updated for every changed behavior' : 'Confirm test coverage exists for every public function',
    ],
    checklist: [
      '[ ] No function exceeds 50 lines of executable code',
      '[ ] No function has cyclomatic complexity > 10',
      '[ ] Every await is inside an async function',
      '[ ] Every try/catch logs or rethrows — no silent swallow',
      '[ ] No magic numbers — use named constants',
      '[ ] No deeply nested if/for (max 3 levels)',
      '[ ] No unused variables or imports',
      '[ ] Naming is consistent with the project convention (camelCase, PascalCase for types)',
      '[ ] No console.log left in production paths',
      '[ ] Every exported function has at least one test',
      '[ ] No any types without an explanatory comment',
      isApi      ? '[ ] All route inputs validated with schema (zod/joi) at the handler boundary' : '',
      isDb       ? '[ ] All queries use parameterised statements — no string concatenation' : '',
      isSecurity ? '[ ] No credentials, tokens, or secrets in source or logs' : '',
    ].filter(Boolean) as string[],
    pitfalls: [
      'Approving because it "looks fine" without verifying the error path',
      'Missing async bugs — synchronous function calling async one without await silently drops the Promise',
      'Over-reviewing style while missing logic errors — correctness first',
      ...(isAsync ? ['Race conditions in concurrent code that only appear under load — check lock/mutex usage'] : []),
      ...(isApi   ? ['Missing input validation on a rarely-used parameter — the security hole is always in the edge case'] : []),
      ...(isDb    ? ['N+1 query inside a loop — only visible at scale'] : []),
    ],
    patterns: [
      'Guard clause pattern (early returns to reduce nesting)',
      'Strategy pattern (replace long switch/if chains)',
      'Extract function refactoring',
      ...(isApi  ? ['Middleware chain: authenticate → authorise → validate → handle'] : []),
      ...(isDb   ? ['Repository pattern: isolate all DB access in one layer'] : []),
    ],
    duration_estimate: isPR ? '30-60 min' : isDb || isSecurity ? '2-4 hours' : '1-2 hours',
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function countLines(code: string): number {
  return code.split('\n').length;
}

function detectFunctions(code: string): Array<{ name: string; body: string; start: number }> {
  const results: Array<{ name: string; body: string; start: number }> = [];
  const lines = code.split('\n');

  // Match function declarations and arrow functions assigned to const/let/var
  const funcRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/;

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(funcRegex);
    if (match) {
      const name = match[1] || match[2] || 'anonymous';
      let depth = 0;
      let started = false;
      const bodyLines: string[] = [];
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          if (ch === '}') depth--;
        }
        bodyLines.push(lines[j]);
        if (started && depth === 0) break;
        j++;
      }
      results.push({ name, body: bodyLines.join('\n'), start: i + 1 });
      i = j + 1;
    } else {
      i++;
    }
  }
  return results;
}

function maxNestingDepth(code: string): number {
  let max = 0;
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') { depth++; max = Math.max(max, depth); }
    if (ch === '}') depth--;
  }
  return max;
}

// ─── analyze ─────────────────────────────────────────────────────────────────

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];
  const lines = code.split('\n');
  const totalLines = countLines(code);
  const subject = context ?? `Code (${totalLines} lines)`;

  // 1. Long functions
  const functions = detectFunctions(code);
  for (const fn of functions) {
    const fnLines = fn.body.split('\n').length;
    if (fnLines > 50) {
      findings.push({
        severity: 'medium',
        category: 'Complexity',
        description: `Function '${fn.name}' is ${fnLines} lines long (limit: 50).`,
        fix: `Extract logical blocks into named helper functions. Aim for functions that do one thing and fit on one screen.`,
        location: `Line ${fn.start}`,
      });
    }
  }

  // 2. Deep nesting
  const nestingDepth = maxNestingDepth(code);
  if (nestingDepth > 5) {
    findings.push({
      severity: 'medium',
      category: 'Complexity',
      description: `Maximum brace nesting depth is ${nestingDepth} (limit: 5). Deep nesting makes code hard to reason about.`,
      fix: 'Apply guard clauses (early returns), extract inner blocks to functions, or flatten with Promise chains.',
    });
  }

  // 3. Missing error handling — try without catch, or bare promise .then without .catch
  const tryCatchBalance = (code.match(/\btry\b/g) || []).length;
  const catchBalance = (code.match(/\bcatch\b/g) || []).length;
  if (tryCatchBalance > catchBalance) {
    findings.push({
      severity: 'high',
      category: 'Error Handling',
      description: `Found ${tryCatchBalance} try block(s) but only ${catchBalance} catch block(s). Unmatched try blocks may silently swallow errors.`,
      fix: 'Ensure every try has a corresponding catch. Log the error and either rethrow or return a typed error result.',
    });
  }

  // 4. Unhandled promise (.then without .catch)
  lines.forEach((line, idx) => {
    if (/\.then\s*\(/.test(line) && !/\.catch\s*\(/.test(line)) {
      // Check next few lines for .catch
      const window = lines.slice(idx, idx + 5).join(' ');
      if (!/\.catch\s*\(/.test(window)) {
        findings.push({
          severity: 'high',
          category: 'Error Handling',
          description: `Promise .then() at line ${idx + 1} has no visible .catch() — unhandled rejection risk.`,
          fix: 'Add .catch(err => { ... }) or convert to async/await with try/catch.',
          location: `Line ${idx + 1}`,
        });
      }
    }
  });

  // 5. Magic numbers
  lines.forEach((line, idx) => {
    // Skip comments and import lines
    if (/^\s*(\/\/|\/\*|\*|import|export)/.test(line)) return;
    // Match standalone numeric literals that aren't 0 or 1
    const magicMatches = line.match(/(?<![.\w])(?:[2-9]\d*|\d{2,})(?!\w)/g);
    if (magicMatches) {
      findings.push({
        severity: 'low',
        category: 'Maintainability',
        description: `Magic number(s) [${magicMatches.join(', ')}] at line ${idx + 1}. Bare literals obscure intent.`,
        fix: 'Extract to a named constant: const MAX_RETRIES = 3; at the top of the file or in a constants module.',
        location: `Line ${idx + 1}`,
      });
    }
  });

  // 6. TODO/FIXME without issue reference
  lines.forEach((line, idx) => {
    if (/\/\/.*\b(TODO|FIXME|HACK|XXX)\b/.test(line) && !/\b(#\d+|https?:\/\/|JIRA|GH-|issue)/i.test(line)) {
      findings.push({
        severity: 'low',
        category: 'Technical Debt',
        description: `Untracked TODO/FIXME at line ${idx + 1}: "${line.trim()}"`,
        fix: 'Link to a tracking issue: // TODO(#123): fix this.',
        location: `Line ${idx + 1}`,
      });
    }
  });

  // 7. Unused variable patterns (_var that is actually used, or var that starts with _ but is referenced)
  lines.forEach((line, idx) => {
    if (/const\s+_\w+\s*=/.test(line) || /let\s+_\w+\s*=/.test(line)) {
      const varMatch = line.match(/(?:const|let)\s+(_\w+)/);
      if (varMatch) {
        const varName = varMatch[1];
        const usedElsewhere = code.split('\n').filter((_, i) => i !== idx).some(l => l.includes(varName));
        if (usedElsewhere) {
          findings.push({
            severity: 'info',
            category: 'Naming',
            description: `Variable '${varName}' starts with underscore (convention: unused) but is referenced elsewhere in the code.`,
            fix: `Rename '${varName}' to '${varName.slice(1)}' since it is actively used.`,
            location: `Line ${idx + 1}`,
          });
        }
      }
    }
  });

  // 8. Consistent naming — detect mixed camelCase / snake_case for variables
  const camelVars = (code.match(/\b(?:const|let|var)\s+([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g) || []).length;
  const snakeVars = (code.match(/\b(?:const|let|var)\s+([a-z][a-z0-9]*_[a-z][a-z0-9]*)\b/g) || []).length;
  if (camelVars > 0 && snakeVars > 0) {
    findings.push({
      severity: 'low',
      category: 'Naming',
      description: `Mixed naming convention: ${camelVars} camelCase and ${snakeVars} snake_case variable declarations detected.`,
      fix: 'Standardise on camelCase for variables and functions in TypeScript/JavaScript codebases.',
    });
  }

  // ─── Score ────────────────────────────────────────────────────────────────
  let score = 100;
  const critical_count = findings.filter(f => f.severity === 'critical').length;
  const high_count = findings.filter(f => f.severity === 'high').length;
  const medium_count = findings.filter(f => f.severity === 'medium').length;
  const low_count = findings.filter(f => f.severity === 'low').length;

  score -= critical_count * 25;
  score -= high_count * 15;
  score -= medium_count * 8;
  score -= low_count * 3;
  score = Math.max(0, Math.min(100, score));

  let verdict: AgentAnalysis['verdict'];
  if (critical_count > 0) verdict = 'rejected';
  else if (high_count > 0) verdict = 'needs_revision';
  else if (medium_count > 0 || low_count > 2) verdict = 'approved_with_warnings';
  else verdict = 'approved';

  const summary = findings.length === 0
    ? 'Code looks clean — no significant issues detected.'
    : `Found ${findings.length} issue(s): ${critical_count} critical, ${high_count} high, ${medium_count} medium, ${low_count} low. Score: ${score}/100.`;

  return {
    agent: 'reviewer' as WorkerAgentType,
    subject,
    findings,
    score,
    verdict,
    summary,
    critical_count,
    high_count,
  };
}
