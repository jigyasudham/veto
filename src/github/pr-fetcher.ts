// Fetches a GitHub PR diff and metadata via the GitHub REST API.
// Supports public repos without auth; set GITHUB_TOKEN for private repos.

export interface PrMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  base_branch: string;
  head_branch: string;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  state: string;
}

export interface PrFetchResult {
  ok: true;
  diff: string;
  meta: PrMeta;
}

export interface PrFetchError {
  ok: false;
  error: string;
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'veto-mcp-server',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export async function fetchPrDiff(prUrl: string): Promise<PrFetchResult | PrFetchError> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return { ok: false, error: `Cannot parse PR URL. Expected format: https://github.com/owner/repo/pull/123` };
  }

  const { owner, repo, number } = parsed;
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;

  // Fetch PR metadata and diff in parallel
  const [metaRes, diffRes] = await Promise.all([
    fetch(apiBase, { headers: githubHeaders() }),
    fetch(apiBase, { headers: { ...githubHeaders(), Accept: 'application/vnd.github.v3.diff' } }),
  ]);

  if (metaRes.status === 404) {
    return { ok: false, error: `PR not found: ${prUrl}. Check the URL and ensure GITHUB_TOKEN is set for private repos.` };
  }
  if (metaRes.status === 401 || metaRes.status === 403) {
    return { ok: false, error: `GitHub API auth error (${metaRes.status}). Set the GITHUB_TOKEN environment variable.` };
  }
  if (!metaRes.ok) {
    return { ok: false, error: `GitHub API error ${metaRes.status}: ${metaRes.statusText}` };
  }

  const pr = await metaRes.json() as Record<string, unknown>;
  const diff = diffRes.ok ? await diffRes.text() : '';

  if (!diff.trim()) {
    return { ok: false, error: `PR #${number} has no diff (may be empty or already merged with no changes).` };
  }

  const meta: PrMeta = {
    owner,
    repo,
    number,
    title: String((pr.title as string) ?? ''),
    author: String(((pr.user as Record<string, unknown>)?.login as string) ?? ''),
    base_branch: String(((pr.base as Record<string, unknown>)?.ref as string) ?? ''),
    head_branch: String(((pr.head as Record<string, unknown>)?.ref as string) ?? ''),
    html_url: String((pr.html_url as string) ?? prUrl),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changed_files: Number(pr.changed_files ?? 0),
    state: String((pr.state as string) ?? 'unknown'),
  };

  return { ok: true, diff, meta };
}
