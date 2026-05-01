import { AgentPlan, WorkerAgentType } from '../types.js';

type PerfDomain = 'database' | 'network' | 'cpu' | 'memory' | 'frontend' | 'general';

function detectDomain(task: string, context?: string): PerfDomain {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('database') || combined.includes('query') || combined.includes('sql') || combined.includes('slow query') || combined.includes('n+1')) return 'database';
  if (combined.includes('network') || combined.includes('latency') || combined.includes('bandwidth') || combined.includes('api') || combined.includes('http')) return 'network';
  if (combined.includes('cpu') || combined.includes('algorithm') || combined.includes('computation') || combined.includes('big-o') || combined.includes('loop')) return 'cpu';
  if (combined.includes('memory') || combined.includes('ram') || combined.includes('heap') || combined.includes('leak') || combined.includes('gc')) return 'memory';
  if (combined.includes('frontend') || combined.includes('render') || combined.includes('fcp') || combined.includes('lcp') || combined.includes('cls') || combined.includes('bundle')) return 'frontend';
  return 'general';
}

const domainApproach: Record<PerfDomain, string> = {
  database: 'Profile slow queries with EXPLAIN ANALYZE. Eliminate N+1 patterns. Add missing indexes. Implement query result caching. Consider read replicas for read-heavy workloads.',
  network: 'Measure with real network traces (HAR file, curl --trace). Enable HTTP/2. Add connection pooling. Implement response compression. Use CDN for static assets. Cache at the edge.',
  cpu: 'Profile with clinic.js or perf_hooks to find the hotspot. Check algorithm complexity — O(n²) over thousands of items is always the first target. Move heavy computation off the event loop (worker threads).',
  memory: 'Take heap snapshots to identify retained objects. Implement LRU eviction on all caches. Remove event listeners on cleanup. Bound queue and buffer sizes. Configure GC flags for the workload.',
  frontend: 'Measure Core Web Vitals (LCP, FID, CLS) with Lighthouse. Code-split by route. Lazy-load off-screen images. Tree-shake dependencies. Remove render-blocking scripts. Implement service worker caching.',
  general: 'Establish a baseline measurement before optimising. Use a profiler to identify the actual bottleneck — never optimise by intuition. Fix one thing at a time and re-measure after each change.',
};

export function plan(task: string, context?: string): AgentPlan {
  const domain = detectDomain(task, context);

  const domainSteps: Record<PerfDomain, string[]> = {
    database: [
      'Enable query logging and collect the 10 slowest queries over a representative time window',
      'Run EXPLAIN ANALYZE on each slow query — read the execution plan top to bottom',
      'Identify sequential scans on large tables — these are the highest-priority index candidates',
      'Add indexes for missing JOIN columns, frequent WHERE filters, and ORDER BY columns',
      'Detect N+1 queries by counting DB calls per HTTP request (use a query counter middleware)',
      'Fix N+1 by using JOIN, eager loading (include in ORM), or DataLoader batching',
      'Implement query result caching for expensive read-only queries (Redis, in-memory LRU)',
      'Review ORM-generated SQL — ORMs frequently produce inefficient queries',
      'Set statement_timeout to prevent runaway queries from blocking the connection pool',
      'Consider read replicas for analytics queries that do not need fresh data',
      'Benchmark before and after with a realistic data volume (not an empty dev database)',
    ],
    network: [
      'Capture a HAR file from the browser or use curl --trace for API calls',
      'Measure Time to First Byte (TTFB) — high TTFB means server-side is slow',
      'Enable HTTP/2 — multiplexes requests over a single connection',
      'Enable Brotli or gzip compression on all text responses',
      'Implement cache-control headers for static assets (immutable for hashed files)',
      'Move static assets to a CDN geographically close to users',
      'Reduce payload size — paginate, select only needed fields, avoid sending unused data',
      'Implement connection pooling for HTTP clients making outbound requests',
      'Add keep-alive headers to reuse TCP connections',
      'Measure DNS lookup time — use DNS prefetching for known third-party domains',
      'Benchmark with Apache Benchmark or k6 at realistic concurrency levels',
    ],
    cpu: [
      'Run clinic.js flame or Node.js --prof to identify the CPU hotspot',
      'Analyse the flame graph — find the widest block (most self-time)',
      'Check the algorithm complexity of the hotspot — is it O(n²) over a large input?',
      'Replace O(n²) nested loops with O(n) approaches using hash maps or sorting',
      'Move CPU-heavy synchronous work to a worker thread pool (piscina)',
      'Cache the results of deterministic expensive computations (memoisation)',
      'Avoid creating large temporary arrays in hot paths — reuse buffers',
      'Use Buffer.allocUnsafe() instead of Buffer.alloc() where the content is immediately overwritten',
      'Profile again after the fix — confirm the hotspot is gone, not just moved',
      'Add a performance regression test that benchmarks the fixed function',
    ],
    memory: [
      'Take a heap snapshot with Chrome DevTools or --heapsnapshot-signal before the test',
      'Run the operation that causes the memory growth',
      'Take a second heap snapshot and use the Comparison view to find new retained objects',
      'Identify the shortest GC root path to the retained objects',
      'Find all unbounded caches and add LRU eviction (lru-cache npm package)',
      'Audit all EventEmitter.on() calls — ensure off() is called in cleanup',
      'Find all setInterval and setTimeout and ensure clearInterval/clearTimeout in cleanup',
      'Check for closures that capture large objects unnecessarily',
      'Set --max-old-space-size appropriately for the container memory limit',
      'Monitor heap usage in production with process.memoryUsage() sent to metrics',
      'Take a third heap snapshot after the fix to verify retention is resolved',
    ],
    frontend: [
      'Run Lighthouse on the production URL and record the Core Web Vitals baseline',
      'Fix Largest Contentful Paint (LCP) — preload the hero image, avoid render-blocking CSS/JS',
      'Fix Cumulative Layout Shift (CLS) — reserve space for images and ads with width/height attributes',
      'Fix First Input Delay / Interaction to Next Paint — break up long tasks (> 50ms) on the main thread',
      'Implement route-based code splitting with dynamic import()',
      'Lazy-load images below the fold with loading="lazy" or IntersectionObserver',
      'Audit the JavaScript bundle with webpack-bundle-analyzer or vite-bundle-visualizer',
      'Remove unused dependencies — check import cost of each third-party library',
      'Tree-shake lodash — import { debounce } from \'lodash\' not import _ from \'lodash\'',
      'Implement service worker caching for repeat visits (Workbox)',
      'Serve next-gen image formats (WebP, AVIF) with <picture> fallback',
      'Measure again with Lighthouse after each change — confirm improvement',
    ],
    general: [
      'Establish a baseline — measure latency (p50, p95, p99), throughput (rps), CPU, and memory',
      'Use a profiler appropriate to the stack — clinic.js, Pyspy, JProfiler, pprof',
      'Identify the single largest bottleneck — fix that first before anything else',
      'Check for database query issues (N+1, missing indexes, full table scans)',
      'Check for algorithmic complexity issues (O(n²) loops)',
      'Check for I/O blocking the event loop (synchronous file/network reads)',
      'Check for memory pressure causing GC pauses',
      'Fix one bottleneck at a time and re-measure after each change',
      'Add performance regression tests to CI (k6, autocannon, benchmark.js)',
      'Document the improvement with before/after numbers',
    ],
  };

  return {
    agent: 'performance' as WorkerAgentType,
    task,
    tier: 3,
    approach: domainApproach[domain],
    steps: domainSteps[domain],
    checklist: [
      '[ ] Baseline measurements recorded (p50/p95/p99 latency, throughput, CPU, memory)',
      '[ ] Profiler run — bottleneck identified, not assumed',
      '[ ] Highest-impact bottleneck fixed first',
      '[ ] No N+1 query patterns in the hot path',
      '[ ] All caches have a maximum size and eviction policy',
      '[ ] No synchronous blocking I/O in async code paths',
      '[ ] Algorithm complexity reviewed — no O(n²) over large inputs',
      '[ ] Post-fix measurement confirms improvement',
      '[ ] Performance regression test added to CI',
      '[ ] Improvement documented with before/after numbers',
    ],
    pitfalls: [
      'Optimising before profiling — wastes hours on non-bottlenecks',
      'Caching without an eviction strategy — trades a performance problem for a memory leak',
      'Fixing the wrong layer — optimising the API handler when the bottleneck is the database',
      'Measuring on a development machine with a tiny dataset — results do not reflect production',
      'Parallelising I/O without a concurrency limit — overwhelms the downstream service and causes cascading failure',
      'Trusting microbenchmarks for macro performance — benchmark the real workload, not a toy example',
    ],
    patterns: [
      'Memoisation (cache pure function results)',
      'Lazy evaluation (compute on demand, not upfront)',
      'Connection pooling (reuse expensive connections)',
      'Read-through cache (populate cache on miss, serve from cache on hit)',
      'Worker thread pool (offload CPU work from the event loop)',
      'Pagination and cursor-based pagination (bound response size)',
      'Index-only queries (cover all needed columns in the index)',
    ],
    duration_estimate: '4-8 hours',
  };
}
