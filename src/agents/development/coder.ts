import { AgentPlan, WorkerAgentType } from '../types.js';

type TaskCategory = 'api-endpoint' | 'ui-component' | 'utility' | 'service' | 'general';

function detectCategory(task: string): TaskCategory {
  const t = task.toLowerCase();
  if (t.includes('endpoint') || t.includes('route') || t.includes('controller') || t.includes('rest') || t.includes('graphql')) return 'api-endpoint';
  if (t.includes('component') || t.includes('ui') || t.includes('button') || t.includes('form') || t.includes('modal') || t.includes('page')) return 'ui-component';
  if (t.includes('util') || t.includes('helper') || t.includes('format') || t.includes('parse') || t.includes('transform')) return 'utility';
  if (t.includes('service') || t.includes('manager') || t.includes('handler') || t.includes('processor') || t.includes('worker')) return 'service';
  return 'general';
}

const categoryApproach: Record<TaskCategory, string> = {
  'api-endpoint': 'Design the contract first (request/response types), implement handler with validation, wire middleware chain, write integration tests.',
  'ui-component': 'Define props interface, sketch component tree, implement stateless core first then add state/effects, ensure accessibility, write render tests.',
  'utility': 'Write pure functions with explicit input/output types, cover all edge cases including null/undefined/empty, optimise for readability over cleverness.',
  'service': 'Apply Dependency Injection, define interface before class, implement with repository abstraction, propagate typed errors, add unit tests for each method.',
  'general': 'Define types first, implement incrementally, handle all error paths explicitly, add JSDoc for public APIs, write tests in parallel with implementation.',
};

const categorySteps: Record<TaskCategory, string[]> = {
  'api-endpoint': [
    'Define TypeScript interfaces for request body, query params, and response payload',
    'Write input validation schema (zod or class-validator)',
    'Stub out the route handler and wire it in the router',
    'Implement business logic in a dedicated service class',
    'Add authentication/authorisation middleware as required',
    'Implement error handling — map domain errors to HTTP status codes',
    'Add request logging and correlation ID propagation',
    'Write integration tests hitting the endpoint directly',
    'Document the endpoint with OpenAPI/JSDoc annotations',
    'Test error paths: missing fields, invalid types, unauthorised access',
  ],
  'ui-component': [
    'Define the Props interface with JSDoc on each prop',
    'Sketch the component tree — identify sub-components to extract',
    'Implement the purely presentational render first with hardcoded data',
    'Replace hardcoded data with props, add PropTypes/TypeScript narrowing',
    'Add local state and effects only after the static render is correct',
    'Implement loading and error states',
    'Add keyboard navigation and ARIA attributes',
    'Test with screen reader using browser dev tools',
    'Add responsive CSS — mobile first with breakpoints',
    'Write render tests covering each significant prop combination',
  ],
  'utility': [
    'Write function signature with explicit parameter and return types',
    'Document expected input/output with JSDoc examples',
    'Handle null, undefined, and empty inputs explicitly',
    'Handle boundary conditions (zero, negative, overflow, max-length)',
    'Implement the happy-path logic',
    'Add guards and early returns for invalid inputs',
    'Write unit tests for each distinct input category',
    'Benchmark if the utility is on a hot path',
    'Export from an index barrel so imports stay clean',
  ],
  'service': [
    'Define the service interface (IMyService) with all public methods',
    'List constructor dependencies — inject via interface not concrete class',
    'Write method stubs with return types before implementing',
    'Implement each method with a single clear responsibility',
    'Use typed Result or throw typed domain errors — no raw Error strings',
    'Log structured data (not plain strings) at appropriate log levels',
    'Write unit tests with mocked dependencies for each method',
    'Write integration test against a real dependency (DB, API) if applicable',
    'Document retry / circuit-breaker strategy for external calls',
    'Add health-check method if the service wraps an external resource',
  ],
  'general': [
    'Clarify and write down acceptance criteria before touching code',
    'Define all TypeScript types/interfaces needed',
    'Break the work into small independently testable functions',
    'Implement incrementally — make it work, then make it right',
    'Handle all error paths explicitly with typed errors',
    'Add JSDoc to every exported symbol',
    'Write unit tests alongside implementation',
    'Run the linter and fix all warnings',
    'Review the diff for accidental debug code or console.log statements',
    'Update relevant documentation or README if the public API changes',
  ],
};

const categoryChecklist: Record<TaskCategory, string[]> = {
  'api-endpoint': [
    '[ ] Request DTO fully typed with validation annotations',
    '[ ] Response DTO typed — no raw any or unknown leaking out',
    '[ ] HTTP status codes are semantically correct (201 vs 200, 422 vs 400)',
    '[ ] Auth middleware applied where required',
    '[ ] Rate limiting considered',
    '[ ] Input sanitisation prevents injection',
    '[ ] Async handler wrapped to forward errors to Express error middleware',
    '[ ] Pagination implemented for list endpoints',
    '[ ] Integration test covers 200, 400, 401, 404, 500 paths',
    '[ ] OpenAPI annotation added',
    '[ ] No secrets or PII logged',
    '[ ] Idempotency considered for mutating endpoints',
  ],
  'ui-component': [
    '[ ] Props interface exported and all props documented',
    '[ ] No inline styles — use CSS modules or styled components',
    '[ ] Loading state renders a skeleton or spinner',
    '[ ] Error state renders a user-friendly message',
    '[ ] Empty state renders a meaningful prompt',
    '[ ] ARIA roles and labels present on interactive elements',
    '[ ] Tab order is logical',
    '[ ] Component is keyboard-operable without mouse',
    '[ ] Works at 320 px (mobile) and 1440 px (desktop)',
    '[ ] No useEffect with missing dependency array entries',
    '[ ] Memoisation applied only where profiling justifies it',
    '[ ] Render test covers loading, error, and data states',
  ],
  'utility': [
    '[ ] Function is pure — no hidden side effects',
    '[ ] Returns typed result, not any',
    '[ ] Handles null and undefined inputs without throwing',
    '[ ] Handles empty string and empty array inputs',
    '[ ] Handles numeric edge cases (NaN, Infinity, 0, negative)',
    '[ ] Unit test for each distinct input category',
    '[ ] Exported from barrel index',
    '[ ] JSDoc with @param, @returns, and @example',
  ],
  'service': [
    '[ ] Interface defined before implementation class',
    '[ ] All dependencies injected — no new SomeDependency() in methods',
    '[ ] Each public method has a single responsibility',
    '[ ] Typed errors thrown — no throw new Error("raw string")',
    '[ ] External calls have timeout configured',
    '[ ] Unit tests mock all external dependencies',
    '[ ] Integration test covers the real dependency path',
    '[ ] Logs structured objects, not string concatenation',
    '[ ] No business logic in the constructor',
    '[ ] Service registered in the DI container',
  ],
  'general': [
    '[ ] Acceptance criteria written before coding',
    '[ ] All types explicit — no implicit any',
    '[ ] All error paths handled',
    '[ ] JSDoc on every exported symbol',
    '[ ] Unit tests written alongside implementation',
    '[ ] No console.log left in committed code',
    '[ ] Linter passes with zero warnings',
    '[ ] No TODO comments without a linked issue number',
    '[ ] Public API is backwards-compatible or version-bumped',
    '[ ] Documentation updated if the public API changed',
  ],
};

const categoryPitfalls: Record<TaskCategory, string[]> = {
  'api-endpoint': [
    'Forgetting to await async middleware — silently skips auth checks',
    'Returning 200 for operations that create resources — use 201',
    'Leaking internal stack traces to the client in production',
    'Not validating Content-Type header before parsing body',
    'Using req.body directly without validation — injection risk',
  ],
  'ui-component': [
    'Calling setState inside useEffect without a dependency array — infinite loop',
    'Forgetting key prop on list items — causes subtle reconciliation bugs',
    'Storing derived data in state instead of computing it on render',
    'Leaving event listeners without cleanup in useEffect return',
    'Assuming controlled and uncontrolled prop modes cannot conflict',
  ],
  'utility': [
    'Using == instead of === for null checks — misses undefined',
    'Mutating the input array or object instead of returning a new one',
    'Assuming parseInt always returns a number — it returns NaN on bad input',
    'Using Date arithmetic without accounting for timezone offsets',
  ],
  'service': [
    'Catching and swallowing errors silently — log and rethrow or return Result',
    'Doing database work in the constructor — blocks DI container startup',
    'Sharing mutable state across concurrent requests — use per-request scope',
    'Not configuring timeout on external HTTP calls — hangs indefinitely',
  ],
  'general': [
    'Premature optimisation before profiling — adds complexity with no gain',
    'Mixing abstraction levels in a single function — extract sub-functions',
    'Returning null instead of throwing when the contract is violated',
    'Copy-pasting similar blocks instead of extracting a parameterised function',
  ],
};

const categoryPatterns: Record<TaskCategory, string[]> = {
  'api-endpoint': ['Command pattern', 'Chain of Responsibility (middleware)', 'DTO pattern', 'Repository pattern', 'Decorator pattern (route guards)'],
  'ui-component': ['Compound component pattern', 'Render props', 'Custom hook extraction', 'Container / Presenter split', 'Controlled component pattern'],
  'utility': ['Pure function', 'Pipe / compose', 'Guard clause early return', 'Option/Result type', 'Memoisation'],
  'service': ['Dependency Injection', 'Repository pattern', 'Strategy pattern', 'Result type', 'Façade pattern'],
  'general': ['Single Responsibility Principle', 'Dependency Inversion', 'Guard clauses', 'Factory function', 'Module pattern'],
};

const categoryDuration: Record<TaskCategory, string> = {
  'api-endpoint': '2-4 hours',
  'ui-component': '3-6 hours',
  'utility': '1-2 hours',
  'service': '4-8 hours',
  'general': '2-4 hours',
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'coder' as WorkerAgentType,
    task,
    tier: 2,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: categoryPitfalls[category],
    patterns: categoryPatterns[category],
    duration_estimate: categoryDuration[category],
  };
}
