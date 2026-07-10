import { describe, it, expect } from 'vitest';
import { analyze, plan } from '../../src/agents/security/privacy.js';
import { executeOne } from '../../src/agents/executor.js';
import { getManifestEntry } from '../../src/agents/manifest.js';

describe('privacy.analyze — PII exposure detection', () => {
  it('scores clean code as approved with no findings', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('approved');
    expect(r.critical_count).toBe(0);
    expect(r.high_count).toBe(0);
  });

  it('flags personal data written to logs (high, CWE-532)', () => {
    const code = "logger.info('new signup', { email: user.email });\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'PII in Logs');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
    expect(f!.cwe).toBe('CWE-532');
    expect(f!.location).toBe('line 1');
  });

  it('flags a hardcoded US SSN literal', () => {
    const code = "const ssn = '123-45-6789';\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Hardcoded PII');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('flags PII forwarded to a third-party analytics SDK', () => {
    const code = "analytics.track('signup', { email: user.email });\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'PII Shared With Third Party');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });

  it('flags special-category (GDPR Art. 9) data', () => {
    const code = 'const record = { diagnosis: patientDiagnosis };\n';
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Special Category Data (GDPR Art. 9)');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });

  it('flags PII passed in a URL query string', () => {
    const code = "const url = `/verify?email=${encodeURIComponent(user.email)}`;\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'PII in URL')).toBe(true);
  });

  it('reports at most one finding per line and lowers the score for issues', () => {
    const code = "logger.info('signup', user.email);\nconst ssn = '123-45-6789';\n";
    const r = analyze(code);
    expect(r.findings).toHaveLength(2); // one per line
    expect(r.score).toBeLessThan(100);
    expect(r.verdict).not.toBe('approved');
  });

  it('echoes the context as the analysis subject', () => {
    const r = analyze('const x = 1;\n', 'src/user/profile.ts');
    expect(r.subject).toBe('src/user/profile.ts');
  });
});

describe('privacy — dual-mode dispatch', () => {
  it('is registered as an analysis agent in the manifest', () => {
    expect(getManifestEntry('privacy')?.output_type).toBe('analysis');
  });

  it('falls back to a scenario-aware plan when no code is provided', async () => {
    const r = await executeOne({ id: 'p1', agent: 'privacy', task: 'Implement account deletion / right to erasure' });
    expect(r.plan).toBeDefined();
    expect(r.analysis).toBeUndefined();
    expect(r.plan!.approach.toLowerCase()).toContain('erasure');
  });

  it('runs the analyzer when code is provided', async () => {
    const r = await executeOne({
      id: 'p2',
      agent: 'privacy',
      task: 'audit',
      code: "console.log('user ssn', user.ssn);\n",
    });
    expect(r.analysis).toBeDefined();
    expect(r.plan).toBeUndefined();
    expect(r.analysis!.findings.length).toBeGreaterThan(0);
  });
});
