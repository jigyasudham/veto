import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPrDiff } from '../../src/github/pr-fetcher.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPrDiff — URL parsing', () => {
  it('returns error for a non-GitHub URL', async () => {
    const result = await fetchPrDiff('https://gitlab.com/owner/repo/pull/1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Cannot parse PR URL/);
  });

  it('returns error for a malformed URL (no pull number)', async () => {
    const result = await fetchPrDiff('https://github.com/owner/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Cannot parse PR URL/);
  });

  it('returns error for an empty string', async () => {
    const result = await fetchPrDiff('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Cannot parse PR URL/);
  });
});

describe('fetchPrDiff — API responses (mocked fetch)', () => {
  function makeFetch(metaStatus: number, metaBody: unknown, diffBody = '') {
    let call = 0;
    return vi.fn().mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
      const isDiff = opts?.headers?.Accept?.includes('diff');
      if (isDiff) {
        return Promise.resolve({
          ok: diffBody.length > 0,
          status: 200,
          text: () => Promise.resolve(diffBody),
        });
      }
      call++;
      return Promise.resolve({
        ok: metaStatus >= 200 && metaStatus < 300,
        status: metaStatus,
        statusText: metaStatus === 200 ? 'OK' : 'Error',
        json: () => Promise.resolve(metaBody),
      });
    });
  }

  const validPrMeta = {
    title: 'Fix the bug',
    user: { login: 'alice' },
    base: { ref: 'main' },
    head: { ref: 'fix-bug' },
    html_url: 'https://github.com/owner/repo/pull/42',
    additions: 10,
    deletions: 3,
    changed_files: 2,
    state: 'open',
  };

  const validDiff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n`;

  it('returns ok: true with correct meta on a valid response', async () => {
    vi.stubGlobal('fetch', makeFetch(200, validPrMeta, validDiff));
    const result = await fetchPrDiff('https://github.com/owner/repo/pull/42');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.title).toBe('Fix the bug');
    expect(result.meta.author).toBe('alice');
    expect(result.meta.number).toBe(42);
    expect(result.meta.additions).toBe(10);
    expect(result.diff).toContain('diff --git');
  });

  it('returns error on 404', async () => {
    vi.stubGlobal('fetch', makeFetch(404, {}, ''));
    const result = await fetchPrDiff('https://github.com/owner/repo/pull/999');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });

  it('returns error on 401', async () => {
    vi.stubGlobal('fetch', makeFetch(401, {}, ''));
    const result = await fetchPrDiff('https://github.com/owner/repo/pull/1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/auth error/i);
  });

  it('returns error when diff is empty', async () => {
    vi.stubGlobal('fetch', makeFetch(200, validPrMeta, '   '));
    const result = await fetchPrDiff('https://github.com/owner/repo/pull/42');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no diff/i);
  });
});
