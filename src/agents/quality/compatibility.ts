import { AgentPlan, WorkerAgentType } from '../types.js';
import type { AgentAnalysis, AgentFinding, FindingSeverity } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isBrowser = t.includes('browser') || t.includes('safari') || t.includes('firefox') || t.includes('frontend') || t.includes('css');
  const isNode = t.includes('node') || t.includes('runtime') || t.includes('version') || t.includes('backend');
  const isMobile = t.includes('mobile') || t.includes('ios') || t.includes('android') || t.includes('responsive');

  const approach = isBrowser
    ? 'Check browser compatibility for every CSS property, JS API, and Web API used. Target: Chrome 100+, Firefox 100+, Safari 15+, Edge 100+. Use caniuse.com for CSS and MDN compatibility tables for JS. Flag anything below 90% global usage without a polyfill.'
    : isNode
    ? 'Verify compatibility with the stated Node.js version range. Check: built-in modules (crypto, fs, sqlite), ES module vs CommonJS assumptions, and any native addons. Test on the minimum supported version, not just the latest.'
    : isMobile
    ? 'Test responsive behaviour at 320px (small phone), 375px (standard phone), 768px (tablet), 1024px (small desktop), 1440px (standard desktop). Verify touch targets are ≥ 44×44px. Verify no horizontal scroll at any breakpoint.'
    : 'Audit compatibility across the three dimensions relevant to this project: runtime version, browser support, and mobile breakpoints. Identify any usage of APIs not available in the minimum supported environment.';

  return {
    agent: 'compatibility' as WorkerAgentType,
    task,
    tier: 2,
    approach,
    steps: [
      'Identify the minimum supported environment: Node version, browser versions, mobile screen sizes',
      'List all external APIs, Web APIs, and language features used',
      'Cross-reference each against the minimum environment\'s support tables (caniuse, MDN, Node.js docs)',
      'Flag anything requiring a polyfill or transpile target adjustment',
      'Check package.json engines field — does it accurately reflect the minimum Node version?',
      'Check tsconfig.json target and lib — do they match the actual deployment environment?',
      'Check CSS: use @supports for progressive enhancement, not as a workaround',
      'Test responsive layout at 320px minimum width — the most common failure point',
      'Verify touch targets ≥ 44×44px on all interactive elements',
      'Check for deprecated APIs with removal dates within the support window',
    ],
    checklist: [
      '[ ] Minimum Node.js version documented in package.json engines field',
      '[ ] tsconfig target and lib match deployment environment',
      '[ ] No JS/CSS APIs used below 90% browser support without polyfill',
      '[ ] Responsive layout tested at 320px minimum width',
      '[ ] Touch targets ≥ 44×44px on mobile',
      '[ ] No deprecated APIs scheduled for removal within support window',
      '[ ] No native addons that break cross-platform (Windows/Mac/Linux)',
    ],
    pitfalls: [
      'Testing only on the latest browser — Safari consistently lags on Web APIs',
      'Assuming Node 22 features are available when minimum is Node 18',
      'Using CSS grid subgrid without checking Safari 15 support',
      'Touch targets that pass on desktop but fail on 320px mobile',
      'Native addons that compile on Mac but not on Windows (different MSVC requirements)',
    ],
    patterns: [
      'Progressive enhancement: build for the minimum, enhance for modern — not the reverse',
      'Engines field as contract: package.json engines is a promise to users about compatibility',
      'caniuse-first: check support tables before using any new browser API',
      '320px rule: if it works at 320px, it works on every phone',
    ],
    duration_estimate: '1-3 hours',
  };
}

// ─── Portability checks ────────────────────────────────────────────────────
//
// Scope: modern JS/Web/CSS APIs used without regard to the minimum supported
// target. Each finding is advisory — whether it is a real problem depends on the
// project's declared floor (package.json engines / tsconfig target / browserslist).
// One finding per line, highest severity first.

interface CompatCheck {
  regex: RegExp;
  severity: FindingSeverity;
  category: string;
  description: string;
  fix: string;
}

const CHECKS: CompatCheck[] = [
  // ES2022 — structuredClone (Node 17+, no legacy browsers).
  {
    regex: /\bstructuredClone\s*\(/,
    severity: 'medium',
    category: 'Unguarded Modern API',
    description: 'structuredClone() requires Node 17+ / a modern browser — it throws ReferenceError on older targets.',
    fix: 'Confirm your minimum target supports it, or feature-detect and fall back to a deep-clone polyfill.',
  },
  // ES2022 — Object.hasOwn.
  {
    regex: /\bObject\.hasOwn\s*\(/,
    severity: 'medium',
    category: 'Unguarded Modern API',
    description: 'Object.hasOwn() is ES2022 (Node 16.9+ / recent browsers) — unavailable on older runtimes.',
    fix: 'Raise the target, or use Object.prototype.hasOwnProperty.call(obj, key).',
  },
  // ES2023 — Array findLast / findLastIndex.
  {
    regex: /\.(?:findLast|findLastIndex)\s*\(/,
    severity: 'medium',
    category: 'Unguarded Modern API',
    description: 'Array.prototype.findLast/findLastIndex is ES2023 (Node 18+ / Safari 15.4+) — undefined on older engines.',
    fix: 'Verify the minimum target, or iterate in reverse manually.',
  },
  // ES2023 — immutable array methods (Node 20+).
  {
    regex: /\.(?:toSorted|toReversed|toSpliced)\s*\(/,
    severity: 'medium',
    category: 'Unguarded Modern API',
    description: 'toSorted/toReversed/toSpliced are ES2023 (Node 20+ / 2023 browsers) — unavailable on common LTS floors.',
    fix: 'Confirm the target, or copy first (e.g. [...arr].sort()).',
  },
  // ES2021 — String.prototype.replaceAll (Node 15+).
  {
    regex: /\.replaceAll\s*\(/,
    severity: 'low',
    category: 'Modern API',
    description: 'String.prototype.replaceAll is ES2021 (Node 15+) — verify it against your minimum runtime.',
    fix: 'If targeting older runtimes, use .replace(/pattern/g, …).',
  },
  // ES2021 — Promise.any.
  {
    regex: /\bPromise\.any\s*\(/,
    severity: 'low',
    category: 'Modern API',
    description: 'Promise.any is ES2021 (Node 15+ / no legacy browsers).',
    fix: 'Confirm the target supports it, or polyfill.',
  },
  // ES2021 — logical assignment operators (parser-level; breaks pre-ES2021 transpile targets).
  {
    regex: /(?:\?\?=|\|\|=|&&=)/,
    severity: 'low',
    category: 'Modern Syntax',
    description: 'Logical assignment (??= / ||= / &&=) is ES2021 syntax — a parse error for tools targeting an older ECMAScript version.',
    fix: 'Ensure your tsconfig target / Babel preset is ES2021+, or expand to an explicit assignment.',
  },
  // Modern CSS features embedded in selector/style strings.
  {
    regex: /:has\(|\bsubgrid\b/i,
    severity: 'low',
    category: 'Modern CSS Feature',
    description: 'The :has() selector / grid subgrid require Safari 15.4+ / recent Chromium — older browsers ignore them.',
    fix: 'Use @supports for progressive enhancement, or provide a non-:has()/non-subgrid fallback.',
  },
];

// ─── Analysis API ──────────────────────────────────────────────────────────

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const check of CHECKS) {
      if (check.regex.test(line)) {
        findings.push({
          severity: check.severity,
          category: check.category,
          description: check.description,
          fix: check.fix,
          location: `line ${i + 1}`,
        });
        break; // one finding per line — highest-priority check wins
      }
    }
  }

  const critical = findings.filter(f => f.severity === 'critical').length;
  const high = findings.filter(f => f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  const low = findings.filter(f => f.severity === 'low').length;

  const raw = 100 - (critical * 25 + high * 10 + medium * 5 + low * 2);
  const score = Math.max(0, raw);

  const verdict: AgentAnalysis['verdict'] =
    score >= 90 ? 'approved'
    : score >= 70 ? 'approved_with_warnings'
    : score >= 50 ? 'needs_revision'
    : 'rejected';

  const subject = context ?? 'provided code';

  const summary =
    findings.length === 0
      ? `No portability concerns detected in ${subject}. Score: ${score}/100.`
      : `Found ${findings.length} compatibility concern(s) in ${subject}: ${medium} medium, ${low} low. Verify against your minimum target. Score: ${score}/100 — ${verdict.replace(/_/g, ' ')}.`;

  return {
    agent: 'compatibility',
    subject,
    findings,
    score,
    verdict,
    summary,
    critical_count: critical,
    high_count: high,
  };
}
