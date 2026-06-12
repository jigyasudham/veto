// Compact tool surface — progressive disclosure for clients where 91 tool
// schemas would burn ~25K context tokens before the user types a word.
//
// In compact mode (VETO_COMPACT=1 or config compact_tools=true) ListTools
// exposes only a small first-class set plus two meta-tools: veto_find_tools
// (search the full catalog, returns matching schemas on demand) and veto_call
// (invoke any catalog tool by name). Every tool stays callable directly in
// both modes — compact only changes what is advertised.

import { TOOL_DEFINITIONS } from './definitions.js';
import { getConfig } from '../memory/config.js';

type ToolDef = { name: string; description: string; inputSchema: object };

const ALL_TOOLS = TOOL_DEFINITIONS as unknown as ToolDef[];

// High-frequency core flows that earn a permanent schema slot in compact mode.
const FIRST_CLASS = [
  'veto_status',
  'veto_session_save',
  'veto_session_restore',
  'veto_route_task',
  'veto_council_debate',
  'veto_memory_search',
  'veto_record_outcome',
];

export const META_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'veto_find_tools',
    description:
      'Searches the full Veto catalog (91 tools: agents, reviews, advisors, generators, memory, learning, git, workflow) by keyword and returns matching tool schemas. Compact mode exposes only core tools up front — call this first to discover the right tool, then invoke it via veto_call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords describing what you need, e.g. "security scan", "commit message", "dead code".',
        },
        limit: {
          type: 'number',
          description: 'Max tools to return (default 5).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'veto_call',
    description:
      'Invokes any Veto catalog tool by name with the given arguments. Use veto_find_tools first to discover the tool name and its argument schema.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Exact tool name, e.g. "veto_security_scan".',
        },
        args: {
          type: 'object',
          description: 'Arguments object matching the tool\'s inputSchema. Defaults to {}.',
        },
      },
      required: ['tool'],
    },
  },
];

export function isCompactMode(): boolean {
  const env = (process.env.VETO_COMPACT ?? '').toLowerCase();
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return getConfig().compact_tools === true;
}

export function getCompactToolList(): ToolDef[] {
  const firstClass = ALL_TOOLS.filter(t => FIRST_CLASS.includes(t.name));
  return [...META_TOOL_DEFINITIONS, ...firstClass];
}

// ─── Catalog search ───────────────────────────────────────────────────────────

export function findTools(query: string, limit = 5): ToolDef[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  const scored = ALL_TOOLS.map(tool => {
    const name = tool.name.toLowerCase();
    const desc = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      if (desc.includes(term)) score += 1;
    }
    return { tool, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(s => s.tool);
}

export function getToolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find(t => t.name === name);
}
