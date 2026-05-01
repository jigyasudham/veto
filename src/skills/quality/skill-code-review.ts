// Skill: code-review — 20-point code review checklist

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'code-review',
    template: undefined,
    checklist: [
      // Correctness (1-4)
      '1. CORRECTNESS — Does the code do what the PR description says? Walk through the logic manually with a concrete example.',
      '2. EDGE CASES — Does it handle null/undefined, empty collections, zero, negative numbers, very large inputs, and concurrent calls correctly?',
      '3. ERROR HANDLING — Are all errors caught, typed, and handled? No silent swallowed errors, no bare catch blocks that discard the error.',
      '4. CONCURRENCY — Does shared mutable state have proper synchronisation? Are async operations correctly awaited? No floating promises.',

      // Security (5-7)
      '5. INPUT VALIDATION — Is all user-supplied input validated with a schema library (zod/joi) before use? No raw string concatenation into queries.',
      '6. AUTHENTICATION & AUTHORISATION — Does every data-access path check that the requesting user owns the resource? Is auth middleware applied?',
      '7. SECRETS — No hardcoded credentials, API keys, or tokens in the diff. No sensitive values logged or included in error responses.',

      // Performance (8-9)
      '8. N+1 QUERIES — Are list endpoints fetching related records in a loop? Use batch/include/join instead.',
      '9. COMPLEXITY — Are there any O(n²) or worse algorithms on large datasets? Is database access inside a loop?',

      // Types and naming (10-12)
      '10. TYPES — Is TypeScript used strictly (no `any`, no type assertions without comment)? Are interfaces and return types explicit on public functions?',
      '11. NAMING — Are variables, functions, and classes named clearly and consistently? Do boolean variables use is/has/should prefixes?',
      '12. MAGIC VALUES — Are all magic numbers and magic strings replaced with named constants or enums?',

      // Style and complexity (13-14)
      '13. COMPLEXITY — Are functions short (< 30 lines) and single-purpose? If a function requires a long comment to explain it, refactor instead.',
      '14. DUPLICATION — Is the same logic copy-pasted from elsewhere? Extract a shared utility or extend an existing one.',

      // Tests (15-16)
      '15. TEST COVERAGE — Are there tests for the new code? Do they cover the happy path, error paths, and at least one edge case?',
      '16. TEST QUALITY — Do the tests assert on the right things? Are mocks minimal and purposeful? Tests should not duplicate implementation logic.',

      // Documentation (17)
      '17. DOCUMENTATION — Do complex functions have a JSDoc comment explaining the why (not just the what)? Are public API changes reflected in the OpenAPI spec?',

      // Dependencies and build (18)
      '18. DEPENDENCIES — Are new npm packages justified? Check for license compatibility, maintenance status, and security advisories (npm audit).',

      // Observability (19)
      '19. OBSERVABILITY — Are significant operations logged at the appropriate level? Are errors logged with enough context to diagnose? No passwords in logs.',

      // Review hygiene (20)
      '20. BREAKING CHANGES — Does the change break any existing API contracts, DB schemas, or public interfaces? If so, is it properly versioned or migrated?',
    ],
    patterns: [
      'Review the diff, not the file — focus on what changed and why',
      'Ask questions instead of issuing commands: "Could this be null here?" vs "Fix this"',
      'Distinguish blocking issues (must fix) from suggestions (nice to have) in comments',
      'Approve with comments for minor non-blocking issues rather than blocking for style',
      'Check the tests before the implementation — tests reveal the intended behaviour',
    ],
    gotchas: [
      'Approving without running or reading the tests — tests are part of the code',
      'Nitpicking style when an auto-formatter (Prettier/ESLint) should enforce it',
      'Missing the forest for the trees: reviewing individual lines but missing a design flaw',
      'Not reviewing DB migrations for data safety (missing IF NOT EXISTS, backfill plan)',
      'Forgetting to check error message text — "null pointer exception" leaking to the user',
    ],
    resources: [
      'https://google.github.io/eng-practices/review/reviewer/',
      'https://mtlynch.io/code-review-love/',
      'https://www.conventionalcommits.org/ (PR title / commit message style)',
      'https://cheatsheetseries.owasp.org/cheatsheets/Code_Review_Guide_Introduction_Cheat_Sheet.html',
    ],
  };
}
