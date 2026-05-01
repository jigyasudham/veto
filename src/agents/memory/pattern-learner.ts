import { AgentPlan, WorkerAgentType } from '../types.js';

type PatternCategory = 'coding-style' | 'naming' | 'error-handling' | 'testing' | 'general';

function detectCategory(task: string): PatternCategory {
  const t = task.toLowerCase();
  if (t.includes('style') || t.includes('format') || t.includes('indent') || t.includes('structure') || t.includes('code pattern')) return 'coding-style';
  if (t.includes('naming') || t.includes('convention') || t.includes('variable') || t.includes('function name') || t.includes('identifier')) return 'naming';
  if (t.includes('error') || t.includes('exception') || t.includes('catch') || t.includes('throw') || t.includes('handling')) return 'error-handling';
  if (t.includes('test') || t.includes('spec') || t.includes('unit') || t.includes('mock') || t.includes('assertion')) return 'testing';
  return 'general';
}

const categoryApproach: Record<PatternCategory, string> = {
  'coding-style': 'Observe recurring structural patterns in the codebase: file layout, function organisation, import grouping, async patterns, class vs functional preference. Record each distinct pattern via veto_memory_store (type="pattern"). Increment confidence on re-observation. Use high-confidence patterns to guide future code generation.',
  'naming': 'Extract naming conventions from the existing codebase: camelCase vs snake_case, file naming (kebab-case), export style (named vs default), constant casing (UPPER_SNAKE). Record as patterns with confidence scored by frequency. Apply consistently — an AI that ignores existing conventions creates noisy diffs.',
  'error-handling': 'Identify the error-handling contract: typed errors vs raw strings, Result types vs exceptions, HTTP error mapping conventions, logging format. Record the dominant pattern so all generated code uses the same error style. Flag when new code diverges from the established pattern.',
  'testing': 'Learn the testing conventions: framework (Jest / Vitest / Mocha), file placement (co-located vs __tests__/), describe/it nesting depth, mock style (jest.mock vs manual mocks), assertion verbosity. Record each observed pattern. Generated tests should be indistinguishable from human-written tests in this codebase.',
  'general': 'Scan recent files modified in the session. Extract 3–5 recurring patterns that are non-obvious (not just "uses TypeScript"). Store each via veto_memory_store (type="pattern"). On subsequent observations of the same pattern, call upsertPattern to increment confidence.',
};

const categorySteps: Record<PatternCategory, string[]> = {
  'coding-style': [
    'Read 5–10 representative source files across the codebase',
    'Identify the dominant import grouping order (stdlib → third-party → local)',
    'Identify async pattern: async/await vs Promise chains vs callbacks',
    'Identify class vs functional component preference',
    'Identify single-return vs early-return guard clause preference',
    'Identify comment style: JSDoc, inline comments, or none',
    'Record each as a pattern: { key: "code.async-pattern", val: "async/await with try/catch" }',
    'Call veto_memory_store for each new pattern with type="pattern"',
    'On subsequent observation, call upsertPattern to increase confidence',
    'Output a pattern summary for use in future code generation prompts',
  ],
  'naming': [
    'Scan file names in src/ to confirm naming convention (kebab-case, camelCase, etc.)',
    'Read 5 files and extract variable names to confirm camelCase vs snake_case',
    'Check constants for UPPER_SNAKE_CASE vs camelCase',
    'Check type / interface names for PascalCase confirmation',
    'Check function names for verb-first convention (getData vs getDataFetch)',
    'Check boolean variable names for is/has/can prefix convention',
    'Record each naming rule as a pattern with confidence',
    'Flag any files that violate the dominant convention — they may be intentional exceptions',
  ],
  'error-handling': [
    'Search for throw new and catch patterns across the codebase',
    'Identify if typed error classes are used (class NotFoundError extends Error)',
    'Identify if Result<T, E> pattern is used vs throwing',
    'Identify the HTTP status code mapping pattern for API errors',
    'Identify the logging format for errors (structured JSON vs console.error)',
    'Identify if error messages are user-facing strings or internal codes',
    'Record the dominant error pattern as high-confidence',
    'Record any secondary patterns as lower-confidence alternatives',
  ],
  'testing': [
    'Identify the test framework from package.json devDependencies',
    'Find test files and confirm naming convention (*.test.ts vs *.spec.ts)',
    'Confirm test file placement: co-located vs separate __tests__/ directory',
    'Read 3 test files to identify describe/it nesting depth',
    'Identify mock strategy: jest.mock() at top vs factory functions vs manual mocks',
    'Identify setup/teardown patterns (beforeEach, afterEach usage)',
    'Identify assertion library and verbosity (expect(x).toBe(y) vs x === y)',
    'Record each pattern with confidence scored by frequency across test files',
  ],
  'general': [
    'Read the 5 most recently modified source files',
    'Extract patterns that appear in 3 or more of the files',
    'Identify patterns that are non-obvious (not just "uses TypeScript")',
    'For each pattern: write a key (category.pattern-name) and a concise value',
    'Call veto_memory_store with type="pattern" for new patterns',
    'For patterns already stored, call upsertPattern to increment confidence',
    'Output a pattern summary listing key, value, and confidence for each learned pattern',
  ],
};

const categoryChecklist: Record<PatternCategory, string[]> = {
  'coding-style': [
    '[ ] At least 5 source files scanned',
    '[ ] Async pattern identified and recorded',
    '[ ] Import order identified and recorded',
    '[ ] Functional vs class preference identified',
    '[ ] Comment style identified',
    '[ ] All patterns stored via veto_memory_store',
    '[ ] Confidence incremented for re-observed patterns',
  ],
  'naming': [
    '[ ] File naming convention confirmed',
    '[ ] Variable naming convention confirmed',
    '[ ] Constant naming convention confirmed',
    '[ ] Boolean naming prefix confirmed',
    '[ ] All naming rules stored as patterns',
    '[ ] Convention violations flagged',
  ],
  'error-handling': [
    '[ ] Typed vs untyped error strategy identified',
    '[ ] Result type vs exception choice recorded',
    '[ ] HTTP error mapping pattern recorded',
    '[ ] Logging format pattern recorded',
    '[ ] Dominant pattern stored as high-confidence',
  ],
  'testing': [
    '[ ] Test framework identified',
    '[ ] Test file naming convention recorded',
    '[ ] Test file placement recorded',
    '[ ] Mock strategy identified and recorded',
    '[ ] Assertion style recorded',
    '[ ] All patterns stored with confidence',
  ],
  'general': [
    '[ ] At least 5 files scanned',
    '[ ] Only non-obvious patterns recorded',
    '[ ] pattern_key follows category.pattern-name format',
    '[ ] Existing patterns updated via upsertPattern',
    '[ ] Pattern summary outputted',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'pattern-learner' as WorkerAgentType,
    task,
    tier: 1,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: [
      'Recording obvious patterns ("uses TypeScript", "has functions") — only record non-obvious recurring choices',
      'Treating low-frequency patterns as conventions — require at least 3 observations before treating as established',
      'Conflating two different patterns: e.g. "async/await in services, promises in utilities" — store separately',
      'Not incrementing confidence on re-observation — all patterns stay at 1.0 and are equally trusted',
      'Applying learned patterns to files that deliberately deviate (e.g. legacy files, test fixtures)',
      'Over-specifying patterns: "uses 2-space indent in coder.ts" vs "uses 2-space indent across all TypeScript files"',
    ],
    patterns: [
      'Frequency-confidence: confidence increases with each additional observation of the pattern',
      'Category namespacing: key format "category.specific-pattern" enables prefix search',
      'Deviation detection: compare new code to stored patterns and flag significant divergence',
      'Pattern evolution: when a pattern changes (e.g. moving from callbacks to async/await), update the stored value rather than adding a duplicate',
    ],
    duration_estimate: '10-20 minutes',
  };
}
