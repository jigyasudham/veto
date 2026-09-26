// Reusable handler logic shared across the review / agentic-worker MCP tools.
//
// Extracted from server.ts so it can be unit-tested: server.ts connects stdio at
// import time, so anything defined there is untestable. These helpers depend only
// on the agent layer and the router — no server-local state — so they live here.

import { execSync as execSyncTop } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { buildContextString } from '../context/reader.js';
import type { AgentTask, AgentResult, AgenticAgentPrompt, Deliverable, WorkerAgentType } from '../agents/types.js';
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
  const run = (cmd: string) => execSyncTop(cmd, { windowsHide: true, cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
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
    // No sampling: the deterministic scanners still run, their findings are
    // returned as real results, and each agent is shown what its scanner found.
    // Before 3.7.0 this path returned prompts only — if the host never did the
    // second call, nothing had been scanned at all.
    const deterministic = await Promise.all(tasks.map(t => executeOne({ ...t, llm_backed: false })));
    const seeded = tasks.map((t, i) => {
      const found = deterministic[i].analysis?.findings ?? [];
      if (!found.length) return t;
      const note = `Veto's deterministic scan already found (confirm, extend, or reject each):\n${found.slice(0, 20).map(f => `- [${f.severity}] ${f.description}${f.location ? ` (${f.location})` : ''}`).join('\n')}`;
      return { ...t, context: [t.context, note].filter(Boolean).join('\n\n') };
    });
    const prompts = seeded.map(t => buildAgenticAgentPrompt(t)).filter((p): p is AgenticAgentPrompt => p !== null);
    const floor = finalizeTripleScanFacts(deterministic[0], deterministic[1], deterministic[2]);
    return {
      mode: 'agentic_loop' as const,
      instruction: 'Reason as each agent below using their provided roles and schemas. Return a JSON object mapping task IDs to agent responses. deterministic_scan already holds what Veto\'s own scanners found.',
      deterministic_scan: floor,
      prompts,
    };
  }
  const results = (llm_backed && agent_outputs) ? parseAgenticAgentResponses(tasks, agent_outputs) : await Promise.all(tasks.map(t => executeOne(t)));
  return finalizeTripleScan(results[0], results[1], results[2]);
}

/** The deterministic scanners' results, summarised without recording router outcomes. */
function finalizeTripleScanFacts(reviewResult: AgentResult, secResult: AgentResult, secretsResult: AgentResult) {
  const crit = [reviewResult, secResult, secretsResult].reduce((n, r) => n + (r.analysis?.critical_count ?? 0), 0);
  const high = [reviewResult, secResult].reduce((n, r) => n + (r.analysis?.high_count ?? 0), 0);
  return {
    verdict: crit > 0 ? 'fail' : high > 0 ? 'warn' : 'pass',
    note: 'From regex/heuristic scanners only; the LLM pass can add or reject findings.',
    reviewer: reviewResult.analysis?.findings ?? [],
    security: secResult.analysis?.findings ?? [],
    secrets: secretsResult.analysis?.findings ?? [],
  };
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
  /** The checked deliverable, when the task asked for one and an LLM produced it. */
  deliverable: Record<string, unknown> | null;
  /** Where the generated part came from. 'none' = no LLM ran; only facts are real. */
  generated_by: 'sampling' | 'agent_response' | 'none';
  /** Set when a Phase-2 answer did not match what was asked (AGENTS.md rule 5). */
  error?: string;
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
    return { result: r, text: extractAgentText(r), deliverable: r.deliverable ?? null, generated_by: r.error ? 'none' : 'agent_response', error: r.error };
  }

  // Phase 1 — attempt sampling.
  const sampledTask: AgentTask = { ...task, llm_backed: true };
  let sampled: AgentResult;
  try {
    sampled = await executeOne(sampledTask);
  } catch {
    sampled = await executeOne({ ...task, llm_backed: false });
  }
  if (sampled.llm_backed && !sampled.error && (!task.deliverable || sampled.deliverable)) {
    return { result: sampled, text: extractAgentText(sampled), deliverable: sampled.deliverable ?? null, generated_by: 'sampling' };
  }

  // Sampling unavailable/failed. The deterministic agent still runs, but for a
  // generator its plan text is NOT the artifact — handlerAgentResponse keeps it
  // out of the generated fields. The upgrade offer lets the host finish the job.
  const deterministic = await executeOne({ ...task, llm_backed: false });
  const run: HandlerAgentRun = { result: deterministic, text: extractAgentText(deterministic), deliverable: null, generated_by: 'none' };
  const prompt = buildAgenticAgentPrompt(sampledTask);
  if (prompt) {
    run.llm_upgrade = {
      available: true,
      instruction: `MCP Sampling is unavailable on this client, so the generated fields are empty. Produce them: reason as the ${task.agent} specialist using the prompt below, then call ${toolName} again with the same arguments plus your JSON in the agent_response field.`,
      prompt,
    };
  }
  return run;
}

/**
 * Wraps a handler payload as an MCP text response.
 *
 * `generated` names the payload fields an LLM has to write. When no LLM ran,
 * those fields are set to null and the payload says so — before 3.7.0 they were
 * filled with whatever the deterministic fallback said, which is how
 * veto_diagram returned `"mermaid": "Documentation looks complete."`. Every
 * other field is a fact the handler computed and is returned as is.
 *
 * A Phase-2 answer of the wrong shape is a visible error, never an empty result.
 */
export function handlerAgentResponse(payload: Record<string, unknown>, run: HandlerAgentRun, options: { generated?: string[] } = {}) {
  if (run.error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: run.error, ...(run.llm_upgrade ? { llm_upgrade: run.llm_upgrade } : {}) }, null, 2) }],
      isError: true,
    };
  }
  const generated = options.generated ?? [];
  if (run.generated_by === 'none' && generated.length) {
    for (const key of generated) payload[key] = null;
    payload.generation = 'needs_llm';
    payload.generation_note = `Not generated yet: ${generated.join(', ')}. The other fields are computed facts. Use llm_upgrade to produce the rest.`;
  } else if (generated.length) {
    payload.generation = 'complete';
  }
  payload.generated_by = run.generated_by;
  if (run.llm_upgrade) payload.llm_upgrade = run.llm_upgrade;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

// ─── Single worker-agent tools ───────────────────────────────────────────────

/** Arguments that are plumbing, not material for the agent. */
const WORKER_META_ARGS = new Set(['agent_response', 'task', 'code', 'context', 'project_dir', 'file_path', 'spec_file']);
const MAX_FILE_BYTES = 60_000;

export type WorkerSpec = {
  /** Read this argument as the material when no `code` is given (e.g. secrets_scan's `text`). */
  textArg?: string;
  /** Arguments naming a file whose content is the material. */
  fileArgs?: string[];
  /** The artifact this tool returns, when it is not a plan or an analysis. */
  deliverable?: Deliverable;
  /** Deterministic evidence gathered before any LLM (search hits, metrics). Returned as facts and shown to the LLM. */
  gather?: (args: Record<string, unknown>, projectDir: string | undefined) => Promise<{ facts: Record<string, unknown>; context?: string } | { error: string }>;
};

function resolveInput(path: string, projectDir?: string): string {
  return isAbsolute(path) || !projectDir ? resolvePath(path) : resolvePath(projectDir, path);
}

/** Handles the 2-phase agentic loop for single worker-agent tools. */
export async function handleAgenticWorker(name: string, args: any, agentType: WorkerAgentType, defaultTask: string, spec: WorkerSpec = {}) {
  args = args ?? {};
  const llmResponse = args.agent_response;
  const projectDir = args.project_dir ? String(args.project_dir) : undefined;
  const errorResult = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ success: false, message }, null, 2) }], isError: true });

  // The material: code, the tool's text argument, or a file it names.
  let code: string | undefined = args.code ? String(args.code) : undefined;
  if (!code && spec.textArg && args[spec.textArg]) code = String(args[spec.textArg]);
  let source: string | null = null;
  for (const key of spec.fileArgs ?? []) {
    if (code || !args[key]) continue;
    const path = resolveInput(String(args[key]), projectDir);
    try {
      const st = statSync(path);
      if (!st.isFile()) return errorResult(`${key} is not a file: ${path}`);
      code = readFileSync(path, 'utf8').slice(0, MAX_FILE_BYTES);
      source = path;
      if (st.size > MAX_FILE_BYTES) source += ` (first ${MAX_FILE_BYTES} bytes of ${st.size})`;
    } catch {
      return errorResult(`${key} not found: ${path}`);
    }
  }

  // Every other argument the caller gave reaches the agent — before 3.7.0 only
  // task/code/context did, so target_langs, query, url, tool, target and more
  // were silently dropped.
  const extra = Object.entries(args)
    .filter(([k, v]) => !WORKER_META_ARGS.has(k) && k !== spec.textArg && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 2000));

  let facts: Record<string, unknown> = {};
  const contextParts: string[] = [];
  if (spec.gather) {
    const gathered = await spec.gather(args, projectDir);
    if ('error' in gathered) return errorResult(gathered.error);
    facts = gathered.facts;
    if (gathered.context) contextParts.push(gathered.context);
  }
  if (source) contextParts.push(`File: ${source}`);
  if (extra.length) contextParts.push(`Inputs:\n${extra.join('\n')}`);
  if (args.context) contextParts.push(String(args.context));
  const context = buildContextString(projectDir, contextParts.join('\n\n') || undefined) || undefined;

  const task: AgentTask = {
    id: name + '-1', agent: agentType,
    task: args.task ? String(args.task) : defaultTask,
    code, context, project_dir: projectDir, llm_backed: true,
    ...(spec.deliverable ? { deliverable: spec.deliverable } : {}),
  };

  // Deterministic pass first, for agents that have one (AGENTS.md: "run the
  // existing regex pass first, pass findings as context to the LLM"). Its
  // findings are real results on their own, with or without an LLM.
  let deterministic: AgentResult['analysis'] | undefined;
  if (code !== undefined && !spec.deliverable) {
    const det = await executeOne({ ...task, llm_backed: false });
    if (det.analysis) {
      deterministic = det.analysis;
      if (det.analysis.findings.length) {
        task.context = [task.context, `Veto's deterministic scan already found (confirm, extend, or reject each):\n${det.analysis.findings.slice(0, 20).map(f => `- [${f.severity}] ${f.description}${f.location ? ` (${f.location})` : ''}`).join('\n')}`].filter(Boolean).join('\n\n');
      }
    }
  }
  const base = { ...(Object.keys(facts).length ? { facts } : {}), ...(deterministic ? { deterministic_findings: deterministic } : {}) };

  if (llmResponse && typeof llmResponse === 'object') {
    const r = parseAgenticAgentResponses([task], { [task.id]: llmResponse })[0];
    if (r.error) return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: r.error }, null, 2) }], isError: true };
    const payload = r.deliverable ?? r.analysis ?? r.plan ?? r.output;
    return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'agentic_fallback', llm_backed: true, generation: 'complete', ...base, ...payload }, null, 2) }] };
  }
  try {
    const result = await executeOne(task);
    if (result.llm_backed && !result.error && (!spec.deliverable || result.deliverable)) {
      const payload = result.deliverable ?? result.analysis ?? result.plan ?? result.output;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'sampling', llm_backed: true, generation: 'complete', ...base, ...payload }, null, 2) }] };
    }
  } catch { /* fallback */ }

  const prompt = buildAgenticAgentPrompt(task);
  return { content: [{ type: 'text' as const, text: JSON.stringify({
    mode: 'agentic_fallback',
    llm_backed: false,
    generation: deterministic ? 'deterministic_only' : 'needs_llm',
    ...base,
    llm_upgrade: { available: true, instruction: `MCP Sampling is unavailable on this client. Reason as the ${agentType} specialist, produce the output yourself, then call this tool again with the same arguments plus your JSON in the agent_response field.`, prompt },
  }, null, 2) }] };
}
