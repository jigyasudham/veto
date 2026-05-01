import { AgentPlan, AgentAnalysis, AgentFinding, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isApi = t.includes('api') || t.includes('endpoint') || t.includes('openapi');
  const isReadme = t.includes('readme') || t.includes('getting started') || t.includes('onboard');

  return {
    agent: 'documentation' as WorkerAgentType,
    task,
    tier: 1,
    approach: isApi
      ? 'Document the API using OpenAPI 3.0. Every endpoint needs: method, path, summary, request body schema, response schemas (200, 400, 401, 404, 500), and at least one request example. Generated docs should be accurate enough that a client can integrate without reading the source code.'
      : isReadme
      ? 'Write a README that answers the four questions every new user asks: what is this, how do I install it, how do I use it, and how do I contribute. Lead with a one-sentence description, then a quick-start that works in under 5 minutes.'
      : 'Document the public API surface. Every exported function, class, and type gets a JSDoc block with: one-line description, @param for each parameter, @returns, @throws for known errors, and one @example. Internal functions do not need JSDoc.',
    steps: [
      'List all exported symbols that lack documentation',
      'For each exported function: write a one-line description that explains what it does (not how)',
      'Document every parameter: name, type, description, whether optional, default value',
      'Document the return value: type and what it represents',
      'Document known thrown errors with @throws',
      'Write at least one @example per exported function',
      'For APIs: document request/response shape with types or OpenAPI schema',
      'For README: include quick-start that works in under 5 minutes',
      'Remove outdated documentation that no longer matches the code',
      'Verify all code examples actually run correctly',
    ],
    checklist: [
      '[ ] Every exported symbol has a JSDoc block',
      '[ ] Every @param has a description (not just a type)',
      '[ ] @returns documents what is returned, not just the type',
      '[ ] @throws present for all known error paths',
      '[ ] At least one @example per exported function',
      '[ ] No documentation that contradicts the current code',
      '[ ] README quick-start tested end-to-end',
    ],
    pitfalls: [
      'Documenting HOW instead of WHY — "increments counter by 1" is not documentation',
      'Copying type signatures into prose — JSDoc @param already has the type',
      'Writing examples that do not actually run',
      'Documenting internal functions that are not part of the public API',
      'Leaving stale documentation that contradicts the current implementation',
    ],
    patterns: [
      'API-first documentation: write the docs before the implementation to clarify the contract',
      'Example-driven: code examples are the most useful documentation format',
      'Quick-start rule: a new developer should have something running in under 5 minutes',
    ],
    duration_estimate: '1-4 hours',
  };
}

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];
  const lines = code.split('\n');

  // Count exported symbols
  const exports = (code.match(/^export\s+(function|class|const|type|interface|async)/gm) ?? []).length;
  // Count JSDoc blocks before exports
  const jsdocs = (code.match(/\/\*\*[\s\S]*?\*\/\s*\nexport/g) ?? []).length;
  const undocumented = exports - jsdocs;

  if (undocumented > 0) {
    findings.push({
      severity: undocumented > 3 ? 'high' : 'medium',
      category: 'missing-docs',
      description: `${undocumented} of ${exports} exported symbol(s) lack JSDoc documentation`,
      fix: 'Add /** description */ block before each exported function, class, or type.',
    });
  }

  // Check for param docs
  const params = (code.match(/@param/g) ?? []).length;
  const funcParams = (code.match(/\([^)]{5,}\)/g) ?? []).length;
  if (exports > 0 && params === 0 && funcParams > 2) {
    findings.push({ severity: 'medium', category: 'missing-params', description: 'No @param documentation found', fix: 'Add @param {type} name — description for each parameter.' });
  }

  // Check for examples
  if (exports > 0 && !code.includes('@example')) {
    findings.push({ severity: 'low', category: 'missing-examples', description: 'No @example blocks found', fix: 'Add at least one @example showing typical usage for each exported function.' });
  }

  // Check for stale "TODO: document"
  const todoDoc = (code.match(/\/\/\s*TODO.*doc/gi) ?? []).length;
  if (todoDoc > 0) {
    findings.push({ severity: 'low', category: 'stale-todo', description: `${todoDoc} TODO documentation reminder(s) found`, fix: 'Write the documentation and remove the TODO.' });
  }

  const score = Math.max(0, 100 - findings.filter(f => f.severity === 'high').length * 20
    - findings.filter(f => f.severity === 'medium').length * 10
    - findings.filter(f => f.severity === 'low').length * 5);

  return {
    agent: 'documentation' as WorkerAgentType,
    subject: context ?? 'code',
    findings,
    score,
    verdict: score >= 85 ? 'approved' : score >= 65 ? 'approved_with_warnings' : score >= 40 ? 'needs_revision' : 'rejected',
    summary: findings.length === 0 ? 'Documentation looks complete.' : `${findings.length} documentation gap(s). Top: ${findings[0].description}`,
    critical_count: 0,
    high_count: findings.filter(f => f.severity === 'high').length,
  };
}
