// Tool-handler registry types for the incremental server.ts decomposition.
//
// Each MCP tool is migrating from the giant switch in server.ts to a per-domain
// handler module that exports a HandlerMap. server.ts merges those maps and
// dispatches by name, falling back to the (shrinking) switch for not-yet-migrated
// tools. Handlers live in their own modules so they are unit-testable — unlike
// server.ts, which connects stdio at import time.

export interface ToolContext {
  /** The raw MCP CallToolRequest. */
  request: any;
  /** request.params.arguments, defaulted to {}. */
  args: any;
}

// Returns an MCP tool result ({ content: [...] }, optionally isError). Typed as
// any to match the existing loosely-typed switch handlers without friction.
export type ToolHandler = (ctx: ToolContext) => Promise<any> | any;

export type HandlerMap = Record<string, ToolHandler>;
