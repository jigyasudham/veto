// Dependency-hallucination guard. LLMs propose plausible-but-nonexistent
// package names, and adversaries register those names on public registries
// (slopsquatting) — a supply-chain risk class with no pre-install check in
// most AI workflows. This module verifies a proposed package against the live
// registry: does it exist, how old is it, how used is it, and is its name a
// near-miss of a popular package it isn't?
//
// assessPackage() is pure (signals in, verdict out) so the risk logic is
// testable offline; the per-ecosystem fetchers do the network work.

export type Ecosystem = 'npm' | 'pypi' | 'crates';

export type PackageSignals = {
  exists: boolean;
  age_days: number | null;
  downloads_last_month: number | null;
  version_count: number | null;
  deprecated: boolean;
};

export type PackageVerdict = {
  name: string;
  ecosystem: Ecosystem;
  verdict: 'verified' | 'caution' | 'high_risk' | 'not_found' | 'unverifiable';
  risk_signals: string[];
  signals: PackageSignals | null;
  similar_popular_package: string | null;
  error?: string;
};

// Top packages per ecosystem — the names adversaries typosquat. Curated, not
// exhaustive: the check is "1–2 edits from something everyone installs".
const POPULAR: Record<Ecosystem, string[]> = {
  npm: [
    'react', 'react-dom', 'lodash', 'express', 'axios', 'chalk', 'commander',
    'typescript', 'webpack', 'vite', 'next', 'vue', 'eslint', 'prettier',
    'jest', 'vitest', 'mocha', 'dotenv', 'cors', 'uuid', 'zod', 'moment',
    'dayjs', 'classnames', 'redux', 'rxjs', 'socket.io', 'mongoose', 'prisma',
    'sequelize', 'pg', 'mysql2', 'sqlite3', 'redis', 'ioredis', 'bcrypt',
    'jsonwebtoken', 'passport', 'multer', 'sharp', 'puppeteer', 'playwright',
    'cheerio', 'node-fetch', 'undici', 'got', 'inquirer', 'yargs', 'minimist',
    'glob', 'rimraf', 'fs-extra', 'semver', 'debug', 'winston', 'pino',
    'nodemon', 'tsx', 'ts-node', 'esbuild', 'rollup', 'tailwindcss', 'sass',
    'styled-components', 'svelte', 'electron', 'openai', 'langchain',
  ],
  pypi: [
    'requests', 'numpy', 'pandas', 'flask', 'django', 'boto3', 'urllib3',
    'pytest', 'scipy', 'matplotlib', 'pillow', 'sqlalchemy', 'pydantic',
    'fastapi', 'uvicorn', 'celery', 'redis', 'cryptography', 'httpx', 'aiohttp',
    'beautifulsoup4', 'lxml', 'openpyxl', 'python-dotenv', 'click', 'rich',
    'typer', 'scikit-learn', 'torch', 'tensorflow', 'transformers', 'openai',
    'anthropic', 'langchain', 'jinja2', 'pyyaml', 'toml', 'setuptools', 'wheel',
    'colorama', 'tqdm', 'selenium', 'playwright', 'psycopg2', 'pymongo',
  ],
  crates: [
    'serde', 'tokio', 'clap', 'rand', 'syn', 'quote', 'anyhow', 'thiserror',
    'log', 'tracing', 'regex', 'chrono', 'reqwest', 'hyper', 'axum', 'actix-web',
    'futures', 'itertools', 'lazy_static', 'once_cell', 'bytes', 'uuid',
    'serde_json', 'rayon', 'crossbeam', 'parking_lot', 'libc', 'bitflags',
  ],
};

// Levenshtein distance with an early-exit cap — we only care about 0/1/2/more.
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) >= cap) return cap;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin >= cap) return cap;
    prev.splice(0, prev.length, ...cur);
  }
  return Math.min(prev[b.length], cap);
}

// A popular package this name is suspiciously close to (1–2 edits) without
// being it. Scoped npm names are compared by their base name too.
export function findTyposquatTarget(name: string, ecosystem: Ecosystem): string | null {
  const popular = POPULAR[ecosystem];
  const lower = name.toLowerCase();
  if (popular.includes(lower)) return null;
  const base = lower.includes('/') ? lower.split('/').pop()! : lower;
  for (const candidate of popular) {
    const d = Math.min(editDistance(lower, candidate), editDistance(base, candidate));
    if (d >= 1 && d <= 2) return candidate;
  }
  return null;
}

export function assessPackage(name: string, ecosystem: Ecosystem, signals: PackageSignals | null, fetchError?: string): PackageVerdict {
  const similar = findTyposquatTarget(name, ecosystem);

  if (fetchError || !signals) {
    return {
      name, ecosystem, verdict: 'unverifiable', signals: null,
      similar_popular_package: similar,
      risk_signals: ['Registry could not be reached — do not assume the package is safe.'],
      error: fetchError ?? 'no signals',
    };
  }

  if (!signals.exists) {
    const risk_signals = [
      'Package does not exist on the registry — the name is likely hallucinated.',
      'Do NOT retry the install later: nonexistent AI-suggested names are prime slopsquatting targets.',
    ];
    if (similar) risk_signals.push(`Did you mean "${similar}"?`);
    return { name, ecosystem, verdict: 'not_found', signals, similar_popular_package: similar, risk_signals };
  }

  const risk_signals: string[] = [];
  const young = signals.age_days !== null && signals.age_days < 90;
  const brandNew = signals.age_days !== null && signals.age_days < 30;
  const lowUsage = signals.downloads_last_month !== null && signals.downloads_last_month < 500;
  const veryLowUsage = signals.downloads_last_month !== null && signals.downloads_last_month < 100;
  const singleVersion = signals.version_count !== null && signals.version_count <= 1;

  if (similar) risk_signals.push(`Name is 1–2 edits from the popular package "${similar}" — possible typosquat.`);
  if (brandNew) risk_signals.push(`Published ${signals.age_days} days ago — too new to have a reputation.`);
  else if (young) risk_signals.push(`Only ${signals.age_days} days old.`);
  if (veryLowUsage) risk_signals.push(`Fewer than 100 downloads last month.`);
  else if (lowUsage) risk_signals.push(`Fewer than 500 downloads last month.`);
  if (singleVersion) risk_signals.push('Only one published version.');
  if (signals.deprecated) risk_signals.push('Package is marked deprecated.');

  let verdict: PackageVerdict['verdict'];
  if (similar && (young || lowUsage || singleVersion)) {
    // Near-miss name AND weak track record — the classic squat profile.
    verdict = 'high_risk';
  } else if (brandNew && (veryLowUsage || singleVersion)) {
    verdict = 'high_risk';
  } else if (risk_signals.length > 0) {
    verdict = 'caution';
  } else {
    verdict = 'verified';
  }

  return { name, ecosystem, verdict, signals, similar_popular_package: similar, risk_signals };
}

// ─── Registry fetchers ────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 6000;
const UA = { 'User-Agent': 'veto-dep-verify (https://github.com/jigyasudham/veto)' };

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return { status: res.status, body: await res.json() };
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

async function fetchNpmSignals(name: string): Promise<PackageSignals> {
  const meta = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (meta.status === 404) return { exists: false, age_days: null, downloads_last_month: null, version_count: null, deprecated: false };
  const versions = meta.body?.versions ? Object.keys(meta.body.versions) : [];
  const latestTag = meta.body?.['dist-tags']?.latest;
  const deprecated = !!(latestTag && meta.body?.versions?.[latestTag]?.deprecated);
  let downloads: number | null = null;
  try {
    const dl = await getJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`);
    downloads = typeof dl.body?.downloads === 'number' ? dl.body.downloads : null;
  } catch { /* downloads API down — verdict degrades gracefully */ }
  return {
    exists: true,
    age_days: daysSince(meta.body?.time?.created),
    downloads_last_month: downloads,
    version_count: versions.length || null,
    deprecated,
  };
}

async function fetchPypiSignals(name: string): Promise<PackageSignals> {
  const meta = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (meta.status === 404) return { exists: false, age_days: null, downloads_last_month: null, version_count: null, deprecated: false };
  const releases: Record<string, Array<{ upload_time_iso_8601?: string }>> = meta.body?.releases ?? {};
  const versionKeys = Object.keys(releases);
  let earliest: string | undefined;
  for (const files of Object.values(releases)) {
    for (const f of files) {
      if (f.upload_time_iso_8601 && (!earliest || f.upload_time_iso_8601 < earliest)) earliest = f.upload_time_iso_8601;
    }
  }
  let downloads: number | null = null;
  try {
    const dl = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`);
    downloads = typeof dl.body?.data?.last_month === 'number' ? dl.body.data.last_month : null;
  } catch { /* stats API is best-effort */ }
  return {
    exists: true,
    age_days: daysSince(earliest),
    downloads_last_month: downloads,
    version_count: versionKeys.length || null,
    deprecated: meta.body?.info?.yanked === true,
  };
}

async function fetchCratesSignals(name: string): Promise<PackageSignals> {
  const meta = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (meta.status === 404) return { exists: false, age_days: null, downloads_last_month: null, version_count: null, deprecated: false };
  const crate = meta.body?.crate ?? {};
  return {
    exists: true,
    age_days: daysSince(crate.created_at),
    // recent_downloads is the 90-day figure; closest available proxy.
    downloads_last_month: typeof crate.recent_downloads === 'number' ? Math.round(crate.recent_downloads / 3) : null,
    version_count: Array.isArray(meta.body?.versions) ? meta.body.versions.length : null,
    deprecated: false,
  };
}

const FETCHERS: Record<Ecosystem, (name: string) => Promise<PackageSignals>> = {
  npm: fetchNpmSignals,
  pypi: fetchPypiSignals,
  crates: fetchCratesSignals,
};

export async function verifyPackage(name: string, ecosystem: Ecosystem): Promise<PackageVerdict> {
  try {
    const signals = await FETCHERS[ecosystem](name);
    return assessPackage(name, ecosystem, signals);
  } catch (err) {
    return assessPackage(name, ecosystem, null, err instanceof Error ? err.message : String(err));
  }
}

export async function verifyPackages(names: string[], ecosystem: Ecosystem): Promise<PackageVerdict[]> {
  return Promise.all(names.map(n => verifyPackage(n.trim(), ecosystem)));
}
