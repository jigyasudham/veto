import { AgentPlan, WorkerAgentType } from '../types.js';

type EthicsCategory = 'ai-ml' | 'dark-patterns' | 'fairness' | 'privacy' | 'general';

function detectCategory(task: string): EthicsCategory {
  const t = task.toLowerCase();
  if (t.includes('ai') || t.includes('ml') || t.includes('model') || t.includes('predict') || t.includes('recommend')) return 'ai-ml';
  if (t.includes('dark pattern') || t.includes('ux') || t.includes('onboarding') || t.includes('notification') || t.includes('subscription')) return 'dark-patterns';
  if (t.includes('fair') || t.includes('bias') || t.includes('demographic') || t.includes('discriminat') || t.includes('equit')) return 'fairness';
  if (t.includes('privac') || t.includes('data') || t.includes('tracking') || t.includes('surveillance')) return 'privacy';
  return 'general';
}

const categoryApproach: Record<EthicsCategory, string> = {
  'ai-ml': 'Audit the AI/ML system for bias in three places: training data (is it representative?), model outputs (does it perform differently across demographic groups?), and system design (does the framing of the problem embed assumptions that harm certain users?). Bias at the data level is fixable. Bias at the framing level may require rethinking the feature.',
  'dark-patterns': 'Review the UX flow for patterns that extract value from users through confusion or manipulation rather than genuine usefulness. Dark patterns degrade trust at a rate users cannot articulate — they just stop using the product. The test: would a user feel tricked if they understood exactly what the product was doing?',
  'fairness': 'Analyse whether the feature treats all user groups equitably. Start with the groups most likely to be harmed by the design assumptions. Document which groups benefit, which are neutral, and which may be disadvantaged. Disproportionate harm does not have to be intentional to be real.',
  'privacy': 'Evaluate the data collection and usage against the principle of data minimisation: collect only what is necessary, use only for the stated purpose, retain only as long as needed. Identify the worst-case use of each data point if it were leaked or misused. Privacy harms are irreversible — the standard should be higher than legal compliance.',
  'general': 'Evaluate the feature against three ethical dimensions: autonomy (does it respect user choice?), harm (could it cause disproportionate harm to specific groups?), and transparency (do users understand what the system is doing on their behalf?). A feature that scores poorly on all three should not ship as designed.',
};

const categorySteps: Record<EthicsCategory, string[]> = {
  'ai-ml': [
    'Identify all groups who will be affected by the AI/ML system\'s outputs',
    'Check training data: is it representative of all affected groups?',
    'Identify proxy variables: features that correlate with protected characteristics (zip code → race, etc.)',
    'Measure output quality separately for each demographic group — aggregate accuracy hides disparities',
    'Test edge cases for groups likely to be underrepresented in training data',
    'Evaluate the feedback loop: does poor performance for group X reduce their usage, which reduces training data for X, which worsens performance? (Feedback loop bias)',
    'Define the acceptable fairness metric: demographic parity, equalised odds, or calibration — and document the tradeoff',
    'Establish a bias monitoring plan for post-launch',
    'Document findings in veto_memory_store (type="decision", tags=["ethics", "ai-bias"])',
  ],
  'dark-patterns': [
    'Map the full user flow from signup through cancellation — cancellation is where dark patterns concentrate',
    'Check for: confirmshaming (guilt-inducing opt-out language), hidden costs, roach motel (easy in, hard out), misdirection, disguised ads',
    'Apply the "would a user feel tricked" test to each step',
    'Check notification permission requests for false urgency or misleading framing',
    'Review subscription cancellation flow: how many steps, how many confirmation screens?',
    'Review default settings: are they set in the user\'s interest or the product\'s interest?',
    'Identify patterns that are legal but erode trust — these cause churn, not just complaints',
    'Recommend the honest alternative for each dark pattern found',
    'Store findings in veto_memory_store (type="decision", tags=["ethics", "ux"])',
  ],
  'fairness': [
    'Identify which user groups are affected by this feature',
    'For each group: document the expected benefit and expected harm',
    'Identify the group most likely to be disadvantaged by the current design assumptions',
    'Check if the feature was designed with a default user in mind — who is that user, and who is excluded?',
    'Evaluate accessibility: does the feature work for users with disabilities?',
    'Evaluate language/literacy: does the feature assume a reading level or language that excludes users?',
    'Evaluate economic access: does the feature require hardware, bandwidth, or time that not all users have?',
    'Recommend design changes that reduce disproportionate harm without removing value for majority users',
    'Store fairness analysis in veto_memory_store (type="decision", tags=["ethics", "fairness"])',
  ],
  'privacy': [
    'List all data points collected by this feature',
    'For each data point: is it strictly necessary for the stated purpose?',
    'Apply data minimisation: remove every data point that is not strictly necessary',
    'Identify retention: how long is each data point kept? Is there an automatic deletion policy?',
    'Identify worst-case misuse for each data point (leaked, sold, subpoenaed, used for a different purpose)',
    'Check if users can access, correct, and delete their data (GDPR Art. 15-17)',
    'Check if the privacy policy accurately describes this data collection',
    'Evaluate third-party data sharing: does each third-party SDK or API receive PII?',
    'Store findings in veto_memory_store (type="decision", tags=["ethics", "privacy"])',
  ],
  'general': [
    'Identify all affected user groups — not just the primary user',
    'Evaluate autonomy: does the feature respect user choice, or does it nudge/coerce?',
    'Evaluate harm: which groups could be harmed, and is the harm proportionate to the benefit?',
    'Evaluate transparency: do users understand what the system is doing on their behalf?',
    'Apply the "front page test": would this design choice be described negatively in a tech journalism article?',
    'Apply the "worst user" test: what does the most vulnerable user experience when using this feature?',
    'Identify the single highest-risk ethical dimension and make a concrete recommendation',
    'Store findings in veto_memory_store (type="decision", tags=["ethics"])',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'ethics-bias' as WorkerAgentType,
    task,
    tier: 3,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: [
      '[ ] All affected user groups identified — not just the primary user',
      '[ ] AI/ML systems: output quality measured separately per demographic group',
      '[ ] Dark patterns: "would a user feel tricked" test applied',
      '[ ] Fairness: group most likely to be disadvantaged explicitly identified',
      '[ ] Privacy: data minimisation applied — unnecessary data points removed',
      '[ ] Feedback loops identified for AI/ML features',
      '[ ] Post-launch monitoring plan defined for AI/ML outputs',
      '[ ] Findings stored in veto_memory_store with tags=["ethics"]',
    ],
    pitfalls: [
      'Treating legal compliance as an ethical ceiling — GDPR compliance is the floor, not the standard',
      'Evaluating bias only on aggregate accuracy — group-level disparities are invisible in aggregate metrics',
      'Assuming good intent eliminates harm — disproportionate harm is real regardless of intent',
      'Treating ethics as a one-time check — AI/ML bias drifts as usage patterns change',
      'Ignoring indirect harm — the people harmed most are often not the users in the room when the product is designed',
      'Conflating user preference with user interest — users may prefer a dark pattern in the moment but it harms them long-term',
    ],
    patterns: [
      'Affected-group enumeration: start every ethics analysis by listing all affected groups, especially non-users',
      'Worst-user test: evaluate through the lens of the most vulnerable person likely to use this feature',
      'Front-page test: would this design choice be described negatively in a tech journalism article?',
      'Disparity detection: always measure AI/ML performance per group, not just in aggregate',
    ],
    duration_estimate: '1-3 hours',
  };
}
