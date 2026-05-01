import { AgentPlan, WorkerAgentType } from '../types.js';

type ResearchCategory = 'technology' | 'approach' | 'library' | 'pattern' | 'general';

function detectCategory(task: string): ResearchCategory {
  const t = task.toLowerCase();
  if (t.includes('library') || t.includes('package') || t.includes('npm') || t.includes('dependency')) return 'library';
  if (t.includes('how to') || t.includes('approach') || t.includes('best way') || t.includes('strategy')) return 'approach';
  if (t.includes('tech') || t.includes('framework') || t.includes('language') || t.includes('tool')) return 'technology';
  if (t.includes('pattern') || t.includes('design') || t.includes('architecture')) return 'pattern';
  return 'general';
}

const categoryApproach: Record<ResearchCategory, string> = {
  'technology': 'Evaluate the technology against four criteria: maturity (production usage at scale), maintenance (commit activity, issue response time), ecosystem (plugins, integrations, community), and fit (does it solve the actual problem or require workarounds). Compare the top 3 options side-by-side. Recommend one with clear reasoning.',
  'approach': 'Research the dominant approaches to this problem. For each approach: document the tradeoffs, who uses it at scale, what problems it introduces, and when it is the wrong choice. Identify the approach that minimises future regret for this specific context.',
  'library': 'Audit the library before committing: weekly downloads, last publish date, open issues, license, bundle size, TypeScript support, and peer dependency conflicts. Check for known CVEs. Find the 2–3 best alternatives and compare. Recommend based on the actual requirements, not just stars.',
  'pattern': 'Research the established patterns for this problem domain. Identify which pattern major codebases (open source projects similar to this one) use. Document the tradeoffs and known failure modes of each. Recommend the pattern with the best track record for this scale and team size.',
  'general': 'Frame the research question precisely before searching. Identify: what is actually being asked, what evidence would constitute an answer, what sources are authoritative for this topic. Synthesise findings into a recommendation with clear reasoning.',
};

const categorySteps: Record<ResearchCategory, string[]> = {
  'technology': [
    'Define the evaluation criteria specific to this project (performance, bundle size, licensing, etc.)',
    'Identify the top 3–5 candidate technologies via npm/GitHub/documentation',
    'For each candidate: check production usage at scale (case studies, "used by" lists)',
    'Check maintenance: last commit, release cadence, open issues, response time',
    'Check ecosystem: number of plugins, integrations, community size',
    'Run a minimal proof-of-concept for the top 2 candidates',
    'Document the tradeoffs in a comparison table',
    'Identify deal-breakers for each option',
    'Make a recommendation with explicit reasoning and known risks',
    'Store the research outcome in veto_memory_store (type="reference") for future retrieval',
  ],
  'approach': [
    'Define the problem precisely — what outcome are we optimising for?',
    'List the constraints that eliminate certain approaches immediately',
    'Research the 3–5 dominant approaches used in production',
    'For each approach: document implementation complexity, operational burden, and failure modes',
    'Find real-world examples of each approach at similar scale',
    'Identify which approach has the worst tail risks (what happens when it fails?)',
    'Test the recommended approach against the stated constraints',
    'Document the approach not chosen and why — prevents relitigating the decision',
    'Store the recommendation in veto_memory_store (type="decision")',
  ],
  'library': [
    'Check npm: weekly downloads, version history, last publish date',
    'Check GitHub: star count is vanity; check commit frequency, issue close rate, PR merge speed',
    'Check the license: MIT/Apache/BSD = fine. GPL/AGPL = requires legal review.',
    'Run: npm audit on the package to check for known CVEs',
    'Check bundle size via bundlephobia.com (for frontend dependencies)',
    'Check TypeScript support: first-party types or @types/ package',
    'Check peer dependency compatibility with the current project',
    'Find the 2 best alternatives and compare on the same criteria',
    'Recommend with specific version to pin and known issues to watch',
    'Store decision in veto_memory_store with tags=["dependency", package name]',
  ],
  'pattern': [
    'Name the problem domain clearly (e.g. "managing shared state in multi-step forms")',
    'Search for the canonical pattern name in this domain',
    'Find 3–5 well-regarded open-source implementations of each pattern',
    'Document: what the pattern solves, what it cannot solve, and its failure modes',
    'Identify the complexity cost: what does adopting this pattern require developers to understand?',
    'Check if this codebase already uses a related pattern — consistency matters more than perfection',
    'Recommend the pattern that fits the team\'s current knowledge and codebase conventions',
    'Store the pattern recommendation in veto_memory_store (type="reference")',
  ],
  'general': [
    'Frame the research question: what specific information is needed?',
    'Identify authoritative sources for this topic',
    'Gather evidence from at least 3 independent sources',
    'Identify where sources disagree and why',
    'Synthesise findings: what is well-established vs. contested?',
    'Apply findings to the specific context of this project',
    'Make a recommendation with confidence level (high/medium/low)',
    'Document sources and store in veto_memory_store (type="reference")',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'researcher' as WorkerAgentType,
    task,
    tier: 2,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: [
      '[ ] Research question defined precisely before searching',
      '[ ] At least 3 independent sources consulted',
      '[ ] Top 2–3 options compared side-by-side',
      '[ ] Tradeoffs and failure modes documented for each option',
      '[ ] License, maintenance, and security checked (for libraries)',
      '[ ] Recommendation made with clear reasoning',
      '[ ] Decision stored in veto_memory_store for future retrieval',
      '[ ] Sources documented',
    ],
    pitfalls: [
      'Researching without a precise question — "research authentication" is not researchable',
      'Using star count as a quality signal — stars measure marketing, not quality',
      'Not checking maintenance status — a popular abandoned library is worse than an obscure active one',
      'Recommending the newest option instead of the most proven one',
      'Not documenting the options that were rejected — the decision gets relitigated next month',
      'Forgetting to check license compatibility for commercial or open-source projects',
    ],
    patterns: [
      'Evidence-based recommendation: recommendation follows from documented evidence, not preference',
      'Rejection documentation: record what was rejected and why as strongly as what was chosen',
      'Source triangulation: any single source can be wrong — find 3 independent confirmations',
      'Fit-first evaluation: the best option for someone else\'s context may be wrong for yours',
    ],
    duration_estimate: '30-90 minutes',
  };
}
