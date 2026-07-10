import { describe, it, expect } from 'vitest';
import { analyze, plan } from '../../src/agents/development/performance.js';
import { executeOne } from '../../src/agents/executor.js';
import { getManifestEntry } from '../../src/agents/manifest.js';

describe('performance.analyze — runtime anti-pattern detection', () => {
  it('scores clean code as approved with no findings', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('approved');
  });

  it('flags serial await inside a loop', () => {
    const code = 'for (const id of ids) { await fetchUser(id); }\n';
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Serial Await in Loop');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
    expect(f!.location).toBe('line 1');
  });

  it('flags an async callback passed to forEach', () => {
    const code = 'users.forEach(async (u) => { await save(u); });\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Async Callback in forEach/map')).toBe(true);
  });

  it('flags nested O(n²) iteration', () => {
    const code = 'const joined = items.map(i => others.find(o => o.id === i.id));\n';
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Nested Iteration O(n²)');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });

  it('flags SELECT * queries', () => {
    const code = "const rows = await db.query('SELECT * FROM users');\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Unbounded Column Selection')).toBe(true);
  });

  it('flags synchronous filesystem I/O', () => {
    const code = "const data = fs.readFileSync('./config.json');\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Synchronous I/O')).toBe(true);
  });

  it('flags JSON.parse(JSON.stringify()) deep clone', () => {
    const code = 'const copy = JSON.parse(JSON.stringify(state));\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Inefficient Deep Clone')).toBe(true);
  });

  it('does not false-positive on a simple filter→map chain', () => {
    const code = 'const active = users.filter(u => u.active).map(u => u.name);\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(0);
  });

  it('lowers the score and reports one finding per line', () => {
    const code = "for (const id of ids) { await get(id); }\nconst q = 'SELECT * FROM t';\n";
    const r = analyze(code);
    expect(r.findings).toHaveLength(2);
    expect(r.score).toBeLessThan(100);
  });
});

describe('performance — dual-mode dispatch', () => {
  it('is registered as an analysis agent in the manifest', () => {
    expect(getManifestEntry('performance')?.output_type).toBe('analysis');
  });

  it('falls back to a domain-aware plan when no code is provided', async () => {
    const r = await executeOne({ id: 'perf1', agent: 'performance', task: 'optimize slow database query with N+1' });
    expect(r.plan).toBeDefined();
    expect(r.analysis).toBeUndefined();
    expect(r.plan!.approach.toLowerCase()).toContain('n+1');
  });

  it('runs the analyzer when code is provided', async () => {
    const r = await executeOne({
      id: 'perf2',
      agent: 'performance',
      task: 'audit',
      code: 'for (const u of users) { await sync(u); }\n',
    });
    expect(r.analysis).toBeDefined();
    expect(r.plan).toBeUndefined();
    expect(r.analysis!.findings.length).toBeGreaterThan(0);
  });
});
