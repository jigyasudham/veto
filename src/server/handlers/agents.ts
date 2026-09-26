// Agent-orchestration tools: single-agent plan (agentic worker), parallel
// multi-agent execution, a compact single-agent delegation, a multi-step
// workflow pipeline, and PRD/task parsing. They drive the executor + agentic
// LLM-runner and record learning outcomes. veto_workflow uses ctx.server for
// the sampling-based HITL callback. Bodies are the verbatim switch handlers.

import { handleAgenticWorker, runHandlerAgent, handlerAgentResponse } from '../scan-core.js';
import { executeParallel, executeOne } from '../../agents/executor.js';
import { buildAgenticAgentPrompt, parseAgenticAgentResponses } from '../../agents/llm-runner.js';
import { recordOutcome } from '../../router/index.js';
import { logUsage, saveTaskPlan } from '../../memory/local.js';
import { buildContextString } from '../../context/reader.js';
import { parsePrdIntoTasks, buildTaskPlan } from '../runtime.js';
import { runPipeline } from '../../workflow/pipeline.js';
import type { PipelineStep } from '../../workflow/pipeline.js';
import type { AgentTask, WorkerAgentType } from '../../agents/types.js';
import type { HandlerMap } from '../registry.js';

export const agentHandlers: HandlerMap = {
  veto_agent_plan: async ({ args }) => {
    const agentType = String(args?.agent ?? '') as any;
    const task = String(args?.task ?? '').trim();
    return await handleAgenticWorker('veto_agent_plan', args, agentType, task);
  },

  veto_execute_parallel: async ({ args }) => {
    const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];
    const llmBacked = args?.llm_backed !== false;
    const agentOutputs = args?.agent_outputs as Record<string, unknown> | undefined;

    if (rawTasks.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'tasks array is required and must not be empty.' }) }], isError: true };
    }
    const parallelProjectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const defaultModel = args?.editor_model ? String(args.editor_model) : args?.architect_model ? String(args.architect_model) : undefined;
    const tasks: AgentTask[] = rawTasks.map((t: Record<string, unknown>) => ({
      id: String(t.id ?? ''),
      agent: String(t.agent ?? '') as WorkerAgentType,
      task: String(t.task ?? ''),
      code: t.code ? String(t.code) : undefined,
      context: t.context ? String(t.context) : undefined,
      project_dir: t.project_dir ? String(t.project_dir) : parallelProjectDir,
      llm_backed: llmBacked,
      model: t.model ? String(t.model) : defaultModel,
    }));

    // Phase 2: Agentic loop
    if (llmBacked && !agentOutputs) {
      const prompts = tasks.map(t => buildAgenticAgentPrompt(t)).filter(Boolean);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mode: 'agentic_loop',
            instruction: 'Reason as each agent below using their provided roles and schemas. Return a JSON object mapping task IDs (or agent names) to agent responses.',
            prompts,
          }, null, 2)
        }]
      };
    }

    const results = (llmBacked && agentOutputs)
      ? parseAgenticAgentResponses(tasks, agentOutputs)
      : await executeParallel(tasks);

    // #40: auto-record learning outcome per completed parallel task
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.error) continue;
      const quality = Math.round(r.output.confidence * 100);
      const tier: 1|2|3 = quality >= 80 ? 1 : quality >= 40 ? 2 : 3;
      recordOutcome(tasks[i]?.task.slice(0, 50) ?? r.agent, 50, tier, r.agent, quality);
    }

    const deterministicFallbacks = results
      .map((r, i) => ({ r, t: tasks[i] }))
      .filter(({ r }) => !r.error && r.llm_backed === false);

    const parallelPayload: Record<string, unknown> = {
      count: results.length,
      total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
      llm_backed_count: results.filter(r => r.llm_backed === true).length,
      results: results.map(r => ({
        id: r.id,
        agent: r.agent,
        duration_ms: r.duration_ms,
        llm_backed: r.llm_backed,
        error: r.error,
        output: { ...(r.plan ?? r.analysis), structured: r.output },
      })),
    };

    if (deterministicFallbacks.length > 0) {
      parallelPayload.llm_upgrade = {
        available: true,
        instruction: 'Some agents ran deterministically (MCP Sampling unavailable or failed). For LLM-backed output, reason as each agent using the prompts below, then pass results back via veto_execute_parallel with pre-filled output.',
        agent_prompts: deterministicFallbacks.map(({ t }) =>
          t ? buildAgenticAgentPrompt(t) : null
        ).filter(Boolean),
      };
    }

    if (typeof args?.max_tokens === 'number') {
      const outputText = JSON.stringify(parallelPayload, null, 2);
      const { exceeded, estimated_tokens } = logUsage({
        tool_name: 'veto_execute_parallel',
        max_tokens: args.max_tokens,
        output: outputText,
      });
      if (exceeded) {
        parallelPayload.budget_warning = `Estimated output tokens (${estimated_tokens}) exceeded max_tokens budget (${args.max_tokens}).`;
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(parallelPayload, null, 2) }],
    };
  },

  veto_delegate: async ({ args }) => {
    const agentId = String(args?.agent_id ?? '').trim() as WorkerAgentType;
    const task    = String(args?.task ?? '').trim();
    const context = args?.context     ? String(args.context)     : undefined;
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const maxLen  = typeof args?.max_summary_tokens === 'number' ? Math.min(args.max_summary_tokens, 2000) : 500;

    if (!agentId || !task) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'agent_id and task are required.' }) }], isError: true };
    }
    const { AGENT_MANIFEST } = await import('../../agents/manifest.js');
    if (!AGENT_MANIFEST.some(a => a.id === agentId)) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Unknown agent "${agentId}".`, agents: AGENT_MANIFEST.map(a => a.id).sort() }, null, 2) }], isError: true };
    }

    // The point of delegating is a short, specific answer that keeps the
    // caller's context clean. Without an LLM this used to return the agent's
    // canned approach paragraph (twice) as if it were the answer.
    const run = await runHandlerAgent('veto_delegate', {
      id: 'delegate-1',
      agent: agentId,
      task,
      context: buildContextString(projectDir, context) || undefined,
      project_dir: projectDir,
      deliverable: {
        description: `Carry out the task as the ${agentId} specialist and report back compactly: the answer first, then only what the caller needs to act on. Stay under ${maxLen} characters in summary.`,
        shape: { summary: '"<the answer, specific to the task>"', key_points: '["<fact or action the caller needs>", ...]', confidence: '<0-100>' },
        required: ['summary'],
      },
    }, args?.agent_response);
    const summary = typeof run.deliverable?.summary === 'string' ? run.deliverable.summary.slice(0, maxLen) : null;
    if (run.deliverable) recordOutcome(task, 50, 2, agentId, typeof run.deliverable.confidence === 'number' ? run.deliverable.confidence : 70);

    return handlerAgentResponse({
      agent: agentId,
      task: task.slice(0, 100),
      summary,
      key_points: run.deliverable?.key_points ?? null,
      confidence: run.deliverable?.confidence ?? null,
      truncated: summary ? typeof run.deliverable?.summary === 'string' && run.deliverable.summary.length > maxLen : null,
    }, run, { generated: ['summary', 'key_points', 'confidence', 'truncated'] });
  },

  veto_workflow: async ({ args, server }) => {
    const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
    if (rawSteps.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'steps array is required and must not be empty.' }) }], isError: true };
    // Reject a malformed step up front. It used to run anyway and fail as
    // 'Unknown agent type: ' with an empty step id.
    const { AGENT_MANIFEST } = await import('../../agents/manifest.js');
    const { getPlugin } = await import('../../plugins/loader.js');
    const known = new Set<string>(AGENT_MANIFEST.map(a => a.id));
    const problems: string[] = [];
    rawSteps.forEach((s: Record<string, unknown>, i: number) => {
      const missing = ['id', 'agent', 'task'].filter(k => typeof s?.[k] !== 'string' || !String(s[k]).trim());
      if (missing.length) problems.push(`step ${i + 1}: missing ${missing.join(', ')}`);
      else if (!known.has(String(s.agent)) && !getPlugin(String(s.agent))) problems.push(`step ${i + 1} (${s.id}): unknown agent "${s.agent}"`);
    });
    if (problems.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Invalid workflow — ${problems.join('; ')}.`, each_step_needs: { id: 'string', agent: 'worker agent id', task: 'string' }, agents: [...known].sort() }, null, 2) }], isError: true };
    }
    const steps: PipelineStep[] = rawSteps.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? ''),
      agent: String(s.agent ?? '') as WorkerAgentType,
      task: String(s.task ?? ''),
      code: s.code ? String(s.code) : undefined,
      context: s.context ? String(s.context) : undefined,
      gate: typeof s.gate === 'number' ? s.gate : undefined,
      retry_on_fail: s.retry_on_fail === true,
      max_retries: typeof s.max_retries === 'number' ? Math.min(s.max_retries, 5) : undefined,
      condition: s.condition ? String(s.condition) : undefined,
      dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : undefined,
    }));
    const mode = String(args?.mode ?? 'linear') === 'dag' ? 'dag' : 'linear';
    const result = await runPipeline(
      steps,
      args?.project_dir ? String(args.project_dir) : undefined,
      mode,
      async (question: string) => {
        try {
          const resp = await server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: question } }], maxTokens: 200 } as any);
          return resp.content.type === 'text' ? resp.content.text : '';
        } catch {
          return ''; // sampling not supported by client
        }
      }
    );

    // #39: auto-record learning outcome per executed workflow step
    for (const step of result.results) {
      if (step.status === 'skipped') continue;
      const quality = step.error ? 0 : step.confidence;
      const tier: 1|2|3 = quality >= 80 ? 1 : quality >= 40 ? 2 : 3;
      const taskStr = steps.find(s => s.id === step.id)?.task.slice(0, 50) ?? step.id;
      recordOutcome(taskStr, 50, tier, step.agent, quality);
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  veto_task_parse: async ({ args }) => {
    const description = String(args?.description ?? '').trim();
    const project_dir = args?.project_dir ? String(args.project_dir) : undefined;
    const max_tasks = typeof args?.max_tasks === 'number' ? Math.min(args.max_tasks, 50) : 20;
    if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };

    // The request's own clauses, routed by their words — a real answer on its own.
    const { splitTask, agentFor } = await import('../task-split.js');
    const split = splitTask(description, max_tasks);
    const { AGENT_MANIFEST } = await import('../../agents/manifest.js');
    const known = new Set<string>(AGENT_MANIFEST.map(a => a.id));

    const run = await runHandlerAgent('veto_task_parse', {
      id: 'planner',
      agent: 'task-planner',
      task: 'Break this request into tasks.',
      code: description,
      context: [buildContextString(project_dir), `A first split by clause (refine it):\n${split.map(t => `${t.id} [${t.agent}] ${t.task}`).join('\n')}`].filter(Boolean).join('\n\n'),
      project_dir,
      deliverable: {
        description: `Break the request in the material into concrete, independently checkable tasks (at most ${max_tasks}). Assign each to one Veto worker agent: ${[...known].sort().join(', ')}. Dependencies list the ids a task needs finished first.`,
        shape: { tasks: '[{ "id": "task-1", "agent": "<agent id from the list>", "task": "...", "dependencies": ["task-…"] }, ...]' },
        required: ['tasks'],
      },
    }, args?.agent_response ?? args?.agent_responses?.planner);
    if (run.error) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: run.error }, null, 2) }], isError: true };

    // LLM tasks are checked before they are stored (AGENTS.md: validate before any write).
    let tasks = split;
    let source: 'llm' | 'clause_split' = 'clause_split';
    if (Array.isArray(run.deliverable?.tasks)) {
      const raw = (run.deliverable!.tasks as Array<Record<string, unknown>>).filter(t => t && typeof t.task === 'string' && t.task.trim()).slice(0, max_tasks);
      const ids = new Set(raw.map((t, i) => String(t.id ?? `task-${i + 1}`)));
      if (raw.length) {
        tasks = raw.map((t, i) => {
          const task = String(t.task).trim();
          const agent = typeof t.agent === 'string' && known.has(t.agent) ? t.agent : agentFor(task);
          const deps = Array.isArray(t.dependencies) ? t.dependencies.map(String).filter(d => ids.has(d)) : [];
          return { id: String(t.id ?? `task-${i + 1}`), agent, task, dependencies: deps };
        });
        source = 'llm';
      }
    }
    if (source === 'llm') saveTaskPlan(description, JSON.stringify({ description, tasks }));

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      description,
      source,
      tasks,
      generated_by: run.generated_by,
      ...(run.llm_upgrade ? { llm_upgrade: run.llm_upgrade } : {}),
    }, null, 2) }] };
  },
};
