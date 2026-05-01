import { AgentPlan, AgentAnalysis, AgentFinding, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isRefactor = t.includes('refactor') || t.includes('clean') || t.includes('improve');
  const isReview = t.includes('review') || t.includes('audit') || t.includes('check');

  return {
    agent: 'code-quality' as WorkerAgentType,
    task,
    tier: 2,
    approach: isRefactor
      ? 'Refactor for quality by applying the three passes: first remove dead code and unused imports, then extract duplicated logic into shared utilities, then rename for clarity. Never change behaviour. Run tests after each pass.'
      : isReview
      ? 'Audit code quality across five dimensions: complexity (cyclomatic), duplication, naming clarity, function length, and comment quality. Score each 1–5 and produce a prioritised fix list ordered by impact.'
      : 'Assess code quality holistically. Identify the highest-impact improvement: the one change that most improves readability, maintainability, or testability. Deliver that change, verify nothing regressed.',
    steps: [
      'Measure cyclomatic complexity — flag any function above 10',
      'Identify duplicate blocks (3+ lines appearing 2+ times) — extract to a shared utility',
      'Check function length — flag functions over 40 lines for extraction',
      'Check naming: are variable, function, and class names self-documenting?',
      'Check nesting depth — flag logic nested 4+ levels deep',
      'Identify magic numbers and strings — replace with named constants',
      'Check for dead code: unused variables, unreachable branches, exported symbols with no consumers',
      'Check comment quality: comments should explain WHY, not WHAT',
      'Verify no TODO comments without a linked issue number',
      'Run the linter — fix all warnings, not just errors',
    ],
    checklist: [
      '[ ] No function above cyclomatic complexity 10',
      '[ ] No duplicate blocks of 3+ lines',
      '[ ] No function longer than 40 lines',
      '[ ] All names are self-documenting',
      '[ ] Nesting depth ≤ 3 levels',
      '[ ] No magic numbers or strings',
      '[ ] No dead code',
      '[ ] Linter passes with zero warnings',
      '[ ] No TODO without issue number',
    ],
    pitfalls: [
      'Renaming for style without improving clarity — churn with no gain',
      'Extracting functions so small they obscure the calling site',
      'Removing comments that explain non-obvious WHY reasons',
      'Refactoring without a test suite — introduces regressions silently',
    ],
    patterns: [
      'Three-pass refactor: dead code → duplication → naming',
      'Complexity budget: cyclomatic ≤ 10, nesting ≤ 3, length ≤ 40 lines',
      'Magic constant extraction: all literals that carry domain meaning become named constants',
    ],
    duration_estimate: '1-3 hours',
  };
}

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];
  const lines = code.split('\n');

  // Complexity: count decision points
  const decisionKeywords = /\b(if|else|for|while|case|catch|\?\?|&&|\|\|)\b/g;
  const decisions = (code.match(decisionKeywords) ?? []).length;
  if (decisions > 15) {
    findings.push({ severity: 'high', category: 'complexity', description: `High cyclomatic complexity: ~${decisions} decision points detected`, fix: 'Extract branches into well-named helper functions. Target < 10 per function.' });
  } else if (decisions > 8) {
    findings.push({ severity: 'medium', category: 'complexity', description: `Moderate complexity: ~${decisions} decision points`, fix: 'Consider extracting the most complex branches into helpers.' });
  }

  // Long functions
  const funcMatches = code.match(/(?:function\s+\w+|=>\s*\{|\w+\s*\([^)]*\)\s*\{)/g) ?? [];
  if (lines.length > 50 && funcMatches.length <= 2) {
    findings.push({ severity: 'medium', category: 'length', description: `File/function is ${lines.length} lines with few sub-functions`, fix: 'Extract logical sections into smaller, named functions.' });
  }

  // Magic numbers
  const magicNumbers = code.match(/[^.]\b([2-9]\d{1,3}|1[0-9]{2,3})\b(?!\s*[,\]])/g) ?? [];
  if (magicNumbers.length > 3) {
    findings.push({ severity: 'low', category: 'magic-values', description: `${magicNumbers.length} potential magic numbers detected`, fix: 'Extract numeric literals into named constants with descriptive names.' });
  }

  // Deep nesting
  let maxDepth = 0, currentDepth = 0;
  for (const ch of code) {
    if (ch === '{') { currentDepth++; maxDepth = Math.max(maxDepth, currentDepth); }
    else if (ch === '}') currentDepth--;
  }
  if (maxDepth > 5) {
    findings.push({ severity: 'medium', category: 'nesting', description: `Deep nesting detected: ${maxDepth} levels`, fix: 'Use early returns and guard clauses to reduce nesting depth to ≤ 3.' });
  }

  // Empty catch
  if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(code)) {
    findings.push({ severity: 'high', category: 'error-handling', description: 'Empty catch block — exception silently swallowed', fix: 'Log the error or rethrow. Never silently swallow exceptions.' });
  }

  // TODO without issue
  const todos = (code.match(/\/\/\s*TODO(?!.*#\d)/gi) ?? []).length;
  if (todos > 0) {
    findings.push({ severity: 'low', category: 'maintainability', description: `${todos} TODO comment(s) without linked issue number`, fix: 'Add issue number (e.g. // TODO #123) or resolve the TODO.' });
  }

  const critCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const score = Math.max(0, 100 - critCount * 25 - highCount * 15 - findings.filter(f => f.severity === 'medium').length * 8 - findings.filter(f => f.severity === 'low').length * 3);

  return {
    agent: 'code-quality' as WorkerAgentType,
    subject: context ?? 'code',
    findings,
    score,
    verdict: score >= 85 ? 'approved' : score >= 65 ? 'approved_with_warnings' : score >= 40 ? 'needs_revision' : 'rejected',
    summary: findings.length === 0 ? 'Code quality looks good.' : `${findings.length} quality issue(s) found. Top concern: ${findings[0].description}`,
    critical_count: critCount,
    high_count: highCount,
  };
}
