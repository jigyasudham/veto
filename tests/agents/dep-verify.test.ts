import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { editDistance, findTyposquatTarget, assessPackage, type PackageSignals } from '../../src/agents/security/dep-verify.js';
import { callTool } from '../../src/server.js';
import { resetDb } from '../../src/memory/local.js';

function signals(overrides: Partial<PackageSignals> = {}): PackageSignals {
  return { exists: true, age_days: 2000, downloads_last_month: 50_000, version_count: 40, deprecated: false, ...overrides };
}

describe('editDistance', () => {
  it('identical strings are distance 0', () => {
    expect(editDistance('react', 'react')).toBe(0);
  });
  it('single substitution is 1', () => {
    expect(editDistance('lodash', 'lodosh')).toBe(1);
  });
  it('caps at 3 for distant strings', () => {
    expect(editDistance('react', 'completely-different')).toBe(3);
  });
});

describe('findTyposquatTarget', () => {
  it('flags a one-edit miss of a popular package', () => {
    expect(findTyposquatTarget('lodahs', 'npm')).toBe('lodash');
    expect(findTyposquatTarget('expresss', 'npm')).toBe('express');
    expect(findTyposquatTarget('requets', 'pypi')).toBe('requests');
  });
  it('a popular package itself is not a squat', () => {
    expect(findTyposquatTarget('react', 'npm')).toBeNull();
    expect(findTyposquatTarget('serde', 'crates')).toBeNull();
  });
  it('unrelated names are not flagged', () => {
    expect(findTyposquatTarget('my-internal-billing-lib', 'npm')).toBeNull();
  });
  it('compares scoped npm names by base name', () => {
    expect(findTyposquatTarget('@evil/lodahs', 'npm')).toBe('lodash');
  });
});

describe('assessPackage — verdict logic', () => {
  it('nonexistent package → not_found with slopsquat warning', () => {
    const v = assessPackage('definitely-fake-pkg-xyz', 'npm', signals({ exists: false, age_days: null, downloads_last_month: null, version_count: null }));
    expect(v.verdict).toBe('not_found');
    expect(v.risk_signals.join(' ')).toContain('slopsquat');
  });

  it('nonexistent near-miss name suggests the real package', () => {
    const v = assessPackage('lodahs', 'npm', signals({ exists: false, age_days: null, downloads_last_month: null, version_count: null }));
    expect(v.verdict).toBe('not_found');
    expect(v.risk_signals.join(' ')).toContain('lodash');
  });

  it('established, popular package → verified', () => {
    const v = assessPackage('some-mature-lib', 'npm', signals());
    expect(v.verdict).toBe('verified');
    expect(v.risk_signals).toEqual([]);
  });

  it('typosquat name with weak track record → high_risk', () => {
    const v = assessPackage('lodahs', 'npm', signals({ age_days: 12, downloads_last_month: 40, version_count: 1 }));
    expect(v.verdict).toBe('high_risk');
    expect(v.similar_popular_package).toBe('lodash');
  });

  it('brand-new single-version package → high_risk', () => {
    const v = assessPackage('shiny-new-helper', 'npm', signals({ age_days: 5, version_count: 1, downloads_last_month: 20 }));
    expect(v.verdict).toBe('high_risk');
  });

  it('old but deprecated package → caution', () => {
    const v = assessPackage('legacy-thing', 'npm', signals({ deprecated: true }));
    expect(v.verdict).toBe('caution');
  });

  it('young package with real usage → caution, not high_risk', () => {
    const v = assessPackage('rising-star', 'npm', signals({ age_days: 60, downloads_last_month: 80_000, version_count: 12 }));
    expect(v.verdict).toBe('caution');
  });

  it('fetch failure → unverifiable, never silently safe', () => {
    const v = assessPackage('whatever', 'npm', null, 'ETIMEDOUT');
    expect(v.verdict).toBe('unverifiable');
    expect(v.risk_signals.join(' ')).toContain('not assume');
  });
});

describe('veto_dep_verify handler', () => {
  beforeEach(() => resetDb());
  afterEach(() => vi.unstubAllGlobals());

  function call(args: Record<string, unknown>): Promise<any> {
    return callTool({ params: { name: 'veto_dep_verify', arguments: args } });
  }

  it('rejects an empty package list', async () => {
    const res = await call({ packages: [] });
    expect(res.isError).toBe(true);
  });

  it('rejects an unknown ecosystem', async () => {
    const res = await call({ packages: ['react'], ecosystem: 'maven' });
    expect(res.isError).toBe(true);
  });

  it('returns BLOCK when the registry 404s a hallucinated name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const res = await call({ packages: ['totally-hallucinated-pkg'], ecosystem: 'npm' });
    const b = JSON.parse(res.content[0].text);
    expect(b.overall).toBe('BLOCK');
    expect(b.results[0].verdict).toBe('not_found');
  });

  it('returns CLEAR for a healthy registry response', async () => {
    const meta = {
      'dist-tags': { latest: '4.17.21' },
      versions: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`4.0.${i}`, {}])),
      time: { created: '2012-04-23T16:37:11.912Z' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('api.npmjs.org')
        ? new Response(JSON.stringify({ downloads: 40_000_000 }), { status: 200 })
        : new Response(JSON.stringify(meta), { status: 200 })
    ));
    const res = await call({ packages: ['lodash'], ecosystem: 'npm' });
    const b = JSON.parse(res.content[0].text);
    expect(b.overall).toBe('CLEAR');
    expect(b.results[0].verdict).toBe('verified');
  });

  it('network failure yields REVIEW with unverifiable, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await call({ packages: ['react'], ecosystem: 'npm' });
    const b = JSON.parse(res.content[0].text);
    expect(b.overall).toBe('REVIEW');
    expect(b.results[0].verdict).toBe('unverifiable');
  });
});
