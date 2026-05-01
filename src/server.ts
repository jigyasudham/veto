#!/usr/bin/env node
// Veto MCP Server — Phase 1 skeleton
// Exposes: veto_status, veto_session_save, veto_session_restore, veto_sessions_list

// Suppress node:sqlite experimental warning — it would corrupt the MCP stdio protocol
process.removeAllListeners('warning');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { saveSession, restoreSession, listSessions, getDbPath, saveCouncilOutcome } from './memory/local.js';
import { runDebate } from './council/index.js';
import { routeTask, getRateStatus } from './router/index.js';
import type { AgentType, Platform } from './router/index.js';

const VERSION = '0.3.0';

const server = new Server(
  { name: 'veto', version: VERSION },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'veto_status',
      description: 'Returns Veto server status, version, and database info.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_session_save',
      description:
        'Saves the current session context to SQLite for later restoration across AI platforms.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A brief summary of what was accomplished this session.',
          },
          context: {
            type: 'string',
            description: 'Key context to restore (decisions, current task, file list, etc.).',
          },
          task_state: {
            type: 'string',
            description: 'Current task state — what is done and what is next.',
          },
          platform: {
            type: 'string',
            description: 'AI platform used (claude, gemini, codex). Defaults to "claude".',
            enum: ['claude', 'gemini', 'codex'],
          },
          project_dir: {
            type: 'string',
            description: 'Absolute path to the current project directory.',
          },
          token_count: {
            type: 'number',
            description: 'Approximate tokens used this session.',
          },
        },
        required: ['summary', 'context'],
      },
    },
    {
      name: 'veto_session_restore',
      description:
        'Restores a previously saved session by ID. Use veto_sessions_list to find IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'UUID of the session to restore.',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'veto_sessions_list',
      description: 'Lists the most recent saved sessions (up to 10).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of sessions to return (default 10, max 50).',
          },
        },
        required: [],
      },
    },
    {
      name: 'veto_route_task',
      description:
        'Scores a task for complexity (0-100) and returns the optimal tier, model recommendation, and rate status. Use before any substantial task to let the router decide which model to use.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task description to score and route.',
          },
          agent_type: {
            type: 'string',
            description: 'Optional agent type — some agents are tier-locked regardless of score.',
            enum: [
              'lead-developer', 'system-architect', 'security-scanner',
              'devil-advocate', 'decision-engine', 'risk-assessor',
              'coder', 'tester', 'reviewer', 'database', 'documentation',
              'file-manager', 'git-agent', 'search-agent', 'secrets', 'reporter',
              'dynamic',
            ],
          },
          files_affected: {
            type: 'number',
            description: 'Number of files the task will touch (influences complexity score).',
          },
          force_council: {
            type: 'boolean',
            description: 'Set true to force a Tier 3 / council-required routing.',
          },
          context: {
            type: 'string',
            description: 'Current context text — router will return a compression plan.',
          },
          preferred_platform: {
            type: 'string',
            description: 'Preferred AI platform. Router may override if rate-limited.',
            enum: ['claude', 'gemini', 'codex'],
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'veto_rate_status',
      description: 'Returns current request counts and rate limit status for all AI platforms tracked by Veto.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'veto_council_debate',
      description:
        'Runs the Veto Council — 5 specialist agents (Lead Dev, PM, Architect, UX, Devil\'s Advocate) debate your task in parallel and return a GREEN / YELLOW / RED / DEADLOCK verdict before any code is written. Call this before architecture decisions, security-sensitive work, database migrations, or any task the router scores above 71.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task or decision to debate. Be specific — include approach, tech stack, and constraints.',
          },
          context: {
            type: 'string',
            description: 'Optional: additional context such as codebase state, prior decisions, or constraints.',
          },
          session_id: {
            type: 'string',
            description: 'Optional: session ID to associate this council outcome with an active session.',
          },
        },
        required: ['task'],
      },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'veto_status': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'running',
                version: VERSION,
                server: 'veto',
                phase: 3,
                capabilities: ['session_save', 'session_restore', 'router', 'rate_monitor', 'council_debate'],
                db_path: getDbPath(),
                uptime_ms: process.uptime() * 1000,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_session_save': {
      const result = saveSession({
        summary: String(args?.summary ?? ''),
        context: String(args?.context ?? ''),
        task_state: args?.task_state ? String(args.task_state) : undefined,
        platform: args?.platform ? String(args.platform) : 'claude',
        project_dir: args?.project_dir ? String(args.project_dir) : undefined,
        token_count: typeof args?.token_count === 'number' ? args.token_count : 0,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Session saved. Use this ID to restore on any AI platform.',
                ...result,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_session_restore': {
      const session_id = String(args?.session_id ?? '');
      const result = restoreSession(session_id);

      if (!result.found) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: false, message: `No session found with id: ${session_id}` },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const s = result.session!;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                session_id: s.id,
                platform: s.platform,
                started_at: s.started_at,
                ended_at: s.ended_at,
                project_dir: s.project_dir,
                summary: s.summary,
                context: s.context ? JSON.parse(s.context) : null,
                task_state: s.task_state ? JSON.parse(s.task_state) : null,
                token_count: s.token_count,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_sessions_list': {
      const limit = Math.min(typeof args?.limit === 'number' ? args.limit : 10, 50);
      const sessions = listSessions(limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: sessions.length,
                sessions: sessions.map((s) => ({
                  id: s.id,
                  platform: s.platform,
                  started_at: s.started_at,
                  ended_at: s.ended_at,
                  project_dir: s.project_dir,
                  summary: s.summary,
                  token_count: s.token_count,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'veto_route_task': {
      const result = routeTask(String(args?.task ?? ''), {
        agentType: args?.agent_type ? (String(args.agent_type) as AgentType) : undefined,
        filesAffected: typeof args?.files_affected === 'number' ? args.files_affected : undefined,
        forceCouncil: args?.force_council === true,
        context: args?.context ? String(args.context) : undefined,
        preferredPlatform: args?.preferred_platform ? (String(args.preferred_platform) as Platform) : 'claude',
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case 'veto_rate_status': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(getRateStatus(), null, 2),
          },
        ],
      };
    }

    case 'veto_council_debate': {
      const task = String(args?.task ?? '').trim();
      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task is required.' }) }],
          isError: true,
        };
      }

      const result = await runDebate({
        task,
        context: args?.context ? String(args.context) : undefined,
      });

      const outcomeId = saveCouncilOutcome({
        session_id: args?.session_id ? String(args.session_id) : undefined,
        task,
        verdict: result.final_verdict,
        lead_dev: JSON.stringify(result.votes.lead_dev),
        pm: JSON.stringify(result.votes.pm),
        architect: JSON.stringify(result.votes.architect),
        ux: JSON.stringify(result.votes.ux),
        devil: JSON.stringify(result.votes.devil),
        recommended: result.recommended,
      });

      return {
        content: [
          {
            type: 'text',
            text: result.formatted_output + '\n\n' + JSON.stringify(
              {
                outcome_id: outcomeId,
                final_verdict: result.final_verdict,
                block_reasons: result.block_reasons,
                warnings: result.warnings,
                recommended: result.recommended,
                debated_at: result.debated_at,
                votes: {
                  lead_dev: result.votes.lead_dev.verdict,
                  pm: result.votes.pm.verdict,
                  architect: result.votes.architect.verdict,
                  ux: result.votes.ux.verdict,
                  devil: result.votes.devil.verdict,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't pollute MCP stdio
  process.stderr.write(`Veto MCP server v${VERSION} running (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
