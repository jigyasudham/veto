// Agent-orchestration tools: single-agent plan (agentic worker), parallel
// multi-agent execution, a compact single-agent delegation, a multi-step
// workflow pipeline, and PRD/task parsing. They drive the executor + agentic
// LLM-runner and record learning outcomes. veto_workflow uses ctx.server for
// the sampling-based HITL callback. Bodies are the verbatim switch handlers.

import { handleAgenticWorker } from '../scan-core.js';
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

    const enrichedCtx = buildContextString(projectDir, context);
    const result = await executeOne({ id: 'delegate-1', agent: agentId, task, context: enrichedCtx || undefined, project_dir: projectDir });

    recordOutcome(task, 50, 2, agentId, Math.round(result.output.confidence * 100));

    // Return compact summary only — no verbose findings/steps to avoid context pollution
    const summary = [
      result.output.recommendation,
      result.plan?.approach,
      result.analysis?.verdict ? `Verdict: ${result.analysis.verdict}` : null,
      result.analysis?.score   ? `Score: ${result.analysis.score}/100`  : null,
    ].filter(Boolean).join('\n').slice(0, maxLen);

    return { content: [{ type: 'text', text: JSON.stringify({
      agent: agentId,
      task: task.slice(0, 100),
      summary,
      confidence: Math.round(result.output.confidence * 100),
      severity: result.output.severity ?? null,
      duration_ms: result.duration_ms,
      truncated: summary.length >= maxLen,
    }, null, 2) }] };
  },

  veto_workflow: async ({ args, server }) => {
    const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
    if (rawSteps.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'steps array is required and must not be empty.' }) }], isError: true };
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

    const agentResponse = args?.agent_responses?.planner;
    if (agentResponse) {
       const results = parseAgenticAgentResponses([{ id: 'planner', agent: 'task-planner', task: description }], { planner: agentResponse });
       const r = results[0];
       if (r.plan) {
          const plan = parsePrdIntoTasks(description, r.plan, max_tasks);
          saveTaskPlan(description, JSON.stringify(plan));
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
       }
    }

    // Try sampling
    try {
      const result = await executeOne({ id: 'planner', agent: 'task-planner', task: description, project_dir, llm_backed: true });
      if (result.llm_backed && result.plan && !result.error) {
         const plan = parsePrdIntoTasks(description, result.plan, max_tasks);
         saveTaskPlan(description, JSON.stringify(plan));
         return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
      }
      if (result.llm_upgrade) {
         return { content: [{ type: 'text', text: JSON.stringify({ llm_backed: false, llm_upgrade: result.llm_upgrade }, null, 2) }] };
      }
    } catch { /* fallback */ }

    const plan = await buildTaskPlan(description, project_dir, max_tasks);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...plan }, null, 2) }] };
  },
};
