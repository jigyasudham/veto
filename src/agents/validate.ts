import type { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity, WorkerAgentType } from './types.js';

const SEVERITY_VALUES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const VERDICT_VALUES = ['approved', 'approved_with_warnings', 'needs_revision', 'rejected'] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(item => str(item)).filter(Boolean);
}

function severity(v: unknown): FindingSeverity {
  const s = str(v).toLowerCase() as FindingSeverity;
  return SEVERITY_VALUES.includes(s) ? s : 'info';
}

function sanitizeFinding(raw: unknown): AgentFinding | null {
  if (!isObj(raw)) return null;
  return {
    severity: severity(raw.severity),
    category:    str(raw.category,    'general'),
    description: str(raw.description, 'No description'),
    fix:         str(raw.fix,         'No fix provided'),
    location:    raw.location    ? str(raw.location)    : undefined,
    cwe:         raw.cwe         ? str(raw.cwe)         : undefined,
    owasp:       raw.owasp       ? str(raw.owasp)       : undefined,
  };
}

/**
 * Validates and sanitizes an AgentPlan. Returns null if the value is not
 * recoverable (e.g. not an object at all). Otherwise returns a clean plan
 * with all required fields present and values clamped to valid ranges.
 */
export function validateAgentPlan(raw: unknown, agentType: WorkerAgentType): AgentPlan | null {
  if (!isObj(raw)) return null;
  const tier = clampNum(raw.tier, 1, 3, 2) as 1 | 2 | 3;
  return {
    agent:             str(raw.agent, agentType) as WorkerAgentType,
    task:              str(raw.task),
    tier,
    approach:          str(raw.approach),
    steps:             strArr(raw.steps),
    checklist:         strArr(raw.checklist),
    pitfalls:          strArr(raw.pitfalls),
    patterns:          strArr(raw.patterns),
    duration_estimate: str(raw.duration_estimate, 'unknown'),
  };
}

/**
 * Validates and sanitizes an AgentAnalysis. Returns null if not recoverable.
 */
export function validateAgentAnalysis(raw: unknown, agentType: WorkerAgentType): AgentAnalysis | null {
  if (!isObj(raw)) return null;
  const findings: AgentFinding[] = Array.isArray(raw.findings)
    ? raw.findings.map(sanitizeFinding).filter((f): f is AgentFinding => f !== null)
    : [];
  const score = clampNum(raw.score, 0, 100, 70);
  const rawVerdict = str(raw.verdict).toLowerCase();
  const verdict = VERDICT_VALUES.includes(rawVerdict as typeof VERDICT_VALUES[number])
    ? (rawVerdict as AgentAnalysis['verdict'])
    : score >= 80 ? 'approved' : score >= 60 ? 'approved_with_warnings' : 'needs_revision';
  const critical_count = findings.filter(f => f.severity === 'critical').length;
  const high_count     = findings.filter(f => f.severity === 'high').length;
  return {
    agent:          str(raw.agent, agentType) as WorkerAgentType,
    subject:        str(raw.subject),
    findings,
    score,
    verdict,
    summary:        str(raw.summary),
    critical_count: typeof raw.critical_count === 'number' ? raw.critical_count : critical_count,
    high_count:     typeof raw.high_count     === 'number' ? raw.high_count     : high_count,
  };
}
