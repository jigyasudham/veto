import { AgentPlan, WorkerAgentType } from '../types.js';

type RiskCategory = 'technical' | 'security' | 'business' | 'general';

function detectCategory(task: string): RiskCategory {
  const t = task.toLowerCase();
  if (t.includes('security') || t.includes('vulnerability') || t.includes('attack') || t.includes('breach')) return 'security';
  if (t.includes('business') || t.includes('market') || t.includes('revenue') || t.includes('legal') || t.includes('regulatory')) return 'business';
  if (t.includes('technical') || t.includes('architecture') || t.includes('system') || t.includes('infra') || t.includes('deploy')) return 'technical';
  return 'general';
}

const approaches: Record<RiskCategory, string> = {
  'technical': 'Assess technical risks using a failure mode analysis. For each component: what happens when it fails? What is the blast radius? What is the recovery path? Assign probability (1–5) and impact (1–5), sort by P×I score. Focus on the top 3 risks — those are the ones worth mitigating now.',
  'security': 'Perform a threat model using STRIDE: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege. For each threat: document the attack vector, current controls, and residual risk. Prioritise by attacker motivation × exploitability × impact.',
  'business': 'Assess business risks across four categories: market (demand disappears), operational (team/tooling fails), financial (runway runs out), and regulatory (compliance changes). For each: what is the early warning signal? What is the mitigation before it becomes a crisis?',
  'general': 'Enumerate risks across technical, business, and operational dimensions. For each risk: probability (low/medium/high), impact (low/medium/high), detectability (would we know before it causes damage?), and mitigation. Prioritise by P×I with a tie-break on detectability.',
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'risk-assessor' as WorkerAgentType,
    task,
    tier: 3,
    approach: approaches[category],
    steps: [
      'Define the scope: what system, feature, or decision is being assessed?',
      'Enumerate all risks — do not filter yet, just list everything that could go wrong',
      'For each risk: assign probability (1–5) and impact (1–5)',
      'Calculate risk score: P × I (max 25)',
      'Sort risks by score, descending',
      'For the top 5 risks: document the early warning signal and mitigation',
      'Identify which risks can be eliminated vs. mitigated vs. accepted',
      'For accepted risks: document the acceptance rationale and review date',
      'Assign ownership: who is responsible for monitoring each top-5 risk?',
      'Store risk register in veto_memory_store (type="reference", tags=["risk", domain])',
    ],
    checklist: [
      '[ ] Scope defined clearly',
      '[ ] At least 10 risks enumerated before filtering',
      '[ ] All risks scored on P × I scale',
      '[ ] Top 5 risks have early warning signals documented',
      '[ ] Top 5 risks have mitigation steps documented',
      '[ ] Accepted risks have rationale and review date',
      '[ ] Risk register stored in veto_memory_store',
    ],
    pitfalls: [
      'Listing only obvious risks — the dangerous ones are the ones nobody thinks of',
      'Scoring risks on gut feel without separating probability from impact',
      'Documenting risks without assigning owners — nobody monitors an ownerless risk',
      'Treating mitigation as risk elimination — most mitigations only reduce probability or impact, not to zero',
      'Not setting a review date — risk registers become stale within 3 months',
    ],
    patterns: [
      'P × I scoring: separates probability from impact to avoid conflating "likely but minor" with "unlikely but catastrophic"',
      'Early warning signal: each top risk gets a concrete signal that would trigger the mitigation',
      'Accepted risk documentation: explicit acceptance is better than implicit ignorance',
      'Risk ownership: every top-5 risk has a named owner who is responsible for the early warning signal',
    ],
    duration_estimate: '1-3 hours',
  };
}
