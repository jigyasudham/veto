import { AgentPlan, WorkerAgentType } from '../types.js';

type TestType = 'unit' | 'integration' | 'e2e';

function detectTestType(task: string, context?: string): TestType {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('e2e') || combined.includes('end-to-end') || combined.includes('playwright') || combined.includes('cypress') || combined.includes('browser')) return 'e2e';
  if (combined.includes('integration') || combined.includes('database') || combined.includes('api') || combined.includes('endpoint') || combined.includes('http')) return 'integration';
  return 'unit';
}

const typeApproach: Record<TestType, string> = {
  unit: 'Isolate the unit under test by mocking all dependencies. Cover happy path, error paths, boundary conditions, and type edge cases. Aim for 100% branch coverage on business logic.',
  integration: 'Test the interaction between real components (DB, HTTP, filesystem). Use test containers or in-memory alternatives. Verify contracts and side effects, not just return values.',
  e2e: 'Test user journeys from browser to backend. Run against a staging environment or local stack. Focus on critical paths — registration, login, core workflows. Avoid testing every permutation.',
};

const typeSteps: Record<TestType, string[]> = {
  unit: [
    'Identify the public interface of the unit under test',
    'List all logical branches (if/else, switch, try/catch, null checks)',
    'Create a test file co-located with the source file (*.test.ts)',
    'Import the unit and mock all external dependencies at the top',
    'Write the happy-path test first to establish baseline behaviour',
    'Write a test for each error or exception path',
    'Add boundary condition tests (empty array, zero, max value, null, undefined)',
    'Add a test for each async path (resolved and rejected)',
    'Verify mocks were called with the correct arguments',
    'Run coverage report and fill gaps — target 90%+ branch coverage',
    'Review test names — each should describe behaviour, not implementation',
    'Run tests in watch mode and confirm they are deterministic across runs',
  ],
  integration: [
    'Identify the integration boundary (DB, HTTP, message queue, filesystem)',
    'Set up a test database or mock server that resets between tests',
    'Write fixtures / seed data helpers',
    'Test the full request-response cycle for each endpoint/operation',
    'Verify response body schema and HTTP status codes',
    'Verify database state after mutations',
    'Test authentication and authorisation (valid token, expired token, wrong role)',
    'Test concurrent requests do not corrupt shared state',
    'Test rollback on partial failure (transaction integrity)',
    'Clean up all test data in afterEach/afterAll hooks',
    'Run tests against the CI database, not a developer\'s local DB',
    'Assert on error response shape, not just status code',
  ],
  e2e: [
    'Map the user journeys to test (registration, login, core workflow)',
    'Set up a local or staging stack with predictable seed data',
    'Write page object models (POMs) for each major screen',
    'Implement the happy-path journey test first',
    'Add negative journey tests (invalid login, blocked access)',
    'Test form validation messages appear and are readable',
    'Verify redirect behaviour after actions (post-login, post-submit)',
    'Test on at least two viewport sizes (mobile and desktop)',
    'Add accessibility checks (axe-core or Playwright a11y plugin)',
    'Assert on URL changes to ensure navigation works',
    'Run in headless mode in CI; headed mode for debugging',
    'Keep each test independent — never rely on state from a previous test',
  ],
};

const typeChecklist: Record<TestType, string[]> = {
  unit: [
    '[ ] Every public function has at least one test',
    '[ ] Every branch of a conditional is exercised',
    '[ ] Error throw / rejection is tested explicitly',
    '[ ] Mocks are reset between tests (beforeEach)',
    '[ ] No test depends on another test\'s side effects',
    '[ ] Test names use "should <behaviour> when <condition>" format',
    '[ ] No production code altered to make tests pass (unless it improves design)',
    '[ ] Tests run in under 5 seconds total',
    '[ ] Coverage threshold enforced in jest/vitest config',
    '[ ] Snapshot tests (if used) are committed and reviewed',
  ],
  integration: [
    '[ ] Test database is isolated from development database',
    '[ ] Seed data is deterministic and version-controlled',
    '[ ] All test data cleaned up after each test',
    '[ ] Auth tokens generated fresh per test',
    '[ ] Response schema validated against TypeScript types',
    '[ ] Error response shape tested, not just status code',
    '[ ] Transactions roll back correctly on failure',
    '[ ] No hardcoded ports — use dynamic port allocation',
    '[ ] CI pipeline runs integration tests in a Docker environment',
    '[ ] Tests are tagged so unit and integration can run separately',
  ],
  e2e: [
    '[ ] Page object models used — no raw selectors in test bodies',
    '[ ] data-testid attributes used for element selection (not CSS classes)',
    '[ ] Each test is fully independent (own seed data)',
    '[ ] Tests run in headless mode in CI',
    '[ ] Mobile and desktop viewports both tested',
    '[ ] Accessibility check passes on each major screen',
    '[ ] Network errors are simulated for critical flows',
    '[ ] Screenshots taken on failure for debugging',
    '[ ] Test retries configured (max 2) to handle flakiness',
    '[ ] Critical path coverage maps to product requirements',
  ],
};

const typePitfalls: Record<TestType, string[]> = {
  unit: [
    'Testing implementation details (private methods, internal state) — test behaviour, not internals',
    'Mocking the module under test — only mock its dependencies',
    'Asserting on mock call count without asserting on arguments',
    'Writing tests after the fact without TDD discipline — causes incomplete coverage',
    'Using Math.random() or Date.now() in tests without mocking — non-deterministic results',
  ],
  integration: [
    'Running integration tests against shared databases — causes test pollution between developers',
    'Forgetting to rollback DB transactions — leaves dirty state that breaks subsequent tests',
    'Hardcoding localhost ports — causes CI failures when ports are in use',
    'Not testing the unhappy auth paths — security gap',
    'Asserting only on status codes, not response body — misses contract violations',
  ],
  e2e: [
    'Using CSS class selectors — they change on style refactors and break tests',
    'Sharing state between tests — one failure cascades to all subsequent tests',
    'Testing every UI permutation — creates a massive suite that nobody maintains',
    'Ignoring flaky tests — they erode trust in the entire suite',
    'Not running e2e on CI — catching bugs only locally defeats the purpose',
  ],
};

const typePatterns: Record<TestType, string[]> = {
  unit: ['Arrange-Act-Assert', 'Mock object pattern', 'Test data builder', 'Parameterised tests', 'Given-When-Then'],
  integration: ['Test container pattern', 'Database cleaner pattern', 'Fixture factory', 'Contract testing', 'Seeding pattern'],
  e2e: ['Page Object Model', 'Journey test pattern', 'Screenplay pattern', 'Seed-and-clean pattern', 'Visual regression testing'],
};

const typeDuration: Record<TestType, string> = {
  unit: '1-3 hours',
  integration: '3-6 hours',
  e2e: '4-8 hours',
};

export function plan(task: string, context?: string): AgentPlan {
  const testType = detectTestType(task, context);
  return {
    agent: 'tester' as WorkerAgentType,
    task,
    tier: 2,
    approach: typeApproach[testType],
    steps: typeSteps[testType],
    checklist: typeChecklist[testType],
    pitfalls: typePitfalls[testType],
    patterns: typePatterns[testType],
    duration_estimate: typeDuration[testType],
  };
}
