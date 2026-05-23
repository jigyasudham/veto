// Handoff engine — platform detection, session save+switch, continue restore

import { getRateStatus, trackRequest } from '../router/rate-monitor.js';
import { saveSession, listSessions, restoreSession } from '../memory/local.js';
import type { Platform } from '../router/rate-monitor.js';

export type HandoffResult = {
  session_id: string;
  saved_at: string;
  from_platform: Platform;
  to_platform: Platform;
  reason: string;
  rate_status: ReturnType<typeof getRateStatus>;
  instructions: string;
  one_liner: string;
};

export type ContinueResult = {
  found: boolean;
  session_id?: string;
  platform?: string;
  active_client?: string;
  summary?: string;
  context?: unknown;
  task_state?: unknown;
  next_action?: string;
  project_dir?: string;
  token_count?: number;
  message: string;
  restored_at: string;
};

export type SetupPlatform = Platform | 'windsurf' | 'zed' | 'amazonq' | 'copilot' | 'jetbrains';

export type PlatformSetupResult = {
  platform: SetupPlatform;
  mcp_config: object;
  setup_steps: string[];
  rate_limit_signals: string[];
  continue_command: string;
  notes: string[];
};

// ─── Handoff ──────────────────────────────────────────────────────────────────

export function handoff(options: {
  summary?: string;
  context?: string;
  task_state?: string;
  from_platform?: Platform;
  to_platform?: Platform;
  token_count?: number;
  project_dir?: string;
}): HandoffResult {
  const rateStatus = getRateStatus();
  const from: Platform = options.from_platform ?? 'claude';

  // Pick the best available target platform
  const to: Platform = options.to_platform ?? selectTarget(from, rateStatus);

  const reason = rateStatus[from].status === 'critical'
    ? `${from} is at ${rateStatus[from].used_percent}% of daily limit`
    : rateStatus[from].status === 'warning'
    ? `${from} is at ${rateStatus[from].used_percent}% — switching proactively`
    : 'Manual platform switch requested';

  const { session_id, saved_at } = saveSession({
    platform: from,
    summary: options.summary ?? `Session handed off from ${from} to ${to}`,
    context: options.context,
    task_state: options.task_state,
    token_count: options.token_count ?? 0,
    project_dir: options.project_dir,
  });

  const instructions = buildInstructions(session_id, from, to, rateStatus);
  const one_liner = `Session saved (${session_id.slice(0, 8)}…). On ${to}: call veto_continue`;

  return {
    session_id,
    saved_at,
    from_platform: from,
    to_platform: to,
    reason,
    rate_status: rateStatus,
    instructions,
    one_liner,
  };
}

// ─── Continue ─────────────────────────────────────────────────────────────────

export function continueSession(sessionId?: string, active_client?: string): ContinueResult {
  const now = new Date().toISOString();

  if (sessionId) {
    const result = restoreSession(sessionId, active_client);
    if (!result.found || !result.session) {
      return { found: false, message: `No session found with ID: ${sessionId}`, restored_at: now };
    }
    return buildContinueResult(result.session, now);
  }

  // No ID given — find the most recent session
  const sessions = listSessions(1);
  if (sessions.length === 0) {
    return {
      found: false,
      message: 'No saved sessions found. Save a session first with veto_handoff or veto_session_save.',
      restored_at: now,
    };
  }

  const result = restoreSession(sessions[0].id, active_client);
  if (!result.found || !result.session) {
    return { found: false, message: 'Could not restore the most recent session.', restored_at: now };
  }

  return buildContinueResult(result.session, now);
}

function buildContinueResult(session: ReturnType<typeof listSessions>[0], now: string): ContinueResult {
  let context: unknown = null;
  let task_state: unknown = null;
  let next_action: string | undefined;

  try {
    context = session.context ? JSON.parse(session.context) : null;
  } catch { context = session.context; }

  try {
    let ts: unknown = session.task_state ? JSON.parse(session.task_state) : null;
    // saveSession double-stringifies when given a pre-serialised string — unwrap if needed
    if (typeof ts === 'string') { try { ts = JSON.parse(ts); } catch { /* keep as string */ } }
    task_state = ts;
    if (ts && typeof ts === 'object' && 'nextAction' in ts) {
      next_action = String((ts as Record<string, unknown>)['nextAction']);
    }
  } catch { task_state = session.task_state; }

  const message = [
    `Session restored from ${session.platform} (saved ${session.started_at.slice(0, 16)}).`,
    session.summary ? `\nSummary: ${session.summary}` : '',
    next_action ? `\nNext action: ${next_action}` : '',
    `\nContinue exactly where you left off. Nothing needs to be re-explained.`,
  ].filter(Boolean).join('');

  return {
    found: true,
    session_id: session.id,
    platform: session.platform,
    active_client: session.active_client ?? undefined,
    summary: session.summary ?? undefined,
    context,
    task_state,
    next_action,
    project_dir: session.project_dir ?? undefined,
    token_count: session.token_count,
    message,
    restored_at: now,
  };
}

// ─── Platform Setup ───────────────────────────────────────────────────────────

export function getPlatformSetup(platform: SetupPlatform, vetoServerPath: string): PlatformSetupResult {
  const mcpEntry = { command: 'npx', args: ['-y', '--package', '@jigyasudham/veto', 'veto-server'] };

  // ── Windsurf ────────────────────────────────────────────────────────────────
  if (platform === 'windsurf') {
    return {
      platform,
      mcp_config: { mcpServers: { veto: mcpEntry }, config_path: '~/.codeium/windsurf/mcp_config.json' },
      setup_steps: [
        '1. Run: npx @jigyasudham/veto init  (auto-writes ~/.codeium/windsurf/mcp_config.json)',
        '2. Fully restart Windsurf (quit and reopen)',
        '3. Verify: call veto_status in Windsurf — should return { "status": "running" }',
        'Tip: Windsurf also reads ~/.codeium/windsurf/rules/veto.md written by veto init.',
      ],
      rate_limit_signals: ['rate limit', 'too many requests', '429', 'quota exceeded'],
      continue_command: 'veto_continue',
      notes: [
        'Windsurf uses mcpServers format in ~/.codeium/windsurf/mcp_config.json.',
        'Veto init writes both the config file and ~/.codeium/windsurf/rules/veto.md automatically.',
        'All veto_* tools work identically in Windsurf as in Claude Code.',
      ],
    };
  }

  // ── Zed ─────────────────────────────────────────────────────────────────────
  if (platform === 'zed') {
    const zedSettingsPath = process.platform === 'win32'
      ? '%APPDATA%\\Zed\\settings.json'
      : '~/.config/zed/settings.json';
    return {
      platform,
      mcp_config: { context_servers: { veto: mcpEntry }, config_path: zedSettingsPath },
      setup_steps: [
        '1. Run: npx @jigyasudham/veto init  (auto-writes context_servers entry to Zed settings.json)',
        '2. Fully restart Zed',
        '3. Verify: call veto_status — should return { "status": "running" }',
        `Zed config path: ${zedSettingsPath}`,
      ],
      rate_limit_signals: ['rate limit', 'too many requests', '429', 'quota exceeded'],
      continue_command: 'veto_continue',
      notes: [
        'Zed uses "context_servers" (not "mcpServers") as the JSON key.',
        'veto init detects Zed automatically and writes the correct format.',
        'Zed AI features require a Pro subscription — MCP tools are only available in AI-enabled sessions.',
      ],
    };
  }

  // ── Amazon Q ────────────────────────────────────────────────────────────────
  if (platform === 'amazonq') {
    return {
      platform,
      mcp_config: {
        mcpServers: { veto: mcpEntry },
        global_config_path: '~/.aws/amazonq/mcp.json',
        project_config_path: '.amazonq/mcp.json',
      },
      setup_steps: [
        '1. Create ~/.aws/amazonq/mcp.json (global) or .amazonq/mcp.json (project-local):',
        '   { "mcpServers": { "veto": { "command": "npx", "args": ["-y", "--package", "@jigyasudham/veto", "veto-server"] } } }',
        '2. Restart Amazon Q Developer (VS Code extension or CLI)',
        '3. Verify: call veto_status — should return { "status": "running" }',
        'Tip: project-local .amazonq/mcp.json takes precedence over global ~/.aws/amazonq/mcp.json.',
      ],
      rate_limit_signals: ['throttling', 'service quota', 'rate limit', 'too many requests', '429'],
      continue_command: 'veto_continue',
      notes: [
        'Amazon Q supports both global (~/.aws/amazonq/mcp.json) and project-local (.amazonq/mcp.json) configs.',
        'Amazon Q Developer requires an AWS Builder ID or IAM Identity Center account.',
        'veto init does not yet auto-configure Amazon Q — write the config file manually per the steps above.',
      ],
    };
  }

  // ── Copilot ─────────────────────────────────────────────────────────────────
  if (platform === 'copilot') {
    return {
      platform,
      mcp_config: { mcpServers: { veto: mcpEntry }, config_path: '.github/copilot/mcp.json' },
      setup_steps: [
        '1. Run: npx @jigyasudham/veto init  (auto-writes .github/copilot/mcp.json)',
        '2. Restart VS Code or your GitHub Copilot client',
        '3. Verify: call veto_status — should return { "status": "running" }',
      ],
      rate_limit_signals: ['rate limit', 'too many requests', '429', 'quota exceeded'],
      continue_command: 'veto_continue',
      notes: [
        'Copilot MCP requires VS Code Insiders and the pre-release version of GitHub Copilot Chat.',
      ],
    };
  }

  // ── JetBrains ───────────────────────────────────────────────────────────────
  if (platform === 'jetbrains') {
    return {
      platform,
      mcp_config: { mcpServers: { veto: mcpEntry }, config_path: 'Settings > Tools > MCP Servers' },
      setup_steps: [
        '1. Open JetBrains IDE Settings > Tools > MCP Servers',
        '2. Add a new server using stdio. Command: npx, Args: -y --package @jigyasudham/veto veto-server',
        '3. Apply and restart the AI Assistant chat',
        '4. Verify: call veto_status — should return { "status": "running" }',
      ],
      rate_limit_signals: ['rate limit', 'too many requests', '429', 'quota exceeded'],
      continue_command: 'veto_continue',
      notes: [
        'JetBrains AI supports MCP as of 2025.2 EAP.',
      ],
    };
  }

// ── Claude / Gemini / Codex / Antigravity (existing platforms) ─────────────
  const configs: Record<Platform, { configPath: string; configKey: string; installCmd: string; notes: string[] }> = {
    claude: {
      configPath: '~/.claude/settings.json (managed by `claude mcp add`)',
      configKey:  'mcpServers',
      installCmd: 'claude mcp add veto -s user -- npx -y --package @jigyasudham/veto veto-server',
      notes: [
        'Claude Code manages MCPs via `claude mcp add`, NOT via mcp_servers.json.',
        'The -s user flag is required — without it, the MCP is project-scoped and disappears in new windows.',
        'All veto_* tools appear natively in Claude Code once connected.',
        'Rate limits tracked per day — call veto_rate_status to check headroom.',
      ],
    },
    gemini: {
      configPath: '~/.gemini/settings.json',
      configKey:  'mcpServers',
      installCmd: 'npm install -g @google/gemini-cli',
      notes: [
        'Gemini CLI connects via stdio MCP — same server instance as Claude.',
        'Free tier: 1,500 requests/day (15 RPM) — Veto tracks this automatically.',
        'All veto_* tools work identically on Gemini as on Claude.',
      ],
    },
    antigravity: {
      configPath: '~/.gemini/antigravity-cli/mcp_config.json',
      configKey:  'mcpServers',
      installCmd: 'npm install -g @jigyasudham/veto',
      notes: [
        'Antigravity CLI is the official successor to Gemini CLI.',
        'It stores MCP config in ~/.gemini/antigravity-cli/mcp_config.json.',
        'All veto_* tools are supported with agentic reasoning enabled.',
      ],
    },
    codex: {
      configPath: '~/.codex/config.toml (managed by `codex mcp add`)',
      configKey:  'mcp_servers.veto',
      installCmd: 'codex mcp add veto -- npx -y --package @jigyasudham/veto veto-server',
      notes: [
        'Codex CLI stores MCP servers in config.toml under [mcp_servers.name], NOT in config.json.',
        'Use `codex mcp add veto -- npx -y --package @jigyasudham/veto veto-server` to register.',
        'On Windows, replace `npx` with `npx.cmd` — the Rust binary cannot resolve bare npx.',
        'Verify registration with `codex mcp list` — veto should appear as enabled.',
        'ChatGPT web app does NOT support MCP — Codex CLI is the only OpenAI option.',
      ],
    },
  };

  const cfg = configs[platform as Platform] ?? configs['claude'];

  const claudeSteps = [
    `1. Run: claude mcp add veto -s user -- npx -y --package @jigyasudham/veto veto-server`,
    `   The -s user flag makes Veto available in ALL Claude Code windows and projects.`,
    `2. Fully restart Claude Code (quit and reopen — not just reload window)`,
    `3. Verify: call veto_status — should return { "status": "running" }`,
    `   Tip: run this once and it persists globally. No need to re-run per project.`,
  ];

  const antigravitySteps = [
    `1. Install Veto: npm install -g @jigyasudham/veto`,
    `2. Add to mcp_config.json: ~/.gemini/antigravity-cli/mcp_config.json`,
    `   "veto": { "command": "npx", "args": ["-y", "@jigyasudham/veto", "veto-server"] }`,
    `3. Fully restart Antigravity CLI (agy)`,
    `4. Verify: call veto_status — should return { "status": "running" }`,
  ];

  const codexSteps = [
    `1. Run: codex mcp add veto -- npx -y --package @jigyasudham/veto veto-server`,
    `   On Windows, use npx.cmd instead of npx (Codex Rust binary requires the .cmd extension).`,
    `   Windows: codex mcp add veto -- npx.cmd -y --package @jigyasudham/veto veto-server`,
    `2. Verify registration: codex mcp list  (veto should appear as enabled)`,
    `3. Fully restart Codex CLI`,
    `4. Verify: call veto_status — should return { "status": "running" }`,
    `   NOTE: Do NOT edit ~/.codex/config.json — Codex ignores mcpServers in that file.`,
  ];

  const genericSteps = [
    `1. Install: ${cfg.installCmd}`,
    `2. Run: npx @jigyasudham/veto init  (writes MCP config to ${cfg.configPath})`,
    `3. Fully restart ${platform} CLI (config is global — applies to all projects)`,
    `4. Verify: call veto_status — should return { "status": "running" }`,
  ];

  const codexMcpConfig = {
    toml_path: '~/.codex/config.toml',
    toml_entry: '[mcp_servers.veto]\ncommand = \'npx.cmd\'  # Windows; use \'npx\' on Linux/Mac\nargs = [\'-y\', \'--package\', \'@jigyasudham/veto\', \'veto-server\']',
    preferred_method: 'codex mcp add veto -- npx.cmd -y --package @jigyasudham/veto veto-server',
    warning: 'config.json mcpServers key is ignored by Codex CLI — use config.toml only',
  };

  return {
    platform,
    mcp_config: platform === 'codex' ? codexMcpConfig : { [cfg.configKey]: { veto: mcpEntry } },
    setup_steps: platform === 'claude' ? claudeSteps : platform === 'antigravity' ? antigravitySteps : platform === 'codex' ? codexSteps : genericSteps,
    rate_limit_signals: ['rate limit', 'too many requests', '429', 'quota exceeded', 'resource exhausted'],
    continue_command: 'veto_continue',
    notes: cfg.notes,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function selectTarget(from: Platform, rateStatus: ReturnType<typeof getRateStatus>): Platform {
  const order: Platform[] = from === 'claude'
    ? ['gemini', 'antigravity', 'codex']
    : from === 'gemini'
    ? ['antigravity', 'codex', 'claude']
    : from === 'antigravity'
    ? ['codex', 'claude', 'gemini']
    : ['claude', 'gemini', 'antigravity'];

  for (const p of order) {
    if (rateStatus[p].status !== 'critical') return p;
  }
  // All critical — pick the one with most headroom remaining
  return order.reduce((best, p) =>
    rateStatus[p].used_percent < rateStatus[best].used_percent ? p : best
  , order[0]);
}

function buildInstructions(
  sessionId: string,
  from: Platform,
  to: Platform,
  rateStatus: ReturnType<typeof getRateStatus>
): string {
  const toStatus = rateStatus[to];
  const lines: string[] = [
    `── Veto Handoff ──────────────────────────────────────────`,
    `From:     ${from.padEnd(8)} (${rateStatus[from].used_percent}% used)`,
    `To:       ${to.padEnd(8)} (${toStatus.used_percent}% used)`,
    `Session:  ${sessionId}`,
    ``,
    `On ${to}:`,
    `  1. Open a new terminal with ${to} CLI`,
    `  2. Veto is already running — same server, same memory`,
    `  3. Call:  veto_continue`,
    `     Veto restores full context automatically.`,
    `     Nothing needs to be re-explained.`,
    ``,
    `Or if you have the session ID:`,
    `  veto_continue { "session_id": "${sessionId}" }`,
    ``,
    `Rate resets at: ${rateStatus[from].resets_at.slice(0, 16)} UTC`,
    `─────────────────────────────────────────────────────────`,
  ];

  return lines.join('\n');
}
