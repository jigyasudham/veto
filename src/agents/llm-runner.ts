// LLM-backed worker agent runner — uses MCP Sampling (server.createMessage) to
// produce richer plan/analysis output than the deterministic fallbacks.
// Falls back to the deterministic agent silently if sampling is unavailable.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getManifestEntry } from './manifest.js';
import type { AgentTask, AgentResult, AgentPlan, AgentAnalysis, WorkerAgentType, AgentOutput } from './types.js';
import { validateAgentPlan, validateAgentAnalysis } from './validate.js';
import { log, errMsg } from '../log.js';

// ─── System prompt builders ───────────────────────────────────────────────────

function buildPlanPrompt(agent: WorkerAgentType, role: string): string {
  return `You are the ${agent} specialist in an AI-assisted software engineering system.

ROLE: ${role}

Your job: given a task description and optional code/context, produce a concrete implementation plan.

Return ONLY valid JSON (no markdown, no prose):
{
  "agent": "${agent}",
  "task": "<task echoed back>",
  "tier": 1|2|3,
  "approach": "<2-3 sentence strategy — the WHY and HOW, not step list>",
  "steps": ["<ordered action step>", ...],
  "checklist": ["[ ] <verification item>", ...],
  "pitfalls": ["<gotcha or common mistake>", ...],
  "patterns": ["<design pattern or principle to apply>", ...],
  "duration_estimate": "<e.g. 1-2 hours>"
}

Rules:
- tier: 1 = simple (<1h), 2 = medium (1-4h), 3 = complex (>4h)
- steps: 6-12 concrete, ordered actions
- checklist: 6-10 testable done-criteria prefixed with "[ ] "
- pitfalls: 3-5 non-obvious mistakes specific to this task
- patterns: 3-5 relevant design patterns or engineering principles
- Keep total JSON under 800 tokens`;
}

function buildAnalysisPrompt(agent: WorkerAgentType, role: string): string {
  return `You are the ${agent} specialist in an AI-assisted software engineering system.

ROLE: ${role}

Your job: given code and optional context, produce a scored analysis with actionable findings.

Return ONLY valid JSON (no markdown, no prose):
{
  "agent": "${agent}",
  "subject": "<one-line description of what was analyzed>",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "category": "<category name>",
      "description": "<what is wrong and why it matters>",
      "fix": "<specific, actionable remediation>",
      "location": "<file:line if applicable>",
      "cwe": "<CWE-NNN if applicable>"
    }
  ],
  "score": <0-100, 100 = perfect>,
  "verdict": "approved|approved_with_warnings|needs_revision|rejected",
  "summary": "<one sentence overall assessment>",
  "critical_count": <integer>,
  "high_count": <integer>
}

Rules:
- findings: list ALL issues found; empty array is valid for clean code
- score: 90-100 = clean, 70-89 = minor issues, 50-69 = needs work, <50 = reject
- verdict: approved (score≥90), approved_with_warnings (score 70-89), needs_revision (50-69), rejected (<50)
- critical_count and high_count MUST match findings array
- Keep total JSON under 1000 tokens`;
}

// ─── Response parsers ─────────────────────────────────────────────────────────

export function parsePlanResponse(raw: string, agent: WorkerAgentType, task: string): AgentPlan | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);

    const plan: AgentPlan = {
      agent,
      task: typeof p.task === 'string' ? p.task : task,
      tier: ([1, 2, 3] as const).includes(p.tier) ? p.tier : 2,
      approach: typeof p.approach === 'string' && p.approach ? p.approach : 'No approach provided.',
      steps: Array.isArray(p.steps) ? p.steps.filter((s: unknown) => typeof s === 'string') : [],
      checklist: Array.isArray(p.checklist) ? p.checklist.filter((c: unknown) => typeof c === 'string') : [],
      pitfalls: Array.isArray(p.pitfalls) ? p.pitfalls.filter((x: unknown) => typeof x === 'string') : [],
      patterns: Array.isArray(p.patterns) ? p.patterns.filter((x: unknown) => typeof x === 'string') : [],
      duration_estimate: typeof p.duration_estimate === 'string' ? p.duration_estimate : '2-4 hours',
    };

    return validateAgentPlan(plan, agent) ?? plan;
  } catch {
    return null;
  }
}

export function parseAnalysisResponse(raw: string, agent: WorkerAgentType): AgentAnalysis | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);

    const verdicts = ['approved', 'approved_with_warnings', 'needs_revision', 'rejected'] as const;
    const analysis: AgentAnalysis = {
      agent,
      subject: typeof p.subject === 'string' ? p.subject : 'Code analysis',
      findings: Array.isArray(p.findings) ? p.findings.filter(isValidFinding) : [],
      score: typeof p.score === 'number' ? Math.min(100, Math.max(0, Math.round(p.score))) : 70,
      verdict: verdicts.includes(p.verdict) ? p.verdict : 'approved_with_warnings',
      summary: typeof p.summary === 'string' ? p.summary : 'No summary provided.',
      critical_count: typeof p.critical_count === 'number' ? p.critical_count : 0,
      high_count: typeof p.high_count === 'number' ? p.high_count : 0,
    };

    return validateAgentAnalysis(analysis, agent) ?? analysis;
  } catch {
    return null;
  }
}

function isValidFinding(f: unknown): boolean {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return typeof o.severity === 'string' && typeof o.description === 'string' && typeof o.fix === 'string';
}

// ─── Core LLM call ───────────────────────────────────────────────────────────

export async function runAgentLlm(
  server: Server,
  task: AgentTask,
): Promise<{ plan?: AgentPlan; analysis?: AgentAnalysis } | null> {
  const entry = getManifestEntry(task.agent);
  if (!entry) return null;

  const isAnalysis = task.code !== undefined && entry.output_type === 'analysis';
  const systemPrompt = isAnalysis
    ? buildAnalysisPrompt(task.agent, entry.role)
    : buildPlanPrompt(task.agent, entry.role);

  const userParts: string[] = [];
  if (isAnalysis) {
    userParts.push(`Code to analyze:\n\`\`\`\n${task.code}\n\`\`\``);
  } else {
    userParts.push(`Task: ${task.task}`);
  }
  if (task.context) userParts.push(`\nContext:\n${task.context}`);
  const userText = userParts.join('\n');

  try {
    const result = await server.createMessage({
      model: task.model,
      messages: [{ role: 'user', content: { type: 'text', text: userText } }],
      systemPrompt,
      maxTokens: isAnalysis ? 1000 : 800,
    } as any);

    const responseText = result.content.type === 'text' ? result.content.text : '';
    if (!responseText) return null;

    if (isAnalysis) {
      const analysis = parseAnalysisResponse(responseText, task.agent);
      return analysis ? { analysis } : null;
    } else {
      const plan = parsePlanResponse(responseText, task.agent, task.task);
      return plan ? { plan } : null;
    }
  } catch (err) {
    // Sampling unavailable/failed is an expected path (host may not support it) —
    // log at debug and let the caller fall back to the agentic prompt.
    log.debug('mcp sampling failed; falling back', { agent: task.agent, error: errMsg(err) });
    return null;
  }
}

// ─── Agentic loop prompt ──────────────────────────────────────────────────────

export function buildAgenticAgentPrompt(task: AgentTask): import('./types.js').AgenticAgentPrompt | null {
  const entry = getManifestEntry(task.agent);
  if (!entry) return null;

  const isAnalysis = task.code !== undefined && entry.output_type === 'analysis';
  const schema = isAnalysis
    ? buildAnalysisPrompt(task.agent, entry.role)
    : buildPlanPrompt(task.agent, entry.role);

  return {
    mode: 'agentic',
    agent: task.agent,
    instruction: `MCP Sampling is unavailable. Reason as the ${task.agent} specialist and produce the output yourself, then return it in the result.`,
    output_prompt: isAnalysis
      ? `Analyze the following code as the ${task.agent} specialist:\n\n${task.code ?? ''}\n\n${task.context ? `Context: ${task.context}` : ''}`
      : `Plan the following task as the ${task.agent} specialist:\n\n${task.task}\n\n${task.context ? `Context: ${task.context}` : ''}`,
    schema,
  };
}

export function parseAgenticAgentResponses(
  tasks: AgentTask[],
  responses: Record<string, unknown>
): AgentResult[] {
  const results: AgentResult[] = [];
  const start = Date.now();

  for (const task of tasks) {
    const raw = responses[task.id] || responses[task.agent];
    if (!raw) {
      results.push({
        id: task.id,
        agent: task.agent,
        output: { confidence: 0, severity: 'info', recommendation: 'Missing agent response', affected_files: [], line_refs: [] },
        duration_ms: 0,
        error: 'Missing response for this task in agent_outputs',
      });
      continue;
    }

    const entry = getManifestEntry(task.agent);
    const isAnalysis = task.code !== undefined && entry?.output_type === 'analysis';

    if (isAnalysis) {
      const analysis = parseAnalysisResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), task.agent);
      results.push({
        id: task.id,
        agent: task.agent,
        analysis: analysis || undefined,
        output: deriveOutputFromAny(undefined, analysis || undefined),
        duration_ms: Date.now() - start,
        llm_backed: true,
        error: !analysis ? 'Failed to parse agent analysis JSON' : undefined,
      });
    } else {
      const plan = parsePlanResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), task.agent, task.task);
      results.push({
        id: task.id,
        agent: task.agent,
        plan: plan || undefined,
        output: deriveOutputFromAny(plan || undefined, undefined),
        duration_ms: Date.now() - start,
        llm_backed: true,
        error: !plan ? 'Failed to parse agent plan JSON' : undefined,
      });
    }
  }

  return results;
}

function deriveOutputFromAny(plan?: AgentPlan, analysis?: AgentAnalysis): AgentOutput {
  if (analysis) {
    return {
      confidence: Math.min(1, Math.max(0, analysis.score / 100)),
      severity: analysis.critical_count > 0 ? 'critical' : analysis.high_count > 0 ? 'high' : 'medium',
      recommendation: analysis.summary,
      affected_files: [],
      line_refs: analysis.findings
        .filter(f => f.location)
        .map(f => ({ file: f.location!, line: 0, description: f.description })),
    };
  }
  if (plan) {
    // simplified confidence for manual responses
    return {
      confidence: 0.9,
      severity: 'info',
      recommendation: plan.approach,
      affected_files: [],
      line_refs: [],
    };
  }
  return { confidence: 0, severity: 'info', recommendation: '', affected_files: [], line_refs: [] };
}
