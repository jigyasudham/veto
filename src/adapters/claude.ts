// Claude Code adapter — connection config, rate signal detection, handoff format

export const PLATFORM = 'claude' as const;

export type AdapterSetup = {
  platform: string;
  mcp_config: object;
  setup_steps: string[];
  rate_limit_signals: string[];
  continue_command: string;
  notes: string[];
};

export function getSetup(vetoServerPath: string): AdapterSetup {
  return {
    platform: 'claude',
    mcp_config: {
      mcpServers: {
        veto: {
          command: 'node',
          args: [vetoServerPath],
        },
      },
    },
    setup_steps: [
      `1. Build veto: npm run build`,
      `2. Add to ~/.claude/mcp_servers.json:\n${JSON.stringify({ mcpServers: { veto: { command: 'node', args: [vetoServerPath] } } }, null, 2)}`,
      `3. Restart Claude Code`,
      `4. Verify: call veto_status — should return { "status": "running", "version": "0.7.0" }`,
    ],
    rate_limit_signals: [
      'rate limit exceeded',
      'too many requests',
      '429',
      'overloaded',
      'capacity',
      'quota exceeded',
    ],
    continue_command: 'veto_continue',
    notes: [
      'Claude Code connects to Veto via stdio MCP — the server runs as a child process',
      'All veto_* tools are available natively in Claude Code once connected',
      'Rate limits are tracked by Veto per day — call veto_rate_status to check headroom',
      'Before hitting the limit: call veto_handoff to get a session ID and switch instructions',
    ],
  };
}

export function detectRateLimit(errorText: string): boolean {
  const signals = ['rate limit', 'too many requests', '429', 'overloaded', 'quota'];
  return signals.some(s => errorText.toLowerCase().includes(s));
}

export function formatHandoffMessage(sessionId: string, targetPlatform: 'gemini' | 'codex'): string {
  const target = targetPlatform === 'gemini' ? 'Gemini CLI' : 'Codex CLI';
  return [
    `Claude is approaching its rate limit. Switching to ${target}.`,
    ``,
    `Session saved. ID: ${sessionId}`,
    ``,
    `On ${target}, run:`,
    `  veto_continue`,
    ``,
    `Veto will restore full context automatically. Nothing needs to be re-explained.`,
  ].join('\n');
}

export function formatSwitchPrompt(sessionId: string): string {
  return `Rate limit approaching. Session saved (ID: ${sessionId}). Call veto_continue on the next platform to resume instantly.`;
}
