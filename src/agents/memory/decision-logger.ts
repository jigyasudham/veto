import { AgentPlan, WorkerAgentType } from '../types.js';

type DecisionCategory = 'architecture' | 'security' | 'data' | 'api' | 'general';

function detectCategory(task: string): DecisionCategory {
  const t = task.toLowerCase();
  if (t.includes('architect') || t.includes('design') || t.includes('structure') || t.includes('pattern') || t.includes('framework')) return 'architecture';
  if (t.includes('auth') || t.includes('security') || t.includes('encrypt') || t.includes('permission') || t.includes('token')) return 'security';
  if (t.includes('schema') || t.includes('database') || t.includes('migration') || t.includes('model') || t.includes('table')) return 'data';
  if (t.includes('api') || t.includes('endpoint') || t.includes('contract') || t.includes('version') || t.includes('rest') || t.includes('graphql')) return 'api';
  return 'general';
}

const categoryApproach: Record<DecisionCategory, string> = {
  'architecture': 'Document the architectural decision as an ADR. Capture context (what forces are in play), the decision made, full rationale, rejected alternatives with reasons, and positive/negative consequences. Store in veto_memory_store with type="decision". Link from code comments using the ADR ID.',
  'security': 'Log the security decision with threat model context. State the attack surface being protected, the chosen control, why alternatives were rejected (too weak, too complex, operational burden), and any residual risk accepted. Tag with "security" for fast retrieval during reviews.',
  'data': 'Record the data schema decision with migration path. Document the constraints that drove the schema choice (access patterns, cardinality, denormalisation trade-offs). Include the rollback plan if the decision proves wrong. Tag with "schema" and affected table names.',
  'api': 'Log the API contract decision including versioning strategy. Capture backward-compatibility commitments, breaking-change triggers, and the client impact. Once an API contract is published, record it as immutable unless a version bump is logged.',
  'general': 'Use the ADR format: context → decision → rationale → alternatives → consequences. Log to veto_memory_store (type="decision") and the local decisions table. Reference the ADR ID in code comments near the implementation.',
};

const categorySteps: Record<DecisionCategory, string[]> = {
  'architecture': [
    'Assign a sequential ADR ID (ADR-001, ADR-002, …)',
    'Write the context: what forces, constraints, or requirements make this choice necessary?',
    'State the decision in one unambiguous sentence',
    'Document the rationale: why this option over alternatives?',
    'List at least two alternatives that were genuinely considered',
    'For each alternative: pros, cons, and the specific reason it was rejected',
    'Document positive consequences: what does this decision enable?',
    'Document negative consequences: what technical debt or constraints does it introduce?',
    'Set status: proposed | accepted | deprecated | superseded-by:ADR-xxx',
    'Add file references to the implementation',
    'Call veto_memory_store with type="decision", title=ADR ID, tags=["architecture"]',
    'Add // See ADR-001 comment near the implementation',
  ],
  'security': [
    'Describe the threat being mitigated (attack vector, affected asset, likelihood)',
    'State the chosen security control in one sentence',
    'Document why weaker alternatives were rejected (OWASP reference where applicable)',
    'Document why stronger alternatives were not chosen (operational burden, complexity, cost)',
    'Quantify residual risk: what attack surface remains after this control?',
    'Reference relevant standards: OWASP, NIST, RFC',
    'Set a review date — security decisions should be re-evaluated annually',
    'Call veto_memory_store with type="decision", tags=["security", threat category]',
    'Add SECURITY-DECISION comment near the implementation with a reference link',
  ],
  'data': [
    'Describe the access patterns this schema must support',
    'State the chosen schema structure (table names, key columns, relationships)',
    'Document denormalisation choices: what query performance trade-off justifies them?',
    'Document normalisation choices: what integrity benefit justifies the join cost?',
    'Write the migration plan: how to move existing data to the new schema?',
    'Write the rollback plan: how to revert if the schema proves wrong?',
    'Note index strategy: which columns need indexes and why?',
    'Call veto_memory_store with type="decision", tags=["schema", table name]',
    'Record the decision_id in the migration file comment',
  ],
  'api': [
    'Define the API contract: method, path, request shape, response shape',
    'State the versioning strategy: URL path (/v1/), header, or content negotiation',
    'Document backward-compatibility commitments for this version',
    'List fields that must never be removed or renamed without a version bump',
    'Define breaking-change criteria: what requires a new major version?',
    'Document deprecation timeline if replacing an existing endpoint',
    'Reference the OpenAPI spec file path',
    'Call veto_memory_store with type="decision", tags=["api-contract", endpoint path]',
    'Add OpenAPI operation ID that matches the decision ID for traceability',
  ],
  'general': [
    'Assign an ADR ID if this is a durable architectural decision',
    'Write the context: what problem or constraint is being addressed?',
    'State the decision clearly in one sentence',
    'Document the rationale with at least two sentences of "why"',
    'List alternatives that were considered and rejected',
    'Identify the primary consequence: what does this decision make easier and harder?',
    'Call veto_memory_store with type="decision", title, and relevant tags',
    'If the decision affects code, add a reference comment near the implementation',
    'Set a review trigger: what event should prompt re-evaluating this decision?',
  ],
};

const categoryChecklist: Record<DecisionCategory, string[]> = {
  'architecture': [
    '[ ] ADR ID assigned sequentially',
    '[ ] Context section explains forces in play, not just the problem statement',
    '[ ] Decision stated in one clear sentence',
    '[ ] Rationale answers "why this over alternatives"',
    '[ ] At least two alternatives documented with rejection reason',
    '[ ] Positive consequences listed',
    '[ ] Negative consequences / technical debt acknowledged',
    '[ ] Status set to "accepted"',
    '[ ] Stored in veto_memory_store with type="decision"',
    '[ ] Code comment added: // See ADR-xxx',
  ],
  'security': [
    '[ ] Threat clearly described: vector, asset, likelihood',
    '[ ] Chosen control stated',
    '[ ] Weaker alternatives rejected with reason',
    '[ ] Residual risk quantified',
    '[ ] OWASP or NIST reference included where applicable',
    '[ ] Review date set',
    '[ ] Stored with tags=["security"]',
  ],
  'data': [
    '[ ] Access patterns documented before schema choice',
    '[ ] Schema decision stated with table/column names',
    '[ ] Migration plan included',
    '[ ] Rollback plan included',
    '[ ] Index strategy documented',
    '[ ] Stored with tags=["schema", table name]',
    '[ ] Migration file references the decision ID',
  ],
  'api': [
    '[ ] Endpoint contract fully specified',
    '[ ] Versioning strategy stated',
    '[ ] Backward-compatibility commitments listed',
    '[ ] Breaking-change criteria defined',
    '[ ] Deprecation plan if replacing existing endpoint',
    '[ ] OpenAPI spec path referenced',
    '[ ] Stored with tags=["api-contract"]',
  ],
  'general': [
    '[ ] Decision stated in one clear sentence',
    '[ ] Rationale documented',
    '[ ] Alternatives listed with rejection reasons',
    '[ ] Primary consequence identified',
    '[ ] Stored in veto_memory_store',
    '[ ] Code comment added if decision affects implementation',
    '[ ] Review trigger identified',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'decision-logger' as WorkerAgentType,
    task,
    tier: 1,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: [
      'Logging the decision after the fact with hindsight bias — capture original thinking at decision time',
      'Writing the "what" without the "why" — future engineers see the choice but not the reasoning',
      'Only logging the chosen option without alternatives — looks like no deliberation happened',
      'Forgetting to update the status when a decision is superseded — stale "accepted" entries cause confusion',
      'Using vague titles like "Auth decision" instead of "Use JWT with rotating refresh tokens"',
      'Not linking the ADR from the implementation — the decision and code drift apart',
      'Logging trivial decisions (variable names) — reserve the log for non-obvious, hard-to-reverse choices',
    ],
    patterns: [
      'ADR (Architecture Decision Record): context → decision → rationale → alternatives → consequences',
      'Decision-in-context: co-locate decision reference with implementation via code comments',
      'Living document: update status (deprecated / superseded-by) rather than deleting entries',
      'Decision chain: reference prior ADRs that this decision builds on or overrides',
    ],
    duration_estimate: '15-30 minutes',
  };
}
