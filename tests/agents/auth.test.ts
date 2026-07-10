import { describe, it, expect } from 'vitest';
import { analyze, plan } from '../../src/agents/security/auth.js';
import { executeOne } from '../../src/agents/executor.js';
import { getManifestEntry } from '../../src/agents/manifest.js';

describe('auth.analyze — authentication defect detection', () => {
  it('scores clean code as approved with no findings', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    const r = analyze(code);
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('approved');
  });

  it('flags the JWT "none" algorithm as critical', () => {
    const code = "jwt.verify(token, key, { algorithms: ['none'] });\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'JWT Algorithm None');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('critical');
    expect(f!.cwe).toBe('CWE-347');
  });

  it('flags Math.random() used to generate a token', () => {
    const code = "const token = 'r' + Math.random().toString(36);\n";
    const r = analyze(code);
    const f = r.findings.find(f => f.category === 'Weak Randomness for Secret');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('flags a non-constant-time password comparison', () => {
    const code = 'if (user.password === inputPassword) { grant(); }\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Non-Constant-Time Credential Compare')).toBe(true);
  });

  it('flags jwt.sign without an expiry', () => {
    const code = 'const t = jwt.sign(payload, secret);\n';
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'JWT Without Expiry')).toBe(true);
  });

  it('does NOT flag jwt.sign when expiresIn is present', () => {
    const code = "const t = jwt.sign(payload, secret, { expiresIn: '15m' });\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'JWT Without Expiry')).toBe(false);
  });

  it('flags an insecure cookie flag', () => {
    const code = "res.cookie('sid', id, { httpOnly: true, secure: false });\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Insecure Cookie Flag')).toBe(true);
  });

  it('flags SameSite=None', () => {
    const code = "res.cookie('sid', id, { sameSite: 'none' });\n";
    const r = analyze(code);
    expect(r.findings.some(f => f.category === 'Cookie SameSite None')).toBe(true);
  });

  it('drives the verdict below approved for a critical finding', () => {
    const code = "jwt.verify(t, k, { algorithms: ['none'] });\n";
    const r = analyze(code);
    expect(r.critical_count).toBe(1);
    expect(r.score).toBeLessThan(90);
    expect(r.verdict).not.toBe('approved');
  });
});

describe('auth — dual-mode dispatch', () => {
  it('is registered as an analysis agent in the manifest', () => {
    expect(getManifestEntry('auth')?.output_type).toBe('analysis');
  });

  it('falls back to an auth-type-aware plan when no code is provided', async () => {
    const r = await executeOne({ id: 'a1', agent: 'auth', task: 'design an RBAC role-based access control system' });
    expect(r.plan).toBeDefined();
    expect(r.analysis).toBeUndefined();
    expect(r.plan!.approach.toLowerCase()).toContain('role-based');
  });

  it('runs the analyzer when code is provided', async () => {
    const r = await executeOne({
      id: 'a2',
      agent: 'auth',
      task: 'audit',
      code: "jwt.verify(t, k, { algorithms: ['none'] });\n",
    });
    expect(r.analysis).toBeDefined();
    expect(r.plan).toBeUndefined();
    expect(r.analysis!.critical_count).toBe(1);
  });
});
