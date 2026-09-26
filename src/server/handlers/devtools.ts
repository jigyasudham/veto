// Standalone developer-tooling handlers that don't belong to a larger domain:
// plugin listing, local-LLM passthrough, clone detection, custom agent
// composition, and IDE notifications. veto_notify_ide uses the MCP server to
// push a logging message, so it reads ctx.server.

import { listPlugins, PLUGIN_DIR } from '../../plugins/loader.js';
import { upsertPattern } from '../../memory/local.js';
import type { HandlerMap } from '../registry.js';

export const devtoolsHandlers: HandlerMap = {
  veto_plugins: () => ({
    content: [{ type: 'text', text: JSON.stringify({ plugins: listPlugins(), plugin_dir: PLUGIN_DIR, instructions: 'Drop a .js file exporting plan(task, context?) to register a custom agent.' }, null, 2) }],
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
    // MCP gives a server exactly one way to reach the client unprompted: a log
    // message. There is no "open this file" or "set the status bar" request, so
    // those actions cannot be done. This used to answer "Action open_file sent to
    // IDE client." for every action while sending nothing at all.
    if (action === 'show_message' || action === 'set_status') {
      if (!message) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'message is required.' }, null, 2) }], isError: true };
      try {
        await server.sendLoggingMessage({ level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info', data: String(message) });
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Could not send: ${err instanceof Error ? err.message : String(err)}` }, null, 2) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, action, delivered_as: 'MCP log notification', note: 'Sent. Whether and where it is shown is up to the client; many show log messages only in a debug panel.' }, null, 2) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      success: false,
      action,
      message: `"${action}" is not something an MCP server can make a client do — MCP has no request for it. Nothing was sent. To surface a message, use action "show_message".`,
    }, null, 2) }], isError: true };
  },
};
