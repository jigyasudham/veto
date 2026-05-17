// LLM-backed council — runs all 7 agents via MCP sampling in parallel.
// Falls back to the deterministic agent for any individual call that fails.
// Falls back entirely to deterministic runDebate() if sampling is not supported.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgentVote, DebateInput, DebateResult } from './types.js';
import { decide, formatDebate } from './decision-engine.js';
import { buildContextString } from '../context/reader.js';
import { searchKnowledge } from '../memory/local.js';

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

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  pm: `You are the Product Manager in a software council. Assess user value, business alignment, scope clarity, and product-market fit. Approve features that deliver clear value, warn when scope is vague or requirements are incomplete, block only when something contradicts core product goals.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  architect: `You are the System Architect in a software council. Assess scalability, maintainability, system design, coupling, and architectural integrity. Approve decisions that fit the architecture well, warn about complexity or coupling risks, block breaking changes that violate architectural principles.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  ux: `You are the UX Designer in a software council. Assess usability, accessibility, user flow, and experience quality. Approve changes that improve or maintain UX, warn about confusing patterns or missing states, block changes that harm users or violate accessibility standards.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  devil: `You are the Devil's Advocate in a software council. Your job is to find problems others miss — edge cases, failure modes, hidden dependencies, unintended consequences, and flawed assumptions. Be incisive. Warn about risks that compound over time. Block when you identify a fatal flaw.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  legal: `You are the Legal & Compliance officer in a software council. Assess regulatory risk, data privacy (GDPR, CCPA), licensing conflicts, and compliance requirements. Approve decisions within legal boundaries, warn about grey areas, block anything that creates clear legal liability or compliance violations.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,

  security: `You are the Security Engineer in a software council. Assess security implications using OWASP Top 10 and security best practices. Approve secure designs, warn about potential vulnerabilities, block anything that introduces clear security risks — injection, broken auth, sensitive data exposure, or insecure design.

Return ONLY valid JSON, no other text:
{"verdict":"approve"|"warn"|"block","reason":"one sentence","concerns":["concern1"],"recommendation":"actionable advice"}`,
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
): Promise<AgentVote> {
  const userText = memoryContext
    ? `Task to evaluate:\n${task}\n\nRelevant past council decisions:\n${memoryContext}`
    : `Task to evaluate:\n${task}`;

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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runLlmDebate(server: Server, input: DebateInput): Promise<DebateResult> {
  const enrichedContext = buildContextString(input.project_dir, input.context);
  const fullText = enrichedContext ? `${input.task}\n\n${enrichedContext}` : input.task;
  const memoryContext = buildMemoryContext(input.task, input.project_dir);

  // All 7 agents run in parallel — each falls back individually on sampling failure
  const [lead_dev, pm, architect, ux, devil, legal, security] = await Promise.all([
    callAgentLlm(server, 'lead_dev',  fullText, memoryContext),
    callAgentLlm(server, 'pm',        fullText, memoryContext),
    callAgentLlm(server, 'architect', fullText, memoryContext),
    callAgentLlm(server, 'ux',        fullText, memoryContext),
    callAgentLlm(server, 'devil',     fullText, memoryContext),
    callAgentLlm(server, 'legal',     fullText, memoryContext),
    callAgentLlm(server, 'security',  fullText, memoryContext),
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
