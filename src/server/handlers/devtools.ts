// Standalone developer-tooling handlers that don't belong to a larger domain:
// plugin listing, local-LLM passthrough, clone detection, custom agent
// composition, and IDE notifications. veto_notify_ide uses the MCP server to
// push a logging message, so it reads ctx.server.

import { listPlugins } from '../../plugins/loader.js';
import { upsertPattern } from '../../memory/local.js';
import type { HandlerMap } from '../registry.js';

export const devtoolsHandlers: HandlerMap = {
  veto_plugins: () => ({
    content: [{ type: 'text', text: JSON.stringify({ plugins: listPlugins(), plugin_dir: `${process.env.HOME ?? process.env.USERPROFILE}/.veto/agents/`, instructions: 'Drop a .js file exporting plan(task, context?) to register a custom agent.' }, null, 2) }],
  }),

  veto_local_llm: async ({ args }) => {
    const { task, model, provider } = args;
    const { callLocalLlm } = await import('../../agents/local-llm.js');
    const result = await callLocalLlm({ task: String(task), model: model ? String(model) : undefined, provider: provider as any });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  veto_clone_detector: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const extensions = Array.isArray(args?.extensions) ? args.extensions.map(String) : undefined;
    const minLines = typeof args?.min_lines === 'number' ? args.min_lines : undefined;
    const { detectClones } = await import('../../agents/quality/clone-detector.js');
    const findings = await detectClones({ project_dir: projectDir, extensions, min_lines: minLines });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, clones_found: findings.length, findings }, null, 2) }] };
  },

  veto_compose_agents: ({ args }) => {
    const name = String(args?.name ?? '').trim();
    const agents = Array.isArray(args?.agents) ? args.agents.map(String) : [];
    const workflow = args?.workflow;
    if (!name || agents.length === 0) {
      return { content: [{ type: 'text', text: 'name and a non-empty agents array are required.' }], isError: true };
    }
    const definition = { name, base_agents: agents, workflow, composed_at: new Date().toISOString() };
    upsertPattern({ pattern_key: `composed_agent:${name}`, pattern_val: JSON.stringify(definition) });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Custom agent "${name}" composed and persisted to Veto memory.`,
          definition,
          usage: 'Retrieve via veto_patterns_list (prefix "composed_agent:"); run its base agents with veto_execute_parallel or veto_workflow.',
        }, null, 2),
      }],
    };
  },

  veto_notify_ide: async ({ args, server }) => {
    const { action, message, level } = args;
    // In bidirectional MCP, some clients listen for logging or custom notifications
    if (action === 'show_message' && message) {
      await server.sendLoggingMessage({
        level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
        data: message,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, action, message: `Action ${action} sent to IDE client.` }, null, 2) }] };
  },
};
