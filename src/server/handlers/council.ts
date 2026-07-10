// Council/debate-driven tools: the 7-agent governance debate (deterministic with
// an agentic LLM-upgrade path), an A/B approach benchmark that runs two debates,
// and the new_feature pipeline (govern -> plan -> tasks). All use the LLM council
// and ctx.server for MCP sampling. Bodies are the verbatim switch handlers.

import { runLlmDebate, parseAgentResponses, runFromAgentResponses, buildAgenticDebatePrompt } from '../../council/llm-council.js';
import { parseAgenticAgentResponses } from '../../agents/llm-runner.js';
import { executeOne } from '../../agents/executor.js';
import { recordOutcome } from '../../router/index.js';
import { saveCouncilOutcome, storeKnowledge, logUsage } from '../../memory/local.js';
import { buildContextString } from '../../context/reader.js';
import { parsePrdIntoTasks, getActiveProjectDir } from '../runtime.js';
import type { HandlerMap } from '../registry.js';

export const councilHandlers: HandlerMap = {
  veto_council_debate: async ({ args, server }) => {
    const task = String(args?.task ?? '').trim();
    if (!task) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task is required.' }) }],
        isError: true,
      };
    }

    const strictnessArg = (['fast', 'standard', 'strict'].includes(String(args?.strictness ?? '')))
      ? String(args!.strictness) as 'fast' | 'standard' | 'strict'
      : 'standard';
    const debateInput = {
      task,
      context: args?.context ? String(args.context) : undefined,
      // Fall back to the active project (set by the session/handoff tools) so a debate
      // is scoped even when the caller omits project_dir — otherwise the outcome is
      // stored unscoped and the HUD/statusline can't attribute it to a workspace.
      project_dir: args?.project_dir ? String(args.project_dir) : (getActiveProjectDir() ?? undefined),
      strictness: strictnessArg,
      architect_model: args?.architect_model ? String(args.architect_model) : undefined,
      editor_model: args?.editor_model ? String(args.editor_model) : undefined,
    };

    // Phase 2: agent_responses provided — run verdict engine on LLM-generated votes
    const rawAgentResponses = args?.agent_responses;
    if (rawAgentResponses && typeof rawAgentResponses === 'object') {
      const parsed = parseAgentResponses(JSON.stringify(rawAgentResponses), task);
      if (parsed) {
        const debateStart = Date.now();
        const result = runFromAgentResponses(debateInput, parsed);
        const debateDuration = Date.now() - debateStart;
        const sessionId = args?.session_id ? String(args.session_id) : undefined;
        const outcomeId = saveCouncilOutcome({
          session_id: sessionId, task, verdict: result.final_verdict,
          lead_dev: JSON.stringify(result.votes.lead_dev), pm: JSON.stringify(result.votes.pm),
          architect: JSON.stringify(result.votes.architect), ux: JSON.stringify(result.votes.ux),
          devil: JSON.stringify(result.votes.devil), legal: JSON.stringify(result.votes.legal),
          security: JSON.stringify(result.votes.security), recommended: result.recommended,
          duration_ms: debateDuration,
          project_dir: debateInput.project_dir,
        });
        const payload = { outcome_id: outcomeId, llm_backed: true, final_verdict: result.final_verdict, block_reasons: result.block_reasons, warnings: result.warnings, recommended: result.recommended, debated_at: result.debated_at, votes: result.votes };
        return { content: [{ type: 'text', text: result.formatted_output + '\n\n' + JSON.stringify(payload, null, 2) }] };
      }
    }

    // Phase 1: run deterministic debate + attach llm_upgrade prompt for host AI
    const debateStart = Date.now();
    const result = await runLlmDebate(server, debateInput);
    const debateDuration = Date.now() - debateStart;

    const sessionId = args?.session_id ? String(args.session_id) : undefined;
    const outcomeId = saveCouncilOutcome({
      session_id: sessionId,
      task,
      verdict: result.final_verdict,
      lead_dev: JSON.stringify(result.votes.lead_dev),
      pm: JSON.stringify(result.votes.pm),
      architect: JSON.stringify(result.votes.architect),
      ux: JSON.stringify(result.votes.ux),
      devil: JSON.stringify(result.votes.devil),
      legal: JSON.stringify(result.votes.legal),
      security: JSON.stringify(result.votes.security),
      recommended: result.recommended,
      duration_ms: debateDuration,
      project_dir: debateInput.project_dir,
    });

    // #38: auto-record learning outcome from verdict — no manual veto_record_outcome needed
    {
      const qMap: Record<string, number> = { GREEN: 90, YELLOW: 60, RED: 20, DEADLOCK: 50 };
      const tMap: Record<string, 1|2|3> = { GREEN: 1, YELLOW: 2, RED: 3, DEADLOCK: 2 };
      recordOutcome(task.slice(0, 50), 50, tMap[result.final_verdict] ?? 2, 'council', qMap[result.final_verdict] ?? 50);
    }

    // Auto-store RED verdicts so they appear in the Memory panel immediately
    if (result.final_verdict === 'RED' || (result.final_verdict === 'YELLOW' && (result.warnings.length >= 2 || result.block_reasons.length > 0))) {
      const isRed = result.final_verdict === 'RED';
      const lines: string[] = [`Task: ${task}`];
      if (result.block_reasons.length > 0) lines.push(`\nBlocked by:\n${result.block_reasons.map(r => `- ${r}`).join('\n')}`);
      if (result.warnings.length > 0) lines.push(`\nWarnings:\n${result.warnings.map(w => `- ${w}`).join('\n')}`);

      // Include per-agent reasoning so future debates inherit the full context
      const agentSummary = Object.entries(result.votes)
        .filter(([, v]) => v.verdict !== 'approve')
        .map(([name, v]) => `- ${name} [${v.verdict}]: ${v.reason}`)
        .join('\n');
      if (agentSummary) lines.push(`\nAgent reasoning:\n${agentSummary}`);

      if (result.recommended) lines.push(`\nRecommended: ${result.recommended}`);
      storeKnowledge({
        type: 'decision',
        title: `${result.final_verdict}: ${task.slice(0, 80)}`,
        content: lines.join(''),
        tags: [isRed ? 'red-verdict' : 'yellow-verdict', isRed ? 'blocked' : 'caution', 'council'],
        project_dir: debateInput.project_dir,
        session_id: sessionId,
        relevance: isRed ? 1.0 : 0.8,
      });
    }

    // Build agentic upgrade prompt so host AI can provide real LLM reasoning on any platform
    const enrichedCtx = buildContextString(debateInput.project_dir, debateInput.context);
    const { optionA, optionB, isDecisionTask } = (await import('../../council/decision-extractor.js')).extractDecision(task);
    const decisionCtx = isDecisionTask ? `Option A: "${optionA}" vs Option B: "${optionB}"` : undefined;
    const agenticPrompt = buildAgenticDebatePrompt(task, enrichedCtx, decisionCtx);

    const responsePayload = {
      outcome_id: outcomeId,
      llm_backed: false,
      final_verdict: result.final_verdict,
      block_reasons: result.block_reasons,
      warnings: result.warnings,
      recommended: result.recommended,
      debated_at: result.debated_at,
      votes: {
        lead_dev:  result.votes.lead_dev,
        pm:        result.votes.pm,
        architect: result.votes.architect,
        ux:        result.votes.ux,
        devil:     result.votes.devil,
        legal:     result.votes.legal,
        security:  result.votes.security,
      },
      llm_upgrade: {
        available: true,
        instruction: 'The verdict above is deterministic. For LLM-backed analysis: (1) read debate_prompt and reason as all 7 agents, generating the agent_responses JSON; (2) call veto_council_debate again with { task, agent_responses } to get the final LLM-backed verdict. Works on Claude Code, Gemini CLI, and Codex CLI with no API keys.',
        debate_prompt: agenticPrompt,
      },
    } as Record<string, unknown>;

    const fullText = result.formatted_output + '\n\n' + JSON.stringify(responsePayload, null, 2);

    if (typeof args?.max_tokens === 'number') {
      const { exceeded, estimated_tokens } = logUsage({
        tool_name: 'veto_council_debate',
        session_id: sessionId,
        max_tokens: args.max_tokens,
        output: fullText,
      });
      if (exceeded) {
        responsePayload.budget_warning = `Estimated output tokens (${estimated_tokens}) exceeded max_tokens budget (${args.max_tokens}).`;
      }
    }

    return {
      content: [{ type: 'text', text: fullText }],
    };
  },

  veto_benchmark: async ({ args, server }) => {
    const task       = String(args?.task       ?? '');
    const approachA  = String(args?.approach_a ?? '');
    const approachB  = String(args?.approach_b ?? '');
    const ctx        = args?.context    ? String(args.context)    : undefined;
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;

    if (!task || !approachA || !approachB) {
      throw new Error('veto_benchmark requires task, approach_a, and approach_b');
    }

    const bmStart = Date.now();

    // Run both debates in parallel via LLM council
    const [debateA, debateB] = await Promise.all([
      runLlmDebate(server, { task: `${task}\n\nApproach A: ${approachA}`, context: ctx, project_dir: projectDir }),
      runLlmDebate(server, { task: `${task}\n\nApproach B: ${approachB}`, context: ctx, project_dir: projectDir }),
    ]);

    // Score: GREEN=3, YELLOW=2, RED=1, DEADLOCK=0
    const verdictScore: Record<string, number> = { GREEN: 3, YELLOW: 2, RED: 1, DEADLOCK: 0 };
    const scoreA = verdictScore[debateA.final_verdict] ?? 0;
    const scoreB = verdictScore[debateB.final_verdict] ?? 0;

    const warnCountA = debateA.warnings.length;
    const warnCountB = debateB.warnings.length;
    const blockCountA = debateA.block_reasons.length;
    const blockCountB = debateB.block_reasons.length;

    let winner: 'A' | 'B' | 'TIE';
    let confidence: 'high' | 'medium' | 'low';
    let reasoning: string;

    if (scoreA !== scoreB) {
      winner = scoreA > scoreB ? 'A' : 'B';
      const diff = Math.abs(scoreA - scoreB);
      confidence = diff >= 2 ? 'high' : 'medium';
      reasoning = `Approach ${winner} received a ${winner === 'A' ? debateA.final_verdict : debateB.final_verdict} verdict vs ${winner === 'A' ? debateB.final_verdict : debateA.final_verdict} for Approach ${winner === 'A' ? 'B' : 'A'}.`;
    } else {
      // Same verdict — break tie on warnings, then block reasons
      if (warnCountA !== warnCountB) {
        winner = warnCountA < warnCountB ? 'A' : 'B';
        confidence = 'low';
        reasoning = `Both approaches received ${debateA.final_verdict}. Approach ${winner} had fewer warnings (${winner === 'A' ? warnCountA : warnCountB} vs ${winner === 'A' ? warnCountB : warnCountA}).`;
      } else if (blockCountA !== blockCountB) {
        winner = blockCountA < blockCountB ? 'A' : 'B';
        confidence = 'low';
        reasoning = `Both approaches received ${debateA.final_verdict} with equal warnings. Approach ${winner} had fewer blocking concerns.`;
      } else {
        winner = 'TIE';
        confidence = 'low';
        reasoning = `Both approaches received ${debateA.final_verdict} with equal warnings and blocks. Council cannot differentiate — consider a more specific framing.`;
      }
    }

    // Auto-record both debates
    const qMap: Record<string, number> = { GREEN: 90, YELLOW: 60, RED: 20, DEADLOCK: 50 };
    recordOutcome('benchmark', 50, 2, 'council', qMap[debateA.final_verdict] ?? 50);
    recordOutcome('benchmark', 50, 2, 'council', qMap[debateB.final_verdict] ?? 50);

    return { content: [{ type: 'text', text: JSON.stringify({
      winner,
      confidence,
      reasoning,
      recommendation: winner !== 'TIE'
        ? `Use Approach ${winner}. ${winner === 'A' ? debateA.recommended : debateB.recommended}`
        : `No clear winner. ${debateA.recommended}`,
      approach_a: {
        label: 'A',
        description: approachA.slice(0, 120),
        verdict: debateA.final_verdict,
        warnings: warnCountA,
        block_reasons: blockCountA,
        recommended: debateA.recommended,
        votes: Object.fromEntries(Object.entries(debateA.votes).map(([k, v]) => [k, v.verdict])),
      },
      approach_b: {
        label: 'B',
        description: approachB.slice(0, 120),
        verdict: debateB.final_verdict,
        warnings: warnCountB,
        block_reasons: blockCountB,
        recommended: debateB.recommended,
        votes: Object.fromEntries(Object.entries(debateB.votes).map(([k, v]) => [k, v.verdict])),
      },
      duration_ms: Date.now() - bmStart,
    }, null, 2) }] };
  },

  veto_new_feature: async ({ args, server }) => {
    const description = String(args?.description ?? '').trim();
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const userContext = args?.context ? String(args.context) : undefined;
    const agentResponses = args?.agent_responses as any;

    if (!description) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'description is required.' }) }], isError: true };

    // Step 1: Governance
    const debateInput = { task: description, context: userContext, project_dir: projectDir, strictness: 'standard' as const };
    let debateResult;
    if (agentResponses?.council) {
       debateResult = runFromAgentResponses(debateInput, parseAgentResponses(JSON.stringify(agentResponses.council), description)!);
    } else {
       debateResult = await runLlmDebate(server, debateInput);
    }

    if (debateResult.final_verdict === 'RED') {
      return { content: [{ type: 'text', text: JSON.stringify({ pipeline: 'new_feature', verdict: 'blocked', council: debateResult }, null, 2) }] };
    }

    // Step 2: Planning
    let planResult;
    if (agentResponses?.planner) {
       planResult = parseAgenticAgentResponses([{ id: 'planner', agent: 'task-planner', task: description }], { planner: agentResponses.planner })[0];
    } else {
       planResult = await executeOne({ id: 'planner', agent: 'task-planner', task: description, project_dir: projectDir, llm_backed: true });
    }

    if (planResult.llm_upgrade || (debateResult as any).llm_upgrade) {
       return {
         content: [{
           type: 'text',
           text: JSON.stringify({
             llm_backed: false,
             llm_upgrade: {
               council: (debateResult as any).llm_upgrade,
               planner: planResult.llm_upgrade,
             }
           }, null, 2)
         }]
       };
    }

    // Step 3: Tasks
    const tasks = parsePrdIntoTasks(description, planResult.plan!, 10);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, pipeline: 'new_feature', council: debateResult, plan: planResult.plan, tasks }, null, 2) }] };
  },
};
