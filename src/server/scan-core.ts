// Reusable handler logic shared across the review / agentic-worker MCP tools.
//
// Extracted from server.ts so it can be unit-tested: server.ts connects stdio at
// import time, so anything defined there is untestable. These helpers depend only
// on the agent layer and the router — no server-local state — so they live here.

import { execSync as execSyncTop } from 'node:child_process';
import type { AgentTask, AgentResult, AgenticAgentPrompt, WorkerAgentType } from '../agents/types.js';
import { executeOne } from '../agents/executor.js';
import { buildAgenticAgentPrompt, parseAgenticAgentResponses } from '../agents/llm-runner.js';
import { recordOutcome } from '../router/index.js';

/**
 * Reads a git diff for the review tools. Default: working-tree vs HEAD, falling
 * back to staged changes. With stagedOnly=true (pre-commit / commit-message
 * semantics) it returns staged changes only. Returns '' on any failure or when
 * there are no changes — callers decide how to report "nothing to review".
 */
export function readGitDiff(projectDir: string | undefined, stagedOnly = false): string {
  if (!projectDir) return '';
  const run = (cmd: string) => execSyncTop(cmd, { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  try {
    if (stagedOnly) return run('git diff --cached --no-color');
    const head = run('git diff HEAD --no-color');
    return head || run('git diff --cached --no-color');
  } catch {
    return '';
  }
}

export async function runTripleScan(diff: string, context: string, llm_backed = true, agent_outputs?: Record<string, unknown>) {
  const tasks: AgentTask[] = [
    { id: 'scan-review',  agent: 'reviewer',         task: 'Review this git diff for code quality issues', code: diff, context, llm_backed },
    { id: 'scan-sec',     agent: 'security-scanner', task: 'Scan this git diff for security vulnerabilities', code: diff, context, llm_backed },
    { id: 'scan-secrets', agent: 'secrets',          task: 'Scan this git diff for exposed secrets or credentials', code: diff, llm_backed },
  ];

  if (llm_backed && !agent_outputs) {
    const results = await Promise.all(tasks.map(t => executeOne(t)));
    const allLlm = results.every(r => r.llm_backed && !r.error);
    if (allLlm) return finalizeTripleScan(results[0], results[1], results[2]);
    const prompts = tasks.map(t => buildAgenticAgentPrompt(t)).filter((p): p is AgenticAgentPrompt => p !== null);
    return {
      mode: 'agentic_loop' as const,
      instruction: 'Reason as each agent below using their provided roles and schemas. Return a JSON object mapping task IDs to agent responses.',
      prompts,
    };
  }
  const results = (llm_backed && agent_outputs) ? parseAgenticAgentResponses(tasks, agent_outputs) : await Promise.all(tasks.map(t => executeOne(t)));
  return finalizeTripleScan(results[0], results[1], results[2]);
}

export function finalizeTripleScan(reviewResult: AgentResult, secResult: AgentResult, secretsResult: AgentResult) {
  const hasBlocking = (reviewResult.analysis?.critical_count ?? 0) > 0 || (secResult.analysis?.critical_count ?? 0) > 0 || (secretsResult.analysis?.critical_count ?? 0) > 0;
  const hasWarnings = (reviewResult.analysis?.high_count ?? 0) > 0 || (secResult.analysis?.high_count ?? 0) > 0;
  const verdict = hasBlocking ? 'fail' : hasWarnings ? 'warn' : 'pass';
  recordOutcome('scan', 50, 2, 'reviewer', reviewResult.analysis?.score ?? Math.round(reviewResult.output.confidence * 100));
  recordOutcome('scan', 50, 2, 'security-scanner', secResult.analysis?.score ?? Math.round(secResult.output.confidence * 100));
  recordOutcome('scan', 50, 2, 'secrets', (secretsResult.analysis?.findings?.length ?? 0) === 0 ? 100 : secretsResult.analysis?.score ?? Math.round(secretsResult.output.confidence * 100));
  return { reviewResult, secResult, secretsResult, verdict };
}

/**
 * Runs one worker agent for an evidence-gathering handler (advisors, generators,
 * git helpers) with full two-call support, WITHOUT forcing the handler to change
 * its bespoke output shape.
 *
 *  - Phase 2: if `agentResponse` is supplied (the host reasoned as the agent and
 *    passed its JSON back), that becomes the agent output.
 *  - Phase 1: otherwise MCP Sampling is attempted. On success the LLM result is
 *    returned. If sampling is unavailable/fails, the DETERMINISTIC result is still
 *    returned (so the tool never regresses to "no answer") AND an `llm_upgrade`
 *    offer is attached so the host can complete the loop by calling back with
 *    `agent_response`.
 *
 * `text` is the prose the handler previously extracted inline
 * (`plan.approach ?? analysis.summary ?? output.recommendation`).
 */
export interface HandlerAgentRun {
  result: AgentResult;
  text: string;
  llm_upgrade?: { available: true; instruction: string; prompt: AgenticAgentPrompt };
}

function extractAgentText(r: AgentResult): string {
  return r.plan?.approach ?? r.analysis?.summary ?? r.output?.recommendation ?? '';
}

export async function runHandlerAgent(
  toolName: string,
  task: AgentTask,
  agentResponse?: unknown,
): Promise<HandlerAgentRun> {
  // Phase 2 — host-supplied agent output.
  if (agentResponse && typeof agentResponse === 'object') {
    const r = parseAgenticAgentResponses([{ ...task, llm_backed: true }], { [task.id]: agentResponse })[0];
    return { result: r, text: extractAgentText(r) };
  }

  // Phase 1 — attempt sampling.
  const sampledTask: AgentTask = { ...task, llm_backed: true };
  let sampled: AgentResult;
  try {
    sampled = await executeOne(sampledTask);
  } catch {
    sampled = await executeOne({ ...task, llm_backed: false });
  }
  if (sampled.llm_backed && !sampled.error) {
    return { result: sampled, text: extractAgentText(sampled) };
  }

  // Sampling unavailable/failed — deterministic floor + upgrade offer.
  const needsDeterministic = Boolean(sampled.llm_upgrade) || Boolean(sampled.error) || (!sampled.plan && !sampled.analysis);
  const deterministic = needsDeterministic ? await executeOne({ ...task, llm_backed: false }) : sampled;

  const run: HandlerAgentRun = { result: deterministic, text: extractAgentText(deterministic) };
  const prompt = buildAgenticAgentPrompt(sampledTask);
  if (prompt) {
    run.llm_upgrade = {
      available: true,
      instruction: `MCP Sampling is unavailable on this client. For richer LLM-backed output, reason as the ${task.agent} specialist using the prompt below, then call ${toolName} again with your JSON in the agent_response field.`,
      prompt,
    };
  }
  return run;
}

/** Wraps a handler payload as an MCP text response, attaching the upgrade offer when present. */
export function handlerAgentResponse(payload: Record<string, unknown>, run: HandlerAgentRun) {
  if (run.llm_upgrade) payload.llm_upgrade = run.llm_upgrade;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Handles the 2-phase agentic loop for single worker-agent tools. */
export async function handleAgenticWorker(name: string, args: any, agentType: WorkerAgentType, defaultTask: string) {
  const llmResponse = args?.agent_response;
  const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
  const task: AgentTask = { id: name + '-1', agent: agentType, task: args?.task ? String(args.task) : defaultTask, code: args?.code ? String(args.code) : undefined, context: args?.context ? String(args.context) : undefined, project_dir: projectDir, llm_backed: true };

  if (llmResponse && typeof llmResponse === 'object') {
    const results = parseAgenticAgentResponses([task], { [task.id]: llmResponse });
    const r = results[0];
    const payload = r.analysis || r.plan || r.output;
    return { content: [{ type: 'text', text: JSON.stringify({ mode: 'agentic_fallback', llm_backed: true, ...payload }, null, 2) }] };
  }
  try {
    const result = await executeOne(task);
    if (result.llm_backed && !result.error) {
      const payload = result.analysis || result.plan || result.output;
      return { content: [{ type: 'text', text: JSON.stringify({ mode: 'sampling', llm_backed: true, ...payload }, null, 2) }] };
    }
  } catch { /* fallback */ }

  const prompt = buildAgenticAgentPrompt(task);
  return { content: [{ type: 'text', text: JSON.stringify({ mode: 'agentic_fallback', llm_backed: false, llm_upgrade: { available: true, instruction: `MCP Sampling is unavailable on this client. Reason as the ${agentType} specialist, produce the output yourself, then call this tool again with your JSON in the agent_response field.`, prompt } }, null, 2) }] };
}
