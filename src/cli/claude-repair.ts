// Detect and repair a stale user-scope `veto` MCP registration in Claude Code.
//
// The failure this fixes: an old entry pinned to a global install's
// `.../node_modules/@jigyasudham/veto/dist/server.js` stops resolving once
// `npm rm -g @jigyasudham/veto` deletes that install — Claude Code then shows the
// server as "✘ Failed to connect". `veto init` used to skip such an entry ("already
// registered"); now it self-heals it back to the canonical pinned-npx command.

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

export interface McpEntry {
  command?: string;
  args?: string[];
}

// True when the entry launches `node <script>` but that script no longer exists on
// disk. Pure aside from the existence check, so it is easy to unit-test. It never flags
// an npx-based or otherwise-working entry, so a repair can't clobber an intentional
// local-build config (e.g. a separate `veto-dev` pointing at a real dist path).
export function isDeadNodePathEntry(entry: McpEntry | undefined): boolean {
  if (!entry || entry.command !== 'node') return false;
  const scriptPath = entry.args?.find((a) => /\.[cm]?js$/i.test(a));
  return !!scriptPath && !existsSync(scriptPath);
}

// Re-register a dead user-scope `veto` entry (from ~/.claude.json) with the canonical
// pinned-npx command so it connects again. Returns true only when it actually repaired
// something. Best-effort: any parse/exec failure leaves the config untouched.
export function repairBrokenClaudeEntry(claudeJsonPath: string, mcpCmd: string): boolean {
  try {
    if (!existsSync(claudeJsonPath)) return false;
    const cfg = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
      mcpServers?: Record<string, McpEntry>;
    };
    if (!isDeadNodePathEntry(cfg.mcpServers?.veto)) return false;
    execSync('claude mcp remove veto -s user', { stdio: 'pipe', timeout: 15000 });
    execSync(mcpCmd, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}
