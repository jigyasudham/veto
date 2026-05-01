import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'competitor-analyzer' as WorkerAgentType,
    task,
    tier: 2,
    approach: 'Analyse competitors on three dimensions: feature gap (what they have that you don\'t), differentiation gap (what you have that they don\'t), and positioning gap (where they own user perception). The goal is not to copy — it is to identify where building a feature would be table-stakes vs. where it would be genuinely differentiating.',
    steps: [
      'List the top 3–5 direct competitors and 2–3 indirect alternatives',
      'For each competitor: document their core value proposition in one sentence',
      'Build a feature matrix: rows = features, columns = products, cells = yes/no/partial',
      'Identify table-stakes features: present in all competitors (building these is hygiene, not differentiation)',
      'Identify differentiating features: present in 0–1 competitors (building these creates moat)',
      'Identify features your product has that no competitor has — this is your current moat',
      'Research competitor pricing to understand the value they signal for each tier',
      'Read user reviews of competitors to find the most common complaints (these are opportunities)',
      'Identify the positioning gaps: what perception do users have of each competitor?',
      'Recommend the top 3 features by differentiation potential × build cost',
      'Store analysis in veto_memory_store (type="reference", tags=["competitive", "strategy"])',
    ],
    checklist: [
      '[ ] Top 5 direct competitors identified',
      '[ ] Feature matrix built with table-stakes vs. differentiating features separated',
      '[ ] Current moat (unique features) identified',
      '[ ] User review analysis for top 2 complaints per competitor',
      '[ ] Differentiation opportunities ranked by potential × cost',
      '[ ] Analysis stored in veto_memory_store',
    ],
    pitfalls: [
      'Copying competitor features without understanding why they built them — builds technical debt, not differentiation',
      'Ignoring indirect alternatives — users often switch to a different category entirely, not a direct competitor',
      'Treating all feature gaps as problems — some are intentional product decisions',
      'Not reading user reviews — documentation says what a product does; reviews say what it fails to do',
      'Analysing features in isolation from pricing — a feature only matters if the target segment can afford it',
    ],
    patterns: [
      'Table-stakes separation: hygiene features vs. moat features require different prioritisation logic',
      'Complaint mining: competitor weaknesses in reviews are your clearest product opportunities',
      'Moat-first thinking: understand your current differentiation before adding more features',
      'Indirect competitor awareness: the biggest threat is often a product in a different category',
    ],
    duration_estimate: '2-4 hours',
  };
}
