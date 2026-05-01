// Codex CLI adapter — connection config, rate signal detection, handoff format
// Codex CLI: https://github.com/openai/codex

export const PLATFORM = 'codex' as const;

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
    platform: 'codex',
    mcp_config: {
      mcpServers: {
        veto: {
          command: 'node',
          args: [vetoServerPath],
        },
      },
    },
    setup_steps: [
      `1. Install Codex CLI: npm install -g @openai/codex`,
      `2. Set API key: export OPENAI_API_KEY=your-key`,
      `3. Add to ~/.codex/config.json:\n${JSON.stringify({ mcpServers: { veto: { command: 'node', args: [vetoServerPath] } } }, null, 2)}`,
      `4. Restart Codex CLI`,
      `5. Verify: call veto_status — should return { "status": "running", "version": "0.7.0" }`,
    ],
    rate_limit_signals: [
      'rate limit reached',
      'too many requests',
      '429',
      'insufficient quota',
      'rate_limit_exceeded',
      'quota_exceeded',
    ],
    continue_command: 'veto_continue',
    notes: [
      'Codex CLI connects to Veto via stdio MCP — same server instance as Claude and Gemini',
      'Config path: ~/.codex/config.json (created automatically on first run)',
      'All veto_* tools work identically on Codex as on Claude and Gemini',
      'Codex is the Tier 1/2 overflow when both Claude and Gemini are rate-limited',
      'Uses GPT-4o / o4-mini depending on the tier assigned by the Veto router',
      'ChatGPT web app does NOT support MCP — Codex CLI is the only OpenAI option',
    ],
  };
}

export function detectRateLimit(errorText: string): boolean {
  const signals = ['rate limit', 'too many requests', '429', 'insufficient quota', 'rate_limit_exceeded'];
  return signals.some(s => errorText.toLowerCase().includes(s.toLowerCase()));
}

export function formatHandoffMessage(sessionId: string, fromPlatform: 'claude' | 'gemini'): string {
  const from = fromPlatform === 'claude' ? 'Claude' : 'Gemini';
  return [
    `${from} handed off to Codex. Session restored.`,
    ``,
    `Session ID: ${sessionId}`,
    ``,
    `Codex has full context. Continue the task as if nothing interrupted.`,
  ].join('\n');
}

export function formatContinueInstructions(): string {
  return 'Run: veto_continue\nVeto will restore the most recent session automatically.';
}
