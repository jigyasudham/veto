import type { AgentPlan } from '../types.js';
import type { FindingSeverity } from '../types.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface DependencyFlag {
  name: string;
  version: string;
  reason: string;
  severity: FindingSeverity;
  fix: string;
}

export interface DependencyAuditResult {
  total_deps: number;
  flagged: DependencyFlag[];
  recommendations: string[];
  score: number;
}

// ─── Plan ──────────────────────────────────────────────────────────────────

export function plan(task: string, _context?: string): AgentPlan {
  return {
    agent: 'dependency-audit',
    task,
    tier: 1,
    approach:
      'Audit all direct and transitive dependencies for known CVEs, deprecated packages, ' +
      'and missing security-critical libraries. Produce a prioritised remediation list.',
    steps: [
      'Parse package.json to enumerate dependencies and devDependencies',
      'Check each package against the known-problematic package list',
      'Run npm audit / yarn audit to surface known CVEs from the advisory database',
      'Identify deprecated or unmaintained packages that introduce risk',
      'Check for missing security-critical middleware (helmet, rate-limit)',
      'Verify that lockfile (package-lock.json / yarn.lock) is committed and up to date',
      'Check for packages that should not be in production dependencies (devDeps in deps)',
      'Review transitive dependencies flagged by npm audit for prototype pollution',
      'Produce remediation steps prioritised by severity',
      'Set up automated dependency scanning in CI (Dependabot or Renovate)',
    ],
    checklist: [
      'npm audit or yarn audit shows zero critical or high vulnerabilities',
      'Lockfile committed to version control and not in .gitignore',
      'All dependencies pinned to exact versions or narrow semver ranges',
      'Dependabot or Renovate configured for automatic security PRs',
      'node-serialize removed — known RCE vulnerability',
      'lodash >= 4.17.21 (prototype pollution fix)',
      'minimist >= 1.2.6 (prototype pollution fix)',
      'tar >= 4.4.18 (path traversal fix)',
      'ws >= 7.4.6 (DoS fix)',
      'axios >= 0.21.2 (SSRF fix)',
      'jsonwebtoken >= 9.0.0 (algorithm confusion fix)',
      'helmet installed and applied to Express app',
      'express-rate-limit installed and applied to auth and sensitive routes',
      'No unused dependencies in package.json',
      'devDependencies not included in production Docker image (--production install)',
      'No packages sourced from git branches or unverified registries',
      'npm config set audit-level high in CI to fail on high/critical',
      'SBOM (Software Bill of Materials) generated for production releases',
    ],
    pitfalls: [
      'Ignoring npm audit output by adding --ignore-scripts instead of fixing the issue',
      'Using npm install without a lockfile — allows different versions across environments',
      'Installing devDependencies in production — increases attack surface',
      'Using packages from personal GitHub repos without verifying integrity',
      'Overriding transitive dependency versions in overrides without testing',
      'Not reviewing Dependabot PRs promptly — security patches accumulate',
      'Trusting package.json version ranges (^) without auditing transitive tree',
    ],
    patterns: [
      'Lockfile-first install: npm ci instead of npm install in CI',
      'Production-only install: npm ci --omit=dev in Docker production stage',
      'Automated dependency updates: Dependabot weekly security PRs',
      'Audit gate: npm audit --audit-level=high fails CI on violations',
      'SBOM generation: cyclonedx-npm for supply-chain transparency',
    ],
    duration_estimate: '1-2 hours for initial audit; ongoing via automated tooling',
  };
}

// ─── Known problematic packages database ──────────────────────────────────

interface KnownIssue {
  reason: string;
  severity: FindingSeverity;
  fix: string;
  /** semver prefix that is safe; versions below this are flagged */
  safeAbove?: string;
}

const KNOWN_ISSUES: Record<string, KnownIssue> = {
  'node-serialize': {
    reason: 'Contains a Remote Code Execution (RCE) vulnerability — deserialization of untrusted data executes arbitrary code.',
    severity: 'critical',
    fix: 'Remove node-serialize entirely. Use JSON.parse() for safe, schema-validated deserialisation.',
  },
  'serialize-javascript': {
    reason: 'Older versions have an XSS vulnerability when serialised output is embedded in HTML.',
    severity: 'high',
    safeAbove: '3.1.0',
    fix: 'Upgrade to serialize-javascript >= 3.1.0 which escapes HTML-sensitive characters.',
  },
  lodash: {
    reason: 'Versions below 4.17.21 are vulnerable to prototype pollution (CVE-2020-8203).',
    severity: 'high',
    safeAbove: '4.17.21',
    fix: 'Upgrade lodash to >= 4.17.21. Consider replacing with individual lodash-es functions to reduce bundle size.',
  },
  minimist: {
    reason: 'Versions below 1.2.6 allow prototype pollution via constructor or __proto__ keys.',
    severity: 'high',
    safeAbove: '1.2.6',
    fix: 'Upgrade minimist to >= 1.2.6.',
  },
  tar: {
    reason: 'Older tar versions are vulnerable to path traversal (CVE-2021-37701, CVE-2021-37712).',
    severity: 'high',
    safeAbove: '4.4.18',
    fix: 'Upgrade tar to >= 4.4.18 (v4) or >= 6.1.9 (v6).',
  },
  ws: {
    reason: 'Versions below 7.4.6 are vulnerable to a Denial of Service via special HTTP headers (CVE-2021-32640).',
    severity: 'high',
    safeAbove: '7.4.6',
    fix: 'Upgrade ws to >= 7.4.6 (ws@7) or >= 8.0.0 (ws@8).',
  },
  axios: {
    reason: 'Versions below 0.21.2 are vulnerable to SSRF via crafted redirect (CVE-2020-28168).',
    severity: 'high',
    safeAbove: '0.21.2',
    fix: 'Upgrade axios to >= 0.21.2 or >= 1.0.0 for the current major.',
  },
  jsonwebtoken: {
    reason: 'Versions below 9.0.0 are vulnerable to algorithm confusion attacks (CVE-2022-23529).',
    severity: 'critical',
    safeAbove: '9.0.0',
    fix: 'Upgrade jsonwebtoken to >= 9.0.0 and explicitly pass { algorithms: ["HS256"] } to verify().',
  },
  request: {
    reason: 'The "request" package is deprecated (unmaintained since 2020) and will not receive security patches.',
    severity: 'medium',
    fix: 'Replace with native fetch() (Node 18+), axios >= 1.0.0, or got.',
  },
  mkdirp: {
    reason: 'mkdirp v0.x is outdated; the package has been rewritten and old versions may conflict with native fs.mkdirSync options.',
    severity: 'low',
    fix: 'Upgrade to mkdirp >= 1.0.4 or use fs.mkdirSync(path, { recursive: true }) available in Node 12+.',
  },
  rimraf: {
    reason: 'rimraf v2 is outdated; v3+ provides Promise-based API and better error handling.',
    severity: 'low',
    fix: 'Upgrade to rimraf >= 3.0.0 or use fs.rm(path, { recursive: true }) available in Node 14.14+.',
  },
  'electron-builder': {
    reason: 'Older versions have code-signing bypass vulnerabilities.',
    severity: 'medium',
    safeAbove: '22.14.13',
    fix: 'Upgrade electron-builder to the latest version.',
  },
  'xml2js': {
    reason: 'Versions below 0.5.0 are vulnerable to prototype pollution (CVE-2023-0842).',
    severity: 'high',
    safeAbove: '0.5.0',
    fix: 'Upgrade xml2js to >= 0.5.0.',
  },
};

// ─── Semver comparison helper ──────────────────────────────────────────────

function parseSimpleVersion(v: string): number[] {
  // strips leading ^ ~ = v and returns [major, minor, patch]
  const clean = v.replace(/^[\^~=v]/, '').split('.');
  return clean.map(p => parseInt(p.replace(/\D.*/g, ''), 10) || 0);
}

function isBelow(installed: string, safeAbove: string): boolean {
  if (!installed || installed === '*' || installed === 'latest') return false;
  const a = parseSimpleVersion(installed);
  const b = parseSimpleVersion(safeAbove);
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false; // equal means at the safe version
}

// ─── Missing security packages ─────────────────────────────────────────────

function checkMissingSecurityPackages(
  allDeps: Record<string, string>,
  recommendations: string[],
): void {
  const hasExpress = 'express' in allDeps;
  const hasHelmet = 'helmet' in allDeps;
  const hasRateLimit =
    'express-rate-limit' in allDeps || 'rate-limiter-flexible' in allDeps;
  const hasCors = 'cors' in allDeps;
  const hasHpp = 'hpp' in allDeps;

  if (hasExpress && !hasHelmet) {
    recommendations.push(
      'Add helmet: sets security headers (CSP, HSTS, X-Frame-Options, etc.) — npm install helmet',
    );
  }
  if (hasExpress && !hasRateLimit) {
    recommendations.push(
      'Add express-rate-limit: protect auth and API endpoints from brute-force — npm install express-rate-limit',
    );
  }
  if (hasExpress && hasCors && !hasHpp) {
    recommendations.push(
      'Consider adding hpp to protect against HTTP Parameter Pollution attacks — npm install hpp',
    );
  }
  if (!('dotenv' in allDeps) && !('dotenv-safe' in allDeps)) {
    recommendations.push(
      'Consider dotenv-safe to enforce required env variables at startup — npm install dotenv-safe',
    );
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export function audit(packageJsonText: string): DependencyAuditResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(packageJsonText) as Record<string, unknown>;
  } catch {
    return {
      total_deps: 0,
      flagged: [],
      recommendations: ['Could not parse package.json — ensure it is valid JSON.'],
      score: 50,
    };
  }

  const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
  const devDeps = (parsed['devDependencies'] ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };
  const total_deps = Object.keys(allDeps).length;

  const flagged: DependencyFlag[] = [];
  const recommendations: string[] = [
    'Run npm audit --audit-level=high in CI and fail the build on violations.',
    'Enable Dependabot or Renovate for automated security update PRs.',
    'Use npm ci (not npm install) in CI to ensure lockfile integrity.',
    'Separate devDependencies from dependencies; use --omit=dev in production.',
    'Generate an SBOM with cyclonedx-npm for supply-chain transparency.',
  ];

  for (const [name, version] of Object.entries(allDeps)) {
    const issue = KNOWN_ISSUES[name];
    if (!issue) continue;

    if (issue.safeAbove) {
      // Only flag if the installed version appears to be below the safe threshold.
      // We do our best with semver string parsing; npm audit provides more accurate results.
      if (isBelow(version, issue.safeAbove)) {
        flagged.push({ name, version, reason: issue.reason, severity: issue.severity, fix: issue.fix });
      }
    } else {
      // Package is flagged regardless of version (deprecated / inherently unsafe)
      flagged.push({ name, version, reason: issue.reason, severity: issue.severity, fix: issue.fix });
    }
  }

  checkMissingSecurityPackages(allDeps, recommendations);

  // Scoring: start at 100, deduct per flagged item
  const critical = flagged.filter(f => f.severity === 'critical').length;
  const high = flagged.filter(f => f.severity === 'high').length;
  const medium = flagged.filter(f => f.severity === 'medium').length;
  const low = flagged.filter(f => f.severity === 'low').length;

  const raw = 100 - (critical * 25 + high * 10 + medium * 5 + low * 2);
  const score = Math.max(0, raw);

  return { total_deps, flagged, recommendations, score };
}

// ─── analyze() — AgentAnalysis wrapper for executor compatibility ──────────
// The executor calls analyze(code, context) when task.code is provided.
// For dependency-audit the "code" is expected to be the package.json text.

export function analyze(code: string, context?: string): import('../types.js').AgentAnalysis {
  const result = audit(code);
  const subject = context ?? 'package.json';

  const findings: import('../types.js').AgentFinding[] = result.flagged.map(f => ({
    severity: f.severity,
    category: 'Dependency Security',
    description: `${f.name}@${f.version}: ${f.reason}`,
    fix: f.fix,
    cwe: 'CWE-1395',
    owasp: 'A06:2021',
  }));

  // Append recommendations as info-level findings
  for (const rec of result.recommendations) {
    findings.push({
      severity: 'info',
      category: 'Dependency Hygiene',
      description: rec,
      fix: rec,
    });
  }

  const critical_count = result.flagged.filter(f => f.severity === 'critical').length;
  const high_count = result.flagged.filter(f => f.severity === 'high').length;
  const medium_count = result.flagged.filter(f => f.severity === 'medium').length;

  const verdict: import('../types.js').AgentAnalysis['verdict'] =
    result.score >= 90 ? 'approved'
    : result.score >= 70 ? 'approved_with_warnings'
    : result.score >= 50 ? 'needs_revision'
    : 'rejected';

  const summary =
    result.flagged.length === 0
      ? `Dependency audit of ${subject} passed — ${result.total_deps} packages scanned, no known vulnerabilities. Score: ${result.score}/100.`
      : `Dependency audit of ${subject}: ${result.flagged.length} flagged package(s) out of ${result.total_deps} total. ${critical_count} critical, ${high_count} high, ${medium_count} medium. Score: ${result.score}/100 — ${verdict.replace(/_/g, ' ')}.`;

  return {
    agent: 'dependency-audit',
    subject,
    findings,
    score: result.score,
    verdict,
    summary,
    critical_count,
    high_count,
  };
}
