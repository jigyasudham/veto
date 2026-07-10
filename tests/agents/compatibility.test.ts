import { describe, it, expect } from 'vitest';
import { analyze, plan } from '../../src/agents/quality/compatibility.js';
import { executeOne } from '../../src/agents/executor.js';
import { getManifestEntry } from '../../src/agents/manifest.js';

describe('compatibility.analyze — portability detection', () => {
  it('scores plain, widely-supported code as approved', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('approved');
  });

  it('flags structuredClone as an unguarded modern API', () => {
    const code = 'const copy = structuredClone(state);\n';
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Unguarded Modern API');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
    expect(f!.location).toBe('line 1');
  });

  it('flags Object.hasOwn', () => {
    const code = 'if (Object.hasOwn(obj, key)) doThing();\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.description.includes('Object.hasOwn'))).toBe(true);
  });

  it('flags ES2023 array methods (findLast / toSorted)', () => {
    const code = 'const last = arr.findLast(x => x > 0);\nconst s = arr.toSorted();\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every(f => f.severity === 'medium')).toBe(true);
  });

  it('flags replaceAll as a low-severity modern API', () => {
    const code = "const s = text.replaceAll(',', '');\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Modern API');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('low');
  });

  it('flags logical-assignment syntax', () => {
    const code = 'config.timeout ??= 3000;\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Modern Syntax')).toBe(true);
  });

  it('flags modern CSS features in selector strings', () => {
    const code = "document.querySelector('.card:has(> img)');\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Modern CSS Feature')).toBe(true);
  });

  it('lowers the score for detected concerns', () => {
    const code = 'const a = structuredClone(x);\nconst b = arr.toReversed();\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(2);
    expect(r.score).toBeLessThan(100);
  });
});

describe('compatibility — dual-mode dispatch', () => {
  it('is registered as an analysis agent in the manifest', () => {
    expect(getManifestEntry('compatibility')?.output_type).toBe('analysis');
  });

  it('falls back to a dimension-aware plan when no code is provided', async () => {
    const r = await executeOne({ id: 'c1', agent: 'compatibility', task: 'check browser support for our CSS' });
    expect(r.plan).toBeDefined();
    expect(r.analysis).toBeUndefined();
    expect(r.plan!.approach.toLowerCase()).toContain('browser');
  });

  it('runs the analyzer when code is provided', async () => {
    const r = await executeOne({
      id: 'c2',
      agent: 'compatibility',
      task: 'audit',
      code: 'const copy = structuredClone(state);\n',
    });
    expect(r.analysis).toBeDefined();
    expect(r.plan).toBeUndefined();
    expect(r.analysis!.findings.length).toBeGreaterThan(0);
  });
});
