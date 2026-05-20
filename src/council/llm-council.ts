// LLM-backed council — three tiers:
//   1. MCP Sampling (server.createMessage) — if host implements it
//   2. Agentic loop — host AI reasons as all 7 agents, passes responses back
//   3. Deterministic fallback — always available, zero tokens

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgentVote, DebateInput, DebateResult } from './types.js';
import { decide, formatDebate } from './decision-engine.js';
import { buildContextString } from '../context/reader.js';
import { searchKnowledge } from '../memory/local.js';
import { extractDecision } from './decision-extractor.js';

// Deterministic fallbacks — one per agent
import { analyze as leadDevFallback }  from './lead-developer.js';
import { analyze as pmFallback }       from './product-manager.js';
import { analyze as architectFallback } from './system-architect.js';
import { analyze as uxFallback }       from './ux-designer.js';
import { analyze as devilFallback }    from './devil-advocate.js';
import { analyze as legalFallback }    from './legal-compliance.js';
import { analyze as securityFallback } from './security.js';

// ─── Agent personas ───────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  lead_dev: `You are the Lead Developer in a software council. Assess technical feasibility, code quality, implementation risk, and engineering best practices. Be pragmatic — approve sound work, warn about concerning patterns, block only when something is technically broken or creates severe technical debt.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option you prefer and why — do not give generic advice that applies to both. Name the option you prefer in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific concern"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,

  pm: `You are the Product Manager in a software council. Assess user value, business alignment, scope clarity, and product-market fit. Approve features that deliver clear value, warn when scope is vague or requirements are incomplete, block only when something contradicts core product goals.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option you prefer and why — do not give generic advice that applies to both. Name the option you prefer in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific concern"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,

  architect: `You are the System Architect in a software council. Assess scalability, maintainability, system design, coupling, and architectural integrity. Approve decisions that fit the architecture well, warn about complexity or coupling risks, block breaking changes that violate architectural principles.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option you prefer and why — do not give generic advice that applies to both. Name the option you prefer in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific concern"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,

  ux: `You are the UX Designer in a software council. Assess usability, accessibility, user flow, and experience quality. Approve changes that improve or maintain UX, warn about confusing patterns or missing states, block changes that harm users or violate accessibility standards.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option you prefer and why — do not give generic advice that applies to both. Name the option you prefer in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific concern"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,

  devil: `You are the Devil's Advocate in a software council. Your job is to find problems others miss — edge cases, failure modes, hidden dependencies, unintended consequences, and flawed assumptions. Be incisive. Warn about risks that compound over time. Block when you identify a fatal flaw.

IMPORTANT: If the task presents two specific options, challenge the one that looks more attractive or ambitious. Ask: what breaks first? What's the worst-case failure mode of the preferred option? Name the option you are challenging in your reason.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence challenging the specific proposed option","concerns":["failure mode 1","failure mode 2"],"recommendation":"actionable mitigation for the named option"}`,

  legal: `You are the Legal & Compliance officer in a software council. Assess regulatory risk, data privacy (GDPR, CCPA), licensing conflicts, and compliance requirements. Approve decisions within legal boundaries, warn about grey areas, block anything that creates clear legal liability or compliance violations.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option has lower legal risk and why — do not give generic advice that applies to both. Name the safer option in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific legal concern"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,

  security: `You are the Security Engineer in a software council. Assess security implications using OWASP Top 10 and security best practices. Approve secure designs, warn about potential vulnerabilities, block anything that introduces clear security risks — injection, broken auth, sensitive data exposure, or insecure design.

IMPORTANT: If the task presents two specific options (e.g. "A vs B" or "should we X or Y"), your recommendation MUST explicitly state which option is more secure and why — do not give generic advice that applies to both. Name the more secure option in your recommendation field.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence directly addressing the task","concerns":["specific vulnerability"],"recommendation":"Prefer [named option] — reason specific to your domain"}`,
};

const FALLBACKS: Record<string, (task: string) => AgentVote> = {
  lead_dev:  leadDevFallback,
  pm:        pmFallback,
  architect: architectFallback,
  ux:        uxFallback,
  devil:     devilFallback,
  legal:     legalFallback,
  security:  securityFallback,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAgentVote(text: string, agentKey: string, fallbackTask: string): AgentVote {
  try {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('no JSON found');
    const raw = JSON.parse(match[0]);
    const verdict = (['approve', 'warn', 'block'] as const).includes(raw.verdict) ? raw.verdict : 'warn';
    return {
      verdict,
      reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : 'No reason provided.',
      concerns: Array.isArray(raw.concerns) ? raw.concerns.filter((c: unknown) => typeof c === 'string') : [],
      recommendation: typeof raw.recommendation === 'string' ? raw.recommendation : undefined,
    };
  } catch {
    return FALLBACKS[agentKey](fallbackTask);
  }
}

function buildMemoryContext(task: string, project_dir?: string): string {
  try {
    const memories = searchKnowledge({ query: task, type: 'decision', limit: 2, project_dir });
    if (memories.length === 0) return '';
    return memories
      .map(m => `- ${m.title}: ${m.content.slice(0, 120)}`)
      .join('\n');
  } catch {
    return '';
  }
}

// ─── Core: one LLM sampling call per agent ────────────────────────────────────

async function callAgentLlm(
  server: Server,
  agentKey: string,
  task: string,
  memoryContext: string,
  decisionContext?: string,
): Promise<AgentVote> {
  const parts: string[] = [`Task to evaluate:\n${task}`];
  if (decisionContext) parts.push(`\nARCHITECTURAL CHOICE DETECTED:\n${decisionContext}\nYour response MUST address this specific choice — name the option you prefer in your recommendation.`);
  if (memoryContext) parts.push(`\nRelevant past council decisions:\n${memoryContext}`);
  const userText = parts.join('\n');

  try {
    const result = await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: userText } }],
      systemPrompt: SYSTEM_PROMPTS[agentKey],
      maxTokens: 300,
      includeContext: 'none',
    });

    const responseText = result.content.type === 'text' ? result.content.text : '';
    return parseAgentVote(responseText, agentKey, task);
  } catch {
    // Sampling unavailable or failed for this agent — use deterministic fallback
    return FALLBACKS[agentKey](task);
  }
}

// ─── Agentic loop: host AI reasons as all 7 agents ───────────────────────────

const AGENT_ROLE_DESCRIPTIONS: Record<string, string> = {
  lead_dev:  'Lead Developer — technical feasibility, code quality, implementation risk, engineering best practices. Block when something is technically broken or creates severe debt.',
  pm:        'Product Manager — user value, business alignment, scope clarity, product-market fit. Block when something contradicts core product goals.',
  architect: 'System Architect — scalability, maintainability, coupling, architectural integrity. Block breaking changes that violate architectural principles.',
  ux:        'UX Designer — usability, accessibility, user flow, experience quality. Block changes that harm users or violate accessibility standards.',
  devil:     "Devil's Advocate — find failure modes, edge cases, hidden dependencies, flawed assumptions. Challenge the most attractive option. Block on fatal flaws.",
  legal:     'Legal & Compliance — GDPR, CCPA, licensing, data privacy, regulatory exposure. Block anything creating clear legal liability.',
  security:  'Security Engineer — OWASP Top 10, auth, injection, data leakage, threat model. Block anything introducing clear security risks.',
};

export function buildAgenticDebatePrompt(task: string, enrichedContext: string, decisionContext?: string): string {
  const agentEntries = Object.entries(AGENT_ROLE_DESCRIPTIONS)
    .map(([key, desc]) => `  "${key}": ${desc}`)
    .join('\n');

  const decisionNote = decisionContext
    ? `\n\nARCHITECTURAL CHOICE IN TASK: ${decisionContext}\nEach agent MUST name which option they prefer in their recommendation.`
    : '';

  const schema = `{
  "lead_dev":  { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["concern"], "recommendation": "actionable advice" },
  "pm":        { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["concern"], "recommendation": "actionable advice" },
  "architect": { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["concern"], "recommendation": "actionable advice" },
  "ux":        { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["concern"], "recommendation": "actionable advice" },
  "devil":     { "verdict": "warn|block",          "reason": "one sentence", "concerns": ["failure mode"], "recommendation": "mitigation" },
  "legal":     { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["concern"], "recommendation": "actionable advice" },
  "security":  { "verdict": "approve|warn|block", "reason": "one sentence", "concerns": ["vulnerability"], "recommendation": "actionable advice" }
}`;

  return `You are running a Veto Council debate. Analyze the following task as each of the 7 specialists below. Each specialist evaluates independently from their own domain perspective.

SPECIALIST ROLES:
${agentEntries}${decisionNote}

TASK:
${task}
${enrichedContext ? `\nCONTEXT:\n${enrichedContext}` : ''}

RULES:
- Each specialist speaks only from their domain — Lead Dev does NOT comment on business value, PM does NOT comment on code quality, etc.
- devil always warns or blocks, never approves non-trivial tasks
- If the task presents two options (A vs B), each specialist MUST name which they prefer in their recommendation
- Keep each reason to one sentence. Concerns are brief phrases.

Return ONLY this JSON (no markdown, no prose before or after):
${schema}`;
}

export function parseAgentResponses(raw: string, task: string): DebateResult['votes'] | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const agents = ['lead_dev', 'pm', 'architect', 'ux', 'devil', 'legal', 'security'] as const;

    const votes = {} as DebateResult['votes'];
    for (const key of agents) {
      const raw_vote = parsed[key];
      if (!raw_vote || typeof raw_vote !== 'object') {
        votes[key] = FALLBACKS[key](task);
        continue;
      }
      const verdict = (['approve', 'warn', 'block'] as const).includes(raw_vote.verdict)
        ? raw_vote.verdict as 'approve' | 'warn' | 'block'
        : 'warn';
      votes[key] = {
        verdict,
        reason: typeof raw_vote.reason === 'string' ? raw_vote.reason : 'No reason provided.',
        concerns: Array.isArray(raw_vote.concerns)
          ? raw_vote.concerns.filter((c: unknown) => typeof c === 'string')
          : [],
        recommendation: typeof raw_vote.recommendation === 'string' ? raw_vote.recommendation : undefined,
      };
    }
    return votes;
  } catch {
    return null;
  }
}

export function runFromAgentResponses(input: DebateInput, votes: DebateResult['votes']): DebateResult {
  const { final_verdict, block_reasons, warnings, recommended } = decide(votes);
  const debated_at = new Date().toISOString();
  const formatted_output = formatDebate(input.task, votes, final_verdict, block_reasons, warnings, recommended);
  return { task: input.task, final_verdict, votes, recommended, block_reasons, warnings, debated_at, formatted_output };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runLlmDebate(server: Server, input: DebateInput): Promise<DebateResult> {
  const enrichedContext = buildContextString(input.project_dir, input.context);
  const fullText = enrichedContext ? `${input.task}\n\n${enrichedContext}` : input.task;
  const memoryContext = buildMemoryContext(input.task, input.project_dir);

  // Extract architectural choice if present — inject into every LLM call
  const decision = extractDecision(input.task);
  const decisionContext = decision.isDecisionTask
    ? `Option A: "${decision.optionA}" vs Option B: "${decision.optionB}"`
    : undefined;

  // All 7 agents run in parallel — each falls back individually on sampling failure
  const [lead_dev, pm, architect, ux, devil, legal, security] = await Promise.all([
    callAgentLlm(server, 'lead_dev',  fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'pm',        fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'architect', fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'ux',        fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'devil',     fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'legal',     fullText, memoryContext, decisionContext),
    callAgentLlm(server, 'security',  fullText, memoryContext, decisionContext),
  ]);

  const votes = { lead_dev, pm, architect, ux, devil, legal, security };
  const { final_verdict, block_reasons, warnings, recommended } = decide(votes);
  const debated_at = new Date().toISOString();
  const formatted_output = formatDebate(input.task, votes, final_verdict, block_reasons, warnings, recommended);

  return {
    task: input.task,
    final_verdict,
    votes,
    recommended,
    block_reasons,
    warnings,
    debated_at,
    formatted_output,
  };
}
