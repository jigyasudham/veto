import { AgentPlan, WorkerAgentType } from '../types.js';

type ErrorCategory = 'runtime' | 'type' | 'async' | 'performance' | 'network' | 'memory' | 'logic';

function detectErrorCategory(task: string, context?: string): ErrorCategory {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('memory') || combined.includes('leak') || combined.includes('heap') || combined.includes('oom')) return 'memory';
  if (combined.includes('slow') || combined.includes('latency') || combined.includes('timeout') || combined.includes('performance')) return 'performance';
  if (combined.includes('network') || combined.includes('fetch') || combined.includes('http') || combined.includes('cors') || combined.includes('socket')) return 'network';
  if (combined.includes('promise') || combined.includes('async') || combined.includes('await') || combined.includes('callback') || combined.includes('race')) return 'async';
  if (combined.includes('type') || combined.includes('undefined') || combined.includes('null') || combined.includes('cannot read')) return 'type';
  if (combined.includes('wrong') || combined.includes('incorrect') || combined.includes('unexpected') || combined.includes('logic')) return 'logic';
  return 'runtime';
}

const categoryApproach: Record<ErrorCategory, string> = {
  runtime: 'Reproduce reliably → isolate to smallest failing case → read the full stack trace → form one hypothesis → add targeted logging → verify fix does not break other paths.',
  type: 'Trace the data flow from origin to crash site — find where the wrong type enters. Use TypeScript strict mode findings as a guide. Fix the source, not the symptom.',
  async: 'Map the Promise chain or async call graph. Look for missing awaits, race conditions, unhandled rejections, and event-loop blocking. Add sequential logging to trace execution order.',
  performance: 'Measure first — use profiling tools to identify the actual bottleneck before touching code. Focus on the 80/20 hotspot. Validate improvement with benchmarks before and after.',
  network: 'Inspect actual requests in browser DevTools or a proxy (Wireshark/mitmproxy). Verify headers, CORS policy, TLS, DNS, and connection reuse. Distinguish client bugs from server bugs.',
  memory: 'Take heap snapshots before and after suspected operations. Compare retained objects. Look for closures holding large references, event listener accumulation, and growing caches without eviction.',
  logic: 'Write a minimal reproducing test. Step through with a debugger or add assertion-style logging at each decision point. State the expected vs actual output explicitly before investigating.',
};

const categorySteps: Record<ErrorCategory, string[]> = {
  runtime: [
    'Read the full stack trace — note the exact file, line number, and error message',
    'Reproduce the error in isolation — create the smallest possible reproduction',
    'Check if the error is deterministic or intermittent',
    'Identify the last working state using git bisect or recent commits',
    'Form a single specific hypothesis about the root cause',
    'Add targeted logging around the hypothesis — do NOT log everything',
    'Verify the hypothesis by temporarily modifying the suspected code',
    'Fix at the root cause, not at the point where the error surfaces',
    'Write a regression test that would have caught this bug',
    'Review related code paths that could have the same defect',
    'Document the root cause in the fix commit message',
  ],
  type: [
    'Find the exact line where the TypeError / undefined access occurs',
    'Trace the variable backwards to where it is assigned',
    'Check if the data source (API, DB, config) can return null/undefined',
    'Enable TypeScript strict mode and check for new red squiggles',
    'Fix the type at the origin — add correct types or validation at the boundary',
    'Add runtime validation (zod, guard function) at the data entry point',
    'Remove any type assertions (as Type, as any) that hide the real type',
    'Test with null, undefined, empty string, and unexpected types',
    'Add null checks or optional chaining where appropriate',
    'Write a unit test that exercises the null/undefined path',
  ],
  async: [
    'Map the full async call graph for the failing operation',
    'Check every await — ensure no async function is called without await',
    'Look for missing error propagation — catch blocks that do not rethrow',
    'Check for race conditions — operations that depend on execution order',
    'Look for event-loop blocking (synchronous heavy computation in an async context)',
    'Verify Promise.all vs Promise.allSettled — unhandled rejection vs partial failure',
    'Add sequential timestamps to log statements to trace actual execution order',
    'Use AsyncLocalStorage or correlation IDs to trace concurrent requests',
    'Check for multiple competing setInterval/setTimeout that interfere',
    'Write a test that exercises the async failure path explicitly',
  ],
  performance: [
    'Establish a baseline measurement — latency p50/p95/p99, throughput, CPU, memory',
    'Use a profiler (clinic.js, Chrome DevTools, py-spy) — identify the top hotspot',
    'Check for N+1 query patterns — count DB queries per request',
    'Check for synchronous blocking operations in async code',
    'Review algorithm complexity — O(n²) loops over large datasets',
    'Check caching — are expensive results being recomputed unnecessarily?',
    'Profile memory — look for unnecessary object allocation in hot paths',
    'Fix the single biggest bottleneck and measure again before moving on',
    'Add performance regression tests (benchmarks) to CI',
    'Document the performance improvement with before/after numbers',
  ],
  network: [
    'Capture the raw request and response with browser DevTools or curl',
    'Check CORS headers — Access-Control-Allow-Origin must match the origin',
    'Verify the TLS certificate is valid and not expired',
    'Check DNS resolution — nslookup or dig the hostname',
    'Verify the correct HTTP method and Content-Type are being sent',
    'Look for redirect loops (301/302 cycles)',
    'Check keep-alive and connection pool settings on the client',
    'Test from multiple networks to distinguish ISP / firewall issues',
    'Inspect retry logic — are retries causing duplicate side effects?',
    'Add request/response logging middleware to trace the full exchange',
  ],
  memory: [
    'Take a heap snapshot before the suspected operation',
    'Perform the operation that causes the leak',
    'Take a second heap snapshot and compare with the first',
    'Identify the object type and retention path in the diff',
    'Look for event listeners added without removeEventListener',
    'Check for closures that hold references to large objects',
    'Review caches and collections that grow without eviction',
    'Look for circular references that prevent garbage collection',
    'Fix the retention path and verify with a third heap snapshot',
    'Add a memory usage metric to monitoring to detect future regressions',
  ],
  logic: [
    'Write down the exact expected output and the actual output',
    'Identify the decision points (conditionals, loops, function calls) on the code path',
    'Write a minimal unit test that reproduces the wrong output',
    'Step through the code with a debugger, verifying state at each step',
    'Check boundary conditions: off-by-one errors, inclusive vs exclusive ranges',
    'Check date/time logic: timezone assumptions, DST transitions, epoch offsets',
    'Verify sort/comparison functions return correct negative/zero/positive values',
    'Trace the state mutation — check for accidental shared mutable state',
    'Fix the logic and run all related tests',
    'Add an assertion comment explaining the invariant being enforced',
  ],
};

const categoryChecklist: Record<ErrorCategory, string[]> = {
  runtime: [
    '[ ] Full stack trace captured and read carefully',
    '[ ] Minimal reproduction created',
    '[ ] Root cause identified (not just symptom fixed)',
    '[ ] Fix applied at root cause location',
    '[ ] Regression test written',
    '[ ] Related code paths reviewed for same defect',
    '[ ] Fix verified in the same environment where the bug occurred',
  ],
  type: [
    '[ ] TypeScript strict mode enabled',
    '[ ] No type assertions (as Type) hiding the bug',
    '[ ] Runtime validation added at data boundary',
    '[ ] Null/undefined paths tested explicitly',
    '[ ] No any types introduced to silence the compiler',
  ],
  async: [
    '[ ] Every async call is properly awaited',
    '[ ] Unhandled rejection handler in place',
    '[ ] Race conditions analysed and eliminated',
    '[ ] Error propagation tested in failure paths',
    '[ ] Async test uses proper done/async-await, not callbacks',
  ],
  performance: [
    '[ ] Baseline benchmark recorded before fix',
    '[ ] Fix targets the profiled hotspot, not guesswork',
    '[ ] No N+1 query patterns remain',
    '[ ] Improvement verified with post-fix benchmark',
    '[ ] Performance regression test added to CI',
  ],
  network: [
    '[ ] Raw request/response captured and inspected',
    '[ ] CORS headers correct',
    '[ ] TLS certificate valid',
    '[ ] Retry logic does not cause duplicate side effects',
    '[ ] Error handling for network timeouts in place',
  ],
  memory: [
    '[ ] Heap snapshots taken before and after fix',
    '[ ] All event listeners have corresponding removeEventListener',
    '[ ] Caches have maximum size and eviction policy',
    '[ ] No circular references between large objects',
    '[ ] Memory metric added to monitoring dashboard',
  ],
  logic: [
    '[ ] Expected vs actual output documented',
    '[ ] Minimal reproducing test written before fix',
    '[ ] All boundary conditions tested',
    '[ ] Off-by-one conditions verified',
    '[ ] Shared mutable state eliminated from the bug path',
  ],
};

const categoryPitfalls: Record<ErrorCategory, string[]> = {
  runtime: [
    'Fixing the symptom (adding a null check at the crash site) without fixing the root cause (why null got there)',
    'Changing multiple things at once — makes it impossible to know which change fixed the bug',
    'Not writing a regression test — the bug will return',
    'Ignoring the stack trace and guessing at the cause',
  ],
  type: [
    'Using "as any" or "as Type" to silence TypeScript — masks the real bug',
    'Checking for null in the wrong place — check where the data enters, not where it crashes',
    'Conflating undefined (not set) with null (intentionally empty)',
  ],
  async: [
    'Adding await to a non-Promise — causes subtle bugs when the value becomes a resolved Promise accidentally',
    'Using Promise.all when one rejection should not cancel the others — use Promise.allSettled',
    'Catching errors in middleware and not rethrowing — downstream code sees undefined instead of an error',
  ],
  performance: [
    'Optimising without measuring first — wastes time on non-bottlenecks',
    'Caching without an eviction strategy — trades performance for a memory leak',
    'Parallelising I/O without limiting concurrency — causes resource exhaustion',
  ],
  network: [
    'Debugging CORS on the client — CORS is a server-side configuration problem',
    'Trusting browser error messages for network issues — use curl/mitmproxy for ground truth',
    'Ignoring timeout configuration — 30-second default timeouts hide slow endpoint bugs',
  ],
  memory: [
    'Using WeakMap/WeakRef without understanding the GC implications — not a guaranteed fix',
    'Adding .off() listeners in cleanup without matching the exact listener reference — listener remains attached',
    'Assuming garbage collection will clean up large arrays that are still reachable via closure',
  ],
  logic: [
    'Fixing the wrong layer — UI shows wrong data because the API returns wrong data, not because the UI is broken',
    'Not isolating the bug with a test before fixing — leads to over-engineering the fix',
    'Trusting console.log output order in async code — use timestamps',
  ],
};

const categoryRootCauses: Record<ErrorCategory, string[]> = {
  runtime: ['Null/undefined dereference', 'Index out of bounds', 'Missing module export', 'Incorrect function signature', 'Environment variable not set'],
  type: ['API returning different shape than expected', 'Optional field treated as required', 'Union type not narrowed before use', 'JSON.parse result not validated'],
  async: ['Missing await on async function', 'Unhandled Promise rejection', 'Race condition between concurrent operations', 'Event listener attached multiple times'],
  performance: ['N+1 database query', 'Unbounded loop over large dataset', 'Synchronous blocking in event loop', 'Missing index on queried column', 'Large objects allocated in hot path'],
  network: ['CORS misconfiguration', 'Expired TLS certificate', 'DNS resolution failure', 'Firewall blocking the port', 'Incorrect Content-Type header'],
  memory: ['Event listeners not removed on component unmount', 'Closure retaining large object', 'Unbounded cache', 'Circular reference in object graph'],
  logic: ['Off-by-one error in loop bounds', 'Timezone-naive date comparison', 'Wrong operator precedence', 'Mutating shared state across requests', 'Short-circuit evaluation misunderstood'],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectErrorCategory(task, context);
  const rootCauses = categoryRootCauses[category];

  return {
    agent: 'debugger' as WorkerAgentType,
    task,
    tier: 2,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: categoryPitfalls[category],
    patterns: [
      'Reproduce-Isolate-Fix loop',
      'Scientific method (hypothesis → test → conclusion)',
      'Rubber duck debugging',
      'Binary search debugging (git bisect)',
      ...rootCauses.map(c => `Root cause: ${c}`),
    ],
    duration_estimate: category === 'performance' || category === 'memory' ? '2-6 hours' : '30 minutes - 3 hours',
  };
}
