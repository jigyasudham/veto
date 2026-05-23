import { z } from 'zod';
import type { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity, WorkerAgentType } from './types.js';

const findingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('info').catch('info'),
  category: z.string().default('general').catch('general'),
  description: z.string().default('No description').catch('No description'),
  fix: z.string().default('No fix provided').catch('No fix provided'),
  location: z.string().optional().catch(undefined),
  cwe: z.string().optional().catch(undefined),
  owasp: z.string().optional().catch(undefined)
});

const planSchema = z.object({
  agent: z.string().catch(''),
  task: z.string().catch(''),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2).catch(2),
  approach: z.string().default('').catch(''),
  steps: z.array(z.string()).default([]).catch([]),
  checklist: z.array(z.string()).default([]).catch([]),
  pitfalls: z.array(z.string()).default([]).catch([]),
  patterns: z.array(z.string()).default([]).catch([]),
  duration_estimate: z.string().default('unknown').catch('unknown')
});

const analysisSchema = z.object({
  agent: z.string().catch(''),
  subject: z.string().default('').catch(''),
  findings: z.array(findingSchema).default([]).catch([]),
  score: z.number().min(0).max(100).default(70).catch(70),
  verdict: z.enum(['approved', 'approved_with_warnings', 'needs_revision', 'rejected']).default('approved_with_warnings').catch('approved_with_warnings'),
  summary: z.string().default('').catch(''),
  critical_count: z.number().optional().catch(undefined),
  high_count: z.number().optional().catch(undefined)
});

/**
 * Validates and sanitizes an AgentPlan. Returns null if the value is not
 * recoverable. Otherwise returns a clean plan using Zod.
 */
export function validateAgentPlan(raw: unknown, agentType: WorkerAgentType): AgentPlan | null {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, agent: agentType } as AgentPlan;
}

/**
 * Validates and sanitizes an AgentAnalysis. Returns null if not recoverable.
 */
export function validateAgentAnalysis(raw: unknown, agentType: WorkerAgentType): AgentAnalysis | null {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const critical_count = data.critical_count ?? data.findings.filter(f => f.severity === 'critical').length;
  const high_count = data.high_count ?? data.findings.filter(f => f.severity === 'high').length;
  return { ...data, agent: agentType, critical_count, high_count } as AgentAnalysis;
}
