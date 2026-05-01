import { AgentPlan, WorkerAgentType } from '../types.js';

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
