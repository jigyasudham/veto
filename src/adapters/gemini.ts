// Gemini CLI adapter — connection config, rate signal detection, handoff format
// Gemini CLI MCP support: https://github.com/google-gemini/gemini-cli

export const PLATFORM = 'gemini' as const;

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
    platform: 'gemini',
    mcp_config: {
      mcpServers: {
        veto: {
          command: 'node',
          args: [vetoServerPath],
        },
      },
    },
    setup_steps: [
      `1. Install Gemini CLI: npm install -g @google/gemini-cli`,
      `2. Authenticate: gemini auth`,
      `3. Add to ~/.gemini/settings.json:\n${JSON.stringify({ mcpServers: { veto: { command: 'node', args: [vetoServerPath] } } }, null, 2)}`,
      `4. Restart Gemini CLI`,
      `5. Verify: call veto_status — should return { "status": "running", "version": "0.7.0" }`,
    ],
    rate_limit_signals: [
      'quota exceeded',
      'resource exhausted',
      '429',
      'rate limit',
      'too many requests',
      'RESOURCE_EXHAUSTED',
    ],
    continue_command: 'veto_continue',
    notes: [
      'Gemini CLI connects to Veto via stdio MCP — same server instance as Claude',
      'Gemini CLI uses the same ~/.gemini/settings.json for MCP server config',
      'All veto_* tools work identically on Gemini as on Claude',
      'Gemini Flash is the default Tier 1/2 overflow platform when Claude is rate-limited',
      'Free tier: 1,500 requests/day (15 RPM) — Veto tracks this in rate_usage table',
    ],
  };
}

export function detectRateLimit(errorText: string): boolean {
  const signals = ['quota exceeded', 'resource exhausted', '429', 'rate limit', 'RESOURCE_EXHAUSTED'];
  return signals.some(s => errorText.toLowerCase().includes(s.toLowerCase()));
}

export function formatHandoffMessage(sessionId: string, fromPlatform: 'claude' | 'codex'): string {
  const from = fromPlatform === 'claude' ? 'Claude' : 'Codex';
  return [
    `${from} handed off to Gemini. Session restored.`,
    ``,
    `Session ID: ${sessionId}`,
    ``,
    `Gemini has full context. Continue the task as if nothing interrupted.`,
    `Call veto_session_restore { "session_id": "${sessionId}" } if context needs refreshing.`,
  ].join('\n');
}

export function formatContinueInstructions(): string {
  return 'Run: veto_continue\nVeto will restore the most recent session automatically.';
}
