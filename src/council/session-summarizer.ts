// LLM-backed session summarizer — uses MCP Sampling with full conversation context
// to generate a structured, accurate session checkpoint without the calling AI
// having to manually write summary/context/task_state.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface GeneratedSession {
  summary: string;
  context: string;
  task_state: string;
  auto_summarized: true;
}

const SYSTEM_PROMPT = `You are a session archivist for a software development AI assistant.
Your job: read the conversation above and produce a precise, compact session checkpoint
that lets a DIFFERENT AI resume this exact work in a new session — without re-reading any source files.

Return ONLY valid JSON with exactly this shape (no markdown, no prose):
{
  "summary": "one sentence: what was accomplished or attempted",
  "phase": "planning|implementing|reviewing|blocked|complete",
  "context": {
    "task": "original task description verbatim",
    "decisions": [
      { "decision": "what was decided", "rationale": "why" }
    ],
    "findings": [
      "specific file path + what matters about it (e.g. src/server.ts:302 — veto_session_save handler, add validation here)"
    ]
  },
  "task_state": {
    "completed": ["list of finished subtasks, specific"],
    "inProgress": ["current subtask being worked on"],
    "remaining": ["subtasks still to do"],
    "blockers": ["anything requiring human input before continuing"],
    "nextAction": "concrete, file-specific instruction: e.g. Edit src/server.ts line 302 — add zod .max(2000) on summary field"
  }
}

Rules:
- nextAction MUST be actionable without opening any file — include filename, line number, and exact change
- findings MUST name specific files and what is relevant about them, not generic descriptions
- Keep total JSON under 1500 tokens
- Do not include large code blocks — reference file+line instead`;

function buildUserMessage(hints: { summary?: string; context?: string; task_state?: string }): string {
  const parts: string[] = [
    'The conversation context above is the full work session to checkpoint.',
    'Extract a session save from it. Focus on: which specific files were touched (with line numbers), what decisions were made and why, and make nextAction a concrete file+line instruction.',
  ];

  if (hints.summary) parts.push(`\nHint from calling AI (summary): ${hints.summary}`);
  if (hints.context) parts.push(`\nHint from calling AI (context): ${hints.context}`);
  if (hints.task_state) parts.push(`\nHint from calling AI (task_state): ${hints.task_state}`);
  if (hints.summary || hints.context || hints.task_state) {
    parts.push('\nUse these hints as supplementary input. The conversation is the primary source — improve on the hints where the conversation provides more detail.');
  }

  return parts.join('\n');
}

function parseGeneratedSession(raw: string): { summary: string; context: string; task_state: string } | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    if (typeof parsed.summary !== 'string') return null;

    const summary = String(parsed.summary).slice(0, 2000);
    const context = JSON.stringify({
      task: parsed.context?.task ?? '',
      phase: parsed.phase ?? 'implementing',
      decisions: Array.isArray(parsed.context?.decisions) ? parsed.context.decisions : [],
      findings: Array.isArray(parsed.context?.findings) ? parsed.context.findings : [],
    }).slice(0, 50_000);
    const task_state = JSON.stringify({
      completed: Array.isArray(parsed.task_state?.completed) ? parsed.task_state.completed : [],
      inProgress: Array.isArray(parsed.task_state?.inProgress) ? parsed.task_state.inProgress : [],
      remaining: Array.isArray(parsed.task_state?.remaining) ? parsed.task_state.remaining : [],
      blockers: Array.isArray(parsed.task_state?.blockers) ? parsed.task_state.blockers : [],
      nextAction: typeof parsed.task_state?.nextAction === 'string' ? parsed.task_state.nextAction : '',
    }).slice(0, 20_000);

    return { summary, context, task_state };
  } catch {
    return null;
  }
}

export interface AgenticSummarizePrompt {
  mode: 'agentic';
  instruction: string;
  summarize_prompt: string;
  template: {
    auto_summarize: false;
    summary: string;
    context: string;
    task_state: string;
  };
}

const AGENTIC_TEMPLATE = {
  auto_summarize: false as const,
  summary: '<one sentence: what was accomplished or is in progress>',
  context: JSON.stringify({
    task: '<original task description verbatim>',
    decisions: [{ decision: '<what was decided>', rationale: '<why>' }],
    findings: ['<src/file.ts:N — what matters about this file>'],
  }),
  task_state: JSON.stringify({
    completed: ['<finished subtask>'],
    inProgress: ['<current subtask>'],
    remaining: ['<subtask still to do>'],
    blockers: [],
    nextAction: '<concrete file+line instruction: Edit src/X.ts line N — do Y>',
  }),
};

export function buildAgenticSummarizePrompt(): AgenticSummarizePrompt {
  return {
    mode: 'agentic',
    instruction: 'MCP Sampling is unavailable on this platform. Generate the session summary yourself from the conversation above, then call veto_session_save again with the filled-in fields. Use the template below — replace every <placeholder> with real content from the conversation.',
    summarize_prompt: `Review the conversation above and produce a session checkpoint. Requirements:
- summary: one sentence describing what was accomplished
- context.task: the original task verbatim
- context.decisions: decisions made and why (only non-obvious ones)
- context.findings: specific file paths with line numbers and what matters there
- task_state.nextAction: MUST be a concrete file+line instruction — e.g. "Edit src/server.ts line 302 — add zod .max(2000) on summary field". NOT vague like "add validation".
- Keep total JSON under 1500 tokens`,
    template: AGENTIC_TEMPLATE,
  };
}

export async function autoSummarizeSession(
  server: Server,
  hints: { summary?: string; context?: string; task_state?: string },
): Promise<GeneratedSession | AgenticSummarizePrompt | null> {
  try {
    const result = await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: buildUserMessage(hints) } }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 800,
      includeContext: 'allServers',
    });

    const raw = result.content.type === 'text' ? result.content.text : '';
    if (!raw) return buildAgenticSummarizePrompt();

    const parsed = parseGeneratedSession(raw);
    if (!parsed) return buildAgenticSummarizePrompt();

    return { ...parsed, auto_summarized: true };
  } catch {
    // MCP Sampling unavailable — return agentic prompt so the calling AI can do it
    return buildAgenticSummarizePrompt();
  }
}
