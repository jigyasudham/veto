// Tool definitions for all 46 Veto MCP tools — pure data, no side effects.
// Grouped by category. server.ts imports TOOL_DEFINITIONS and maps annotations onto it.

export const TOOL_DEFINITIONS = [
  // ── Status & Health ──────────────────────────────────────────────────────────
  {
    name: 'veto_status',
    description: 'Returns Veto server status, version, and database info. Pass token_count to trigger auto-save if context usage crosses 70%.',
    inputSchema: {
      type: 'object',
      properties: {
        token_count: {
          type: 'number',
          description: 'Current session token count. If provided and context usage ≥ 70%, Veto auto-saves the last known session context in the background.',
        },
        platform: {
          type: 'string',
          description: 'AI platform (claude, gemini, codex). Used to select the correct context window for threshold calculation. Defaults to "claude".',
          enum: ['claude', 'gemini', 'codex'],
        },
        model: {
          type: 'string',
          description: 'Optional: specific model ID (e.g. "claude-sonnet-4-6", "gemini-2-5-pro", "gpt-4o"). When provided, Veto resolves the exact context window for that model instead of using the platform default.',
        },
      },
      required: [],
    },
  },
  {
    name: 'veto_autosave_status',
    description: 'Returns the current auto-save state: whether a context is cached, the threshold, the last auto-save time, and the session ID.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'veto_health',
    description: 'Returns a live health snapshot of the Veto server — DB size, session/memory/pattern counts, uptime, error count, and average council latency.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
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
  // ── Session ──────────────────────────────────────────────────────────────────
  {
    name: 'veto_session_save',
    description:
      'Saves the current session context to SQLite. Set auto_summarize: true to have Veto read the full conversation and generate an accurate structured summary itself — no manual writing needed. Pass session_id to update an existing session in-place.',
    inputSchema: {
      type: 'object',
      properties: {
        auto_summarize: {
          type: 'boolean',
          description: 'When true, Veto reads the full conversation context via MCP Sampling and generates summary, context, and task_state automatically — including specific file paths, decisions, and a concrete nextAction. Recommended: pass true and omit summary/context/task_state. Falls back to provided values if sampling is unavailable.',
        },
        summary: {
          type: 'string',
          description: 'A brief summary of what was accomplished. Optional when auto_summarize is true.',
        },
        context: {
          type: 'string',
          description: 'Key context to restore (decisions, current task, file list, etc.). Optional when auto_summarize is true.',
        },
        task_state: {
          type: 'string',
          description: 'Current task state — what is done and what is next. Optional when auto_summarize is true.',
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
        connection_type: {
          type: 'string',
          description: 'How you are connected to this AI — "subscription" (Claude Pro, Gemini Advanced) or "api" (API key). Used for usage tracking.',
          enum: ['subscription', 'api'],
        },
        token_count: {
          type: 'number',
          description: 'Approximate tokens used this session. Veto uses this for context window monitoring.',
        },
        session_id: {
          type: 'string',
          description: 'Optional. UUID of an existing session to update in-place. When provided, Veto updates that row instead of inserting a new one — prevents session inflation when refreshing mid-conversation.',
        },
        model: {
          type: 'string',
          description: 'Optional: specific model ID (e.g. "claude-sonnet-4-6", "gemini-2-5-pro", "gpt-4o"). Veto resolves the exact context window for this model and uses it for auto-save threshold calculations.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional labels for this session (e.g. ["auth", "migration", "v1.3"]). Makes sessions searchable via veto_sessions_list query.',
        },
      },
      required: [],
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
        resuming_as: {
          type: 'string',
          description: 'The AI client resuming this session (e.g. "claude", "gemini", "codex"). Recorded as active_client.',
          enum: ['claude', 'gemini', 'codex'],
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'veto_sessions_list',
    description: 'Lists the most recent saved sessions. Use query to search by summary, context, tags, or project path.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of sessions to return (default 10, max 50).',
        },
        query: {
          type: 'string',
          description: 'Optional text search — matches against summary, context, task_state, tags, and project_dir.',
        },
      },
      required: [],
    },
  },
  {
    name: 'veto_handoff',
    description: 'Saves the current session and returns step-by-step instructions to continue on another AI platform (Gemini or Codex). Call this when Claude is approaching its rate limit. The receiving platform calls veto_continue to restore full context instantly.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished this session — one or two sentences.' },
        context: { type: 'string', description: 'Key context the next platform needs: active decisions, file paths, constraints.' },
        task_state: { type: 'string', description: 'Current task state — what is done, what is in progress, what is next.' },
        from_platform: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'Platform handing off (default: claude).' },
        to_platform: { type: 'string', enum: ['gemini', 'codex', 'claude'], description: 'Target platform. If omitted, Veto picks the platform with the most headroom.' },
        project_dir: { type: 'string', description: 'Absolute path to the current project directory.' },
        token_count: { type: 'number', description: 'Approximate tokens used this session.' },
      },
      required: ['summary', 'context'],
    },
  },
  {
    name: 'veto_continue',
    description: 'Restores the most recent session on any platform. Call this immediately after switching platforms — Veto returns the full context, summary, and next action. Nothing needs to be re-explained.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Optional. Session ID from veto_handoff. If omitted, the most recent saved session is restored.' },
        resuming_as: { type: 'string', description: 'The AI client resuming this session (e.g. "gemini"). Recorded as active_client so you can track which tool is currently working on it.', enum: ['claude', 'gemini', 'codex'] },
      },
      required: [],
    },
  },
  // ── Council ──────────────────────────────────────────────────────────────────
  {
    name: 'veto_council_debate',
    description:
      'Runs the Veto Council — 7 specialist agents debate your task and return a GREEN/YELLOW/RED/DEADLOCK verdict. For full LLM-backed analysis on any platform (Claude Code, Gemini CLI, Codex CLI) with no API keys: (1) call with task only → get instant deterministic result + llm_upgrade.debate_prompt; (2) reason as all 7 agents using the prompt, then call again with agent_responses → get the LLM-backed verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task or decision to debate. Be specific — include approach, tech stack, and constraints.',
        },
        agent_responses: {
          type: 'object',
          description: 'Phase 2 (LLM upgrade): the JSON object you generated by following llm_upgrade.debate_prompt from a previous call. Veto runs the verdict engine on your responses and returns the final LLM-backed verdict.',
          properties: {
            lead_dev:  { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            pm:        { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            architect: { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            ux:        { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            devil:     { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            legal:     { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
            security:  { type: 'object', properties: { verdict: { type: 'string' }, reason: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } }, required: ['verdict', 'reason'] },
          },
          required: ['lead_dev', 'pm', 'architect', 'ux', 'devil', 'legal', 'security'],
        },
        context: {
          type: 'string',
          description: 'Optional: additional context such as codebase state, prior decisions, or constraints.',
        },
        project_dir: {
          type: 'string',
          description: 'Optional: absolute path to the project directory. Veto will auto-read package.json, git diff, and stack info to give the council real project context.',
        },
        session_id: {
          type: 'string',
          description: 'Optional: session ID to associate this council outcome with an active session.',
        },
        max_tokens: {
          type: 'number',
          description: 'Optional: token budget for this operation. Veto estimates output tokens and warns in the response if the estimate exceeds this limit. Logged to usage_log for tracking.',
        },
        strictness: {
          type: 'string',
          enum: ['fast', 'standard', 'strict'],
          description: 'Council depth. fast: 3 core agents (dev + architect + security), instant. standard: all 7 agents (default). strict: all 7 + Devil\'s Advocate rebuttal round on the most critical blocker.',
        },
        architect_model: {
          type: 'string',
          description: 'Optional: override model used for the architecture/planning phase (e.g. claude-3-7-sonnet).',
        },
        editor_model: {
          type: 'string',
          description: 'Optional: override model used for the editing/execution phase (e.g. claude-3-5-haiku).',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'veto_benchmark',
    description: 'Compares two competing approaches by running a full council debate on each in parallel, then returns a structured winner analysis with verdict, confidence delta, warning counts, and council reasoning. Use when you have two valid options and want an unbiased council judgment before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        task:        { type: 'string', description: 'The decision context — what problem are both approaches solving?' },
        approach_a:  { type: 'string', description: 'First approach to evaluate. Be specific about tech choices, trade-offs, and constraints.' },
        approach_b:  { type: 'string', description: 'Second approach to evaluate. Same level of detail as approach_a.' },
        context:     { type: 'string', description: 'Optional: shared context for both debates (architecture notes, constraints, team size, etc.).' },
        project_dir: { type: 'string', description: 'Optional: auto-inject package.json and git diff context.' },
      },
      required: ['task', 'approach_a', 'approach_b'],
    },
  },
  // ── Routing & Execution ──────────────────────────────────────────────────────
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
    name: 'veto_agent_plan',
    description: 'Gets a domain-expert execution plan from a specific worker agent. Returns approach, ordered steps, checklist, patterns, and pitfalls for the task.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'The worker agent to consult.',
          enum: ['coder','reviewer','tester','debugger','refactor','database','api','frontend','backend','devops','performance','migration','security-scanner','auth','privacy','secrets','dependency-audit','penetration','context-manager','decision-logger','project-mapper','pattern-learner','knowledge-base','researcher','tech-advisor','cost-analyzer','competitor-analyzer','risk-assessor','estimator','ethics-bias','code-quality','documentation','accessibility','compatibility','error-handling','task-planner','task-coordinator','file-manager','git-agent','search-agent','reporter','automation'],
        },
        task: { type: 'string', description: 'The task for the agent to plan.' },
        context: { type: 'string', description: 'Optional additional context.' },
        project_dir: { type: 'string', description: 'Optional: absolute path to the project directory. Auto-injects package.json, git diff, and stack info into the agent context.' },
      },
      required: ['agent', 'task'],
    },
  },
  {
    name: 'veto_execute_parallel',
    description: 'Runs multiple worker agents simultaneously via Promise.all. Use to get domain expert input from several agents in one round-trip — e.g. coder + tester + security-scanner all planning the same feature together.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'List of agent tasks to run in parallel.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique ID for this task (use any string).' },
              agent: { type: 'string', description: 'Worker agent type.' },
              task: { type: 'string', description: 'Task description for this agent.' },
              code: { type: 'string', description: 'Optional code to analyze (triggers analyze() instead of plan()).' },
              context: { type: 'string', description: 'Optional additional context.' },
              project_dir: { type: 'string', description: 'Optional: per-task project dir override.' },
            },
            required: ['id', 'agent', 'task'],
          },
        },
        project_dir: { type: 'string', description: 'Optional: project directory applied to all tasks (per-task project_dir overrides this). Auto-injects codebase context.' },
        max_tokens: {
          type: 'number',
          description: 'Optional: token budget for this parallel execution. Veto estimates combined output tokens and warns if the estimate exceeds this limit. Logged to usage_log.',
        },
        architect_model: {
          type: 'string',
          description: 'Optional: override model used for the architecture/planning phase (e.g. claude-3-7-sonnet).',
        },
        editor_model: {
          type: 'string',
          description: 'Optional: override model used for the editing/execution phase (e.g. claude-3-5-haiku).',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'veto_task_parse',
    description: 'Parses a plain-English project description or PRD into a structured task DAG with dependencies, complexity scores, priorities, and suggested agent assignments. Feeds directly into veto_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Project description, PRD, or feature brief to parse into tasks.' },
        project_dir:  { type: 'string', description: 'Optional project directory for codebase context injection.' },
        max_tasks:    { type: 'number', description: 'Maximum number of tasks to generate (default 20).' },
      },
      required: ['description'],
    },
  },
  // ── Review & Security ────────────────────────────────────────────────────────
  {
    name: 'veto_code_review',
    description: 'Runs the Code Reviewer agent on provided code. Returns scored findings (complexity, error handling, magic numbers, nesting, dead code) with severity and fixes. Pass file_path to surface findings as VS Code inline diagnostics (squiggles).',
    inputSchema: {
      type: 'object',
      properties: {
        code:      { type: 'string', description: 'The code to review.' },
        context:   { type: 'string', description: 'Optional: file name, module description, or review focus.' },
        file_path: { type: 'string', description: 'Optional: absolute path to the file being reviewed. When provided, findings are stored as VS Code inline diagnostics.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'veto_diff_review',
    description: 'Reviews a git diff — runs code review, security scan, and secrets scan in parallel across all changed files. Returns a structured verdict (pass/warn/fail), per-file findings, and a CI-ready summary. Pass diff directly or let Veto read it from project_dir automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'The git diff to review. If omitted, Veto runs git diff HEAD in project_dir.' },
        project_dir: { type: 'string', description: 'Absolute project path. Used to auto-read git diff if diff is not provided, and to inject codebase context.' },
        context: { type: 'string', description: 'Optional: PR description, ticket number, or focus area.' },
      },
      required: [],
    },
  },
  {
    name: 'veto_security_scan',
    description: 'Runs the Security Scanner (OWASP Top 10) on provided code. Returns vulnerabilities with severity, CWE/OWASP category, and remediation steps. Pass file_path to surface findings as VS Code inline diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        code:      { type: 'string', description: 'The code to scan.' },
        context:   { type: 'string', description: 'Optional: language, framework, or specific concerns.' },
        file_path: { type: 'string', description: 'Optional: absolute path to the file being scanned. When provided, findings are stored as VS Code inline diagnostics.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'veto_secrets_scan',
    description: 'Scans text or code for exposed credentials — API keys, tokens, passwords, connection strings, private keys. Returns findings with masked values and line numbers. Pass file_path to surface findings as VS Code inline diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        text:      { type: 'string', description: 'The text or code to scan for secrets.' },
        file_path: { type: 'string', description: 'Optional: absolute path to the file being scanned. When provided, findings are stored as VS Code inline diagnostics.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'veto_pr_review',
    description: 'Fetches a GitHub PR diff and runs the full Veto triple-scan (code review + security + secrets). Returns a structured verdict and ready-to-post GitHub review comments. Set GITHUB_TOKEN env var for private repos.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_url:  { type: 'string', description: 'Full GitHub PR URL. e.g. https://github.com/owner/repo/pull/123' },
        context: { type: 'string', description: 'Optional: PR description or ticket number for extra context.' },
        fail_on: { type: 'string', enum: ['warn', 'fail'], description: 'Whether WARN counts as a failure. Default: "fail".' },
      },
      required: ['pr_url'],
    },
  },
  // ── Memory & Knowledge ───────────────────────────────────────────────────────
  {
    name: 'veto_memory_store',
    description: 'Stores a knowledge entry (solution, pattern, error, reference, or decision) in the local knowledge base for retrieval across sessions. Search before storing to avoid duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Precise, searchable title. Bad: "Fixed bug". Good: "Fix: Node sqlite fails on Windows without --experimental-sqlite".' },
        content: { type: 'string', description: 'Self-contained content: problem → root cause → solution. Future agents must understand it without original context.' },
        type: {
          type: 'string',
          description: 'Entry type.',
          enum: ['solution', 'pattern', 'context', 'error', 'reference', 'decision'],
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Search tags (3–5 recommended). Examples: ["typescript", "auth", "jwt"].' },
        project_dir: { type: 'string', description: 'Absolute project path. Include for project-specific knowledge; omit for general programming knowledge.' },
        session_id: { type: 'string', description: 'Optional: associate this knowledge entry with an active session.' },
        relevance: { type: 'number', description: 'Initial relevance score 0.0–1.0 (default 1.0).' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'veto_memory_search',
    description: 'Searches the local knowledge base for entries matching a query. Call at the start of every task to find prior solutions before solving from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (full-text search on title and content).' },
        type: {
          type: 'string',
          description: 'Filter by entry type.',
          enum: ['solution', 'pattern', 'context', 'error', 'reference', 'decision'],
        },
        project_dir: { type: 'string', description: 'Filter to a specific project directory.' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'veto_memory_delete',
    description: 'Deletes a knowledge entry by ID. Use to remove stale or duplicate entries found via veto_memory_search.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The knowledge entry ID (from veto_memory_search results).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'veto_memory_export',
    description: 'Exports all local memory (sessions, knowledge, patterns, decisions, project maps) to a portable JSON file. Copy the file to another machine and run veto_memory_import there to resume work. No external services required.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: 'Where to write the export file. Defaults to ~/.veto/veto-export.json. Use a path on shared storage (Dropbox, OneDrive, USB) to make transfer easy.',
        },
      },
      required: [],
    },
  },
  {
    name: 'veto_memory_import',
    description: 'Imports memory from a JSON file exported by veto_memory_export on another machine. Merges into local SQLite using INSERT OR IGNORE — existing local rows are never overwritten. Call veto_sessions_list after import to confirm sessions arrived.',
    inputSchema: {
      type: 'object',
      properties: {
        input_path: {
          type: 'string',
          description: 'Path to the export JSON file. Defaults to ~/.veto/veto-export.json.',
        },
      },
      required: [],
    },
  },
  // ── Patterns ─────────────────────────────────────────────────────────────────
  {
    name: 'veto_pattern_store',
    description: 'Stores or updates a coding pattern observed in the codebase. Patterns are keyed by category.pattern-name and confidence increases with repeated observation.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern_key: { type: 'string', description: 'Pattern identifier in category.pattern-name format. Example: "code.async-pattern" or "naming.variable-case".' },
        pattern_val: { type: 'string', description: 'The observed pattern value. Example: "async/await with try/catch, no raw Promise chains".' },
        confidence: { type: 'number', description: 'Confidence score 0.0–1.0 (default 1.0). Increases automatically on repeated observation.' },
      },
      required: ['pattern_key', 'pattern_val'],
    },
  },
  {
    name: 'veto_patterns_list',
    description: 'Returns stored coding patterns. Filter by prefix to get patterns in a specific category (e.g. prefix="naming." for all naming conventions).',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Optional prefix filter. Example: "code." or "naming." or "testing.".' },
        limit: { type: 'number', description: 'Max patterns to return (default 20).' },
      },
      required: [],
    },
  },
  // ── Learning ──────────────────────────────────────────────────────────────────
  {
    name: 'veto_record_outcome',
    description: 'Records a task outcome (quality score) to feed the self-learning router. Call after completing any task. After 20+ outcomes, call veto_learning_apply to update tier thresholds.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', description: 'Short consistent label for the task category (e.g. "write-unit-tests", "fix-auth-bug"). Use the same label for similar tasks to enable pattern detection.' },
        complexity: { type: 'number', description: 'The complexity score from veto_route_task (0–100).' },
        model_tier: { type: 'number', description: 'The tier that was actually used (1, 2, or 3).', enum: [1, 2, 3] },
        output_quality: { type: 'number', description: 'Output quality score 0–100. 90–100=excellent, 70–89=good, 50–69=acceptable, 30–49=poor, 0–29=failed.' },
        agent: { type: 'string', description: 'The worker agent type used (optional but useful for agent performance tracking).' },
        tokens_used: { type: 'number', description: 'Approximate tokens used (optional).' },
        file_ext: { type: 'string', description: 'File extension of the primary file worked on (e.g. ".ts", ".sql", ".tsx"). Enables predictive agent routing — next time you work on the same extension, veto_route_task will recommend the best agent.' },
      },
      required: ['task_type', 'complexity', 'model_tier', 'output_quality'],
    },
  },
  {
    name: 'veto_learning_stats',
    description: 'Returns the self-learning router dashboard: tier distribution, per-agent quality stats, suggested threshold adjustments, and council insights. Use to understand how the router is performing and where to improve.',
    inputSchema: {
      type: 'object',
      properties: {
        include_agent_stats: { type: 'boolean', description: 'Include per-agent quality breakdown (default true).' },
        include_task_types: { type: 'boolean', description: 'Include per-task-type breakdown (default false, verbose).' },
        include_council_insights: { type: 'boolean', description: 'Include council decision → debugging correlation (default false).' },
      },
      required: [],
    },
  },
  {
    name: 'veto_learning_apply',
    description: 'Applies learned tier thresholds to the router based on recorded task outcomes. Requires at least 20 recorded outcomes. The router immediately uses the new thresholds on the next veto_route_task call.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // ── Project & Discovery ───────────────────────────────────────────────────────
  {
    name: 'veto_project_map_update',
    description: 'Updates the project structure map for a directory. Call after creating, deleting, or moving files. The map enables fast codebase navigation without filesystem scans.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project root.' },
        structure: { type: 'string', description: 'JSON string representing the directory tree. Example: {"src/":{"agents/":["coder.ts","reviewer.ts"],"router/":["index.ts"]}}' },
        key_modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'The 10–20 most important files with their roles. Example: ["src/server.ts (MCP entry point)", "src/router/index.ts (task router)"].',
        },
        tech_stack: {
          type: 'array',
          items: { type: 'string' },
          description: 'Frameworks and key libraries. Example: ["TypeScript", "Node.js 22", "Express", "SQLite"].',
        },
      },
      required: ['project_dir', 'structure'],
    },
  },
  {
    name: 'veto_project_map_get',
    description: 'Returns the stored project structure map for a directory. Use to navigate the codebase without scanning the filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project root.' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_discover',
    description: 'Scans a project directory and builds a rich context map: git state, tech stack, file structure, dependencies, and key config files. Stores the result in Veto memory so agents always have accurate project context. Call this once per project or after major structural changes.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project directory to scan.' },
        depth: { type: 'string', enum: ['quick', 'standard', 'full'], description: 'Scan depth. quick: git + package metadata only. standard: + file tree up to 3 levels (default). full: + contents of key config files.' },
        store: { type: 'boolean', description: 'Whether to store the discovery in Veto memory as a project map. Default: true.' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_context_status',
    description: 'Returns the context window usage for a saved session — tokens used, % of platform limit consumed, and whether to compress or hand off before the window fills.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to check.' },
      },
      required: ['session_id'],
    },
  },
  // ── Named Pipelines — curated multi-tool compositions (Phase 4.2) ─────────────
  {
    name: 'veto_full_review',
    description: 'Full pre-ship review: runs code review + security scan + secrets scan + quality analysis in parallel, then returns a combined verdict (pass/warn/fail). Use before any merge or deploy when you want richer output than veto_diff_review alone.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project. Reads git diff HEAD automatically.' },
        diff:        { type: 'string', description: 'Optional: pass a diff string directly instead of reading from project_dir.' },
        context:     { type: 'string', description: 'Optional: PR description or review context.' },
      },
      required: [],
    },
  },
  {
    name: 'veto_pre_commit',
    description: 'Pre-commit gate: runs secrets scan (hard block on any finding) + code review in parallel on staged changes. Faster than veto_full_review — tuned for commit-time validation. Returns a blocked/warn/pass verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project. Reads staged changes (git diff --cached) automatically.' },
        context:     { type: 'string', description: 'Optional: branch name or additional context.' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_new_feature',
    description: 'New feature planning pipeline: council governance → execution plan → task DAG, in sequence. Collapses 3 manual tool calls into 1. RED council verdict stops the pipeline early — do not plan what is blocked. Returns council verdict + agent plan + structured task list.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Feature description or user story.' },
        project_dir: { type: 'string', description: 'Optional: absolute path to project for context injection.' },
        context:     { type: 'string', description: 'Optional: constraints, team size, timeline, or architecture notes.' },
      },
      required: ['description'],
    },
  },
  {
    name: 'veto_delegate',
    description: 'Delegates a subtask to a specialist agent and returns only a compact summary — not the full output. Use when orchestrating multi-step work and you need an agent\'s conclusion without polluting your context with verbose output. Mirrors the "boomerang" delegation pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The specialist agent to delegate to.',
          enum: ['coder','tester','reviewer','debugger','refactor','database','api','frontend','backend','devops','performance','auth','security-scanner','documentation','task-planner','researcher','estimator','risk-assessor'],
        },
        task:        { type: 'string',  description: 'The subtask to delegate.' },
        context:     { type: 'string',  description: 'Optional context for the agent.' },
        project_dir: { type: 'string',  description: 'Optional: project directory for context injection.' },
        max_summary_tokens: { type: 'number', description: 'Max characters in the returned summary (default 500, max 2000).' },
      },
      required: ['agent_id', 'task'],
    },
  },
  {
    name: 'veto_prompt_optimizer',
    description: 'Scores a prompt for failure modes (vague role, missing output format, injection-prone, no examples) and returns a rewritten version with improvements. Zero API keys needed — uses the local agent loop.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to optimize (system or user prompt).' },
        role:   { type: 'string', description: "Optional — 'system' | 'user' (helps tailor analysis)." },
        goal:   { type: 'string', description: 'Optional — what the prompt is trying to accomplish.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'veto_sre_advisor',
    description: 'Calculates SLO error budget status (remaining %, projected exhaustion) and returns ranked reliability improvements. Error budget math is deterministic; prioritization uses the local agent loop.',
    inputSchema: {
      type: 'object',
      properties: {
        slo_target:       { type: 'number', description: 'SLO target % (e.g. 99.9).' },
        window_days:      { type: 'number', description: 'Measurement window in days (e.g. 30).' },
        downtime_minutes: { type: 'number', description: 'Total downtime minutes in the window.' },
        incidents: {
          type: 'array',
          description: 'Optional — recent incidents.',
          items: {
            type: 'object',
            properties: {
              date:             { type: 'string', description: 'ISO date of the incident.' },
              duration_minutes: { type: 'number', description: 'Duration of the incident in minutes.' },
              description:      { type: 'string', description: 'Short description of the incident.' },
            },
          },
        },
        service_name: { type: 'string', description: 'Optional — name of the service.' },
      },
      required: ['slo_target', 'window_days', 'downtime_minutes'],
    },
  },
  {
    name: 'veto_diagram',
    description: "Generates a Mermaid architecture diagram of the project. Returns diagram text ready to paste into GitHub, Notion, or any Mermaid renderer.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir:  { type: 'string', description: 'Absolute path to project.' },
        diagram_type: { type: 'string', description: "Diagram type: 'flowchart' | 'classDiagram' | 'sequenceDiagram' | 'C4Context' (default: 'flowchart')." },
        focus:        { type: 'string', description: "Optional — what to focus on (e.g. 'data flow', 'auth', 'API')." },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_adr',
    description: 'Converts a veto_council_debate result into a MADR-format Architecture Decision Record (ADR). Writes to docs/decisions/NNNN-<slug>.md if project_dir is provided. Returns the ADR markdown content.',
    inputSchema: {
      type: 'object',
      properties: {
        task:         { type: 'string', description: 'The decision/task that was debated.' },
        verdict:      { type: 'string', description: 'Council verdict: GREEN/YELLOW/RED/DEADLOCK.' },
        recommended:  { type: 'string', description: 'The recommended approach from the council.' },
        rationale:    { type: 'string', description: 'Optional additional rationale or context.' },
        consequences: { type: 'string', description: 'Optional known consequences of this decision.' },
        project_dir:  { type: 'string', description: 'Optional path to write the ADR file.' },
        outcome_id:   { type: 'string', description: 'Optional council outcome_id for reference.' },
      },
      required: ['task', 'verdict', 'recommended'],
    },
  },
  {
    name: 'veto_env_setup',
    description: 'Analyzes project config files (package.json, requirements.txt, .env, etc.) and generates a .env.example with all required environment variables, plus a step-by-step setup guide.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir:  { type: 'string', description: 'Absolute path to project.' },
        write_files:  { type: 'boolean', description: 'If true, write .env.example to disk (default false).' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_commit_message',
    description: 'Generates a conventional-commit message from staged changes (git diff --cached). Returns type, scope, subject, and body following the Conventional Commits specification.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the git repository.' },
        hint:        { type: 'string', description: 'Optional extra context for the commit (ticket number, motivation, etc.).' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_pr_description',
    description: "Generates a complete GitHub PR description (title, summary, change list, test plan, breaking changes) from git diff main...HEAD. Ready to paste into GitHub or post via veto_pr_post.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir:  { type: 'string', description: 'Absolute path to the git repository.' },
        base_branch:  { type: 'string', description: "Branch to diff against (default: 'main')." },
        title:        { type: 'string', description: 'Optional PR title hint.' },
        context:      { type: 'string', description: 'Optional: ticket number, description, or motivation.' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_pr_post',
    description: 'Posts veto_pr_review or veto_diff_review findings directly to a GitHub PR as review comments. Requires GITHUB_TOKEN environment variable. Returns the review URL.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: {
          type: 'string',
          description: 'GitHub PR URL: https://github.com/owner/repo/pull/123',
        },
        findings: {
          type: 'array',
          description: 'Findings from veto_pr_review or veto_diff_review.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', description: "Severity: 'critical' | 'high' | 'medium' | 'low'" },
              message:  { type: 'string', description: 'Finding message.' },
              location: { type: 'string', description: 'Optional file:line hint.' },
            },
            required: ['severity', 'message'],
          },
        },
        body:  { type: 'string', description: 'Optional overall review summary posted as top-level comment.' },
        event: { type: 'string', description: "Review event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' (default: 'COMMENT')." },
      },
      required: ['pr_url', 'findings'],
    },
  },
  {
    name: 'veto_debt_register',
    description: 'Analyzes code quality + git commit frequency to produce a ranked technical debt register. High-churn + low-quality files are highest priority. Returns a prioritized list with debt type, location, and suggested agent.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project.' },
        max_files:   { type: 'number', description: 'Max files to analyze (default 10, max 30).' },
        extensions:  {
          type: 'array',
          description: "File extensions to scan (default: ['.ts','.js','.py','.go']).",
          items: { type: 'string' },
        },
      },
      required: ['project_dir'],
    },
  },
  // ── Documentation & Quality ──────────────────────────────────────────────────
  {
    name: 'veto_doc_gen',
    description: 'Reads a source file and generates JSDoc/TSDoc/docstring comments for all public APIs. Returns the annotated file content.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to source file.' },
        style:     { type: 'string', description: "Documentation style: 'jsdoc', 'tsdoc', 'docstring', or 'auto' (default).", enum: ['jsdoc', 'tsdoc', 'docstring', 'auto'] },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'veto_type_coverage',
    description: "Scans a TypeScript project for `any`, implicit `any`, and `as any` casts. Suggests specific replacement types using surrounding code context. Flags `any` in auth/security paths as high severity.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to TypeScript project root.' },
        max_files:   { type: 'number', description: 'Max files to analyze (default 20, max 30).' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_test_gaps',
    description: 'Reads a coverage report (lcov/JSON) or scans source files to identify untested paths and suggests concrete test cases.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir:     { type: 'string', description: 'Absolute path to project root.' },
        coverage_report: { type: 'string', description: 'Optional path to coverage JSON/lcov file.' },
        source_glob:     { type: 'string', description: 'Optional glob pattern for source files (e.g. "src/**/*.ts").' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_onboard',
    description: "Generates a complete new-developer onboarding guide: setup, architecture, key files, how to run tests, first PR checklist.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project root.' },
        role:        { type: 'string', description: "Developer role focus, e.g. 'frontend', 'backend', 'fullstack'." },
      },
      required: ['project_dir'],
    },
  },
  // ── Diagnosis & Release ───────────────────────────────────────────────────────
  {
    name: 'veto_rca',
    description: 'Stack trace or error description → structured root-cause hypothesis with likely introducing commit. Combines git blame/log with debugger analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        error:       { type: 'string', description: 'Error message or stack trace to analyze.' },
        project_dir: { type: 'string', description: 'Git repo root for blame context (optional).' },
        file_hint:   { type: 'string', description: 'Suspected file path for focused git blame (optional).' },
      },
      required: ['error'],
    },
  },
  {
    name: 'veto_release_notes',
    description: "Generates user-facing release notes from merged commits since the last git tag. Rewrites dev-speak into plain English (fix: race condition → Login is now more reliable).",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the git repository.' },
        from_ref:    { type: 'string', description: 'Tag or commit to diff from (default: last tag).' },
        audience:    { type: 'string', description: "Target audience: 'user' (default) or 'developer'.", enum: ['user', 'developer'] },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_postmortem',
    description: 'Incident description + timeline → blameless postmortem with five-whys RCA, action items, and correlation with past council RED verdicts if available.',
    inputSchema: {
      type: 'object',
      properties: {
        incident:    { type: 'string', description: 'Incident description.' },
        timeline:    { type: 'string', description: 'Timeline of events (freeform, optional).' },
        project_dir: { type: 'string', description: 'Git repo root for audit log correlation (optional).' },
        service:     { type: 'string', description: 'Service or system name (optional).' },
      },
      required: ['incident'],
    },
  },
  // ── Code Intelligence (Dep / Query / Bundle / Dead-code) ─────────────────────
  {
    name: 'veto_dep_advisor',
    description: 'Parses package.json/requirements.txt/Cargo.toml lockfile, queries OSV.dev (free, no key) for known vulnerabilities, and returns a risk-ranked upgrade plan with breaking-change flags.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project directory.' },
        ecosystem:   { type: 'string', description: "Package ecosystem: 'npm', 'pypi', 'cargo', or 'auto' (default).", enum: ['npm', 'pypi', 'cargo', 'auto'] },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_query_advisor',
    description: 'Accepts a SQL query or EXPLAIN ANALYZE output + optional schema → returns rewrite suggestions, CREATE INDEX statements, N+1 detection, and index risk assessment.',
    inputSchema: {
      type: 'object',
      properties: {
        query:          { type: 'string', description: 'SQL query or EXPLAIN ANALYZE output to analyze.' },
        schema:         { type: 'string', description: 'Optional CREATE TABLE statements or schema description.' },
        explain_output: { type: 'string', description: 'Optional EXPLAIN ANALYZE output if available.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'veto_bundle_advisor',
    description: 'Accepts a webpack/Rollup/Vite stats JSON file → top 10 heaviest modules, duplicate packages, code-split candidates, and CDN externalization suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        stats_file:  { type: 'string', description: 'Absolute path to the bundle stats JSON file (webpack stats format).' },
        project_dir: { type: 'string', description: 'Optional absolute path to the project root.' },
      },
      required: ['stats_file'],
    },
  },
  {
    name: 'veto_dead_code',
    description: 'Project-scope dead code detector: unused exports, unreachable branches, stale feature flags (always-true/false constants). Returns council-governed deletion recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project root.' },
        extensions:  { type: 'array', description: "File extensions to scan (default: ['.ts','.js']).", items: { type: 'string' } },
      },
      required: ['project_dir'],
    },
  },
  // ── HITL / OpenAPI / Flag Auditor ────────────────────────────────────────────
  {
    name: 'veto_hitl_checkpoint',
    description: 'Pauses an agentic workflow and returns a structured approval-request the host AI surfaces to the user. The user\'s reply in the AI conversation provides the approval signal. Use before destructive operations, RED council verdicts, or bulk deletes.',
    inputSchema: {
      type: 'object',
      properties: {
        stage:       { type: 'string', description: 'Workflow stage name, e.g. "database-migration".' },
        context:     { type: 'string', description: 'What is about to happen and why.' },
        options:     { type: 'array', items: { type: 'string' }, description: 'Choices to present (default: [\'Approve\',\'Reject\',\'Modify\']).' },
        risk_level:  { type: 'string', description: 'Risk level of the operation.', enum: ['low', 'medium', 'high', 'critical'] },
        workflow_id: { type: 'string', description: 'ID of the parent workflow for tracking (optional).' },
      },
      required: ['stage', 'context'],
    },
  },
  {
    name: 'veto_openapi_gen',
    description: 'Reads Express/FastAPI/Hono/Fastify route files and generates an OpenAPI 3.1 spec YAML. Returns the spec as a string and optionally writes it to openapi.yaml.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'Single route file to parse (optional).' },
        project_dir: { type: 'string', description: 'Scan all route files in project (optional).' },
        framework:   { type: 'string', description: "Framework hint: 'express','fastapi','hono','fastify', or 'auto' (default).", enum: ['express', 'fastapi', 'hono', 'fastify', 'auto'] },
        write_file:  { type: 'boolean', description: 'Write openapi.yaml to project root (optional).' },
      },
      required: [],
    },
  },
  {
    name: 'veto_flag_auditor',
    description: 'SDK-agnostic feature flag auditor — detects LaunchDarkly/Unleash SDK calls AND custom if(flags.X) patterns. Classifies flags as: actively toggled / candidate for removal / orphaned.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project root.' },
        sdk:         { type: 'string', description: "SDK hint: 'launchdarkly','unleash','custom', or 'auto' (default)." },
      },
      required: ['project_dir'],
    },
  },
  // ── Workflow & CI ─────────────────────────────────────────────────────────────
  {
    name: 'veto_workflow',
    description: 'Runs a sequential agent pipeline with optional pass/fail gates between steps. Each step runs a worker agent; if a gate score is set and the step confidence falls below it, the pipeline stops. Returns per-step results plus an overall verdict (passed/partial/failed).',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered pipeline steps.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Step identifier.' },
              agent: { type: 'string', description: 'Worker agent type.' },
              task: { type: 'string', description: 'Task description for this step.' },
              code: { type: 'string', description: 'Optional code to analyze.' },
              context: { type: 'string', description: 'Optional context.' },
              gate: { type: 'number', description: 'Optional minimum confidence % (0–100) required to proceed to the next step.' },
              retry_on_fail: { type: 'boolean', description: 'If true and this step fails its gate, re-run up to max_retries times with prior failure output injected as context.' },
              max_retries: { type: 'number', description: 'Max retry attempts when retry_on_fail is true. Default 3, max 5.' },
              condition: { type: 'string', description: "Optional expression evaluated against prior step outputs. If false, this step is skipped. Example: \"security_scan.severity == 'critical'\" or \"code_review.confidence >= 70\". Supported operators: ==, !=, >=, <=, >, <, &&, ||, !" },
              dependencies: { type: 'array', description: 'Step IDs that must complete before this step runs (dag mode only).', items: { type: 'string' } },
            },
            required: ['id', 'agent', 'task'],
          },
        },
        project_dir: { type: 'string', description: 'Optional project directory — auto-injects codebase context into all steps.' },
        mode: { type: 'string', enum: ['linear', 'dag'], description: 'Execution mode. "linear" (default) runs steps sequentially. "dag" reads dependencies, runs independent steps in parallel, gates dependent steps.' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'veto_watch',
    description: 'Starts a file watcher on a project directory. Returns a watch_id. Call veto_watch_poll to collect file-change events with recommended agents. Call veto_watch_stop when done.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to the project directory to watch.' },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_watch_poll',
    description: 'Polls for file-change events from an active watcher. Returns accumulated events since last poll (events are cleared on read). Each event includes the file, recommended agent, and suggested veto tool to call.',
    inputSchema: {
      type: 'object',
      properties: {
        watch_id: { type: 'string', description: 'The watch_id returned by veto_watch.' },
      },
      required: ['watch_id'],
    },
  },
  {
    name: 'veto_watch_stop',
    description: 'Stops an active file watcher.',
    inputSchema: {
      type: 'object',
      properties: {
        watch_id: { type: 'string', description: 'The watch_id returned by veto_watch.' },
      },
      required: ['watch_id'],
    },
  },
  {
    name: 'veto_ci_gate',
    description: 'CI/CD pipeline gate. Runs code review + security scan + secrets scan on a git diff and returns a structured pass/warn/fail verdict with exit code. Ready for GitHub Actions and GitLab CI.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute project path. Veto reads git diff HEAD automatically.' },
        diff:        { type: 'string', description: 'Optional: pass a diff string directly instead of reading from project_dir.' },
        context:     { type: 'string', description: 'Optional: PR description or ticket number for context.' },
        fail_on:     { type: 'string', enum: ['warn', 'fail'], description: 'Whether WARN counts as a failure (exit code 1). Default: "fail" — only FAIL exits non-zero.' },
      },
      required: ['project_dir'],
    },
  },
  // ── Observability ─────────────────────────────────────────────────────────────
  {
    name: 'veto_usage_status',
    description: 'Live AI usage dashboard. Shows tokens consumed today, requests per platform, subscription vs API usage split, 7-day history, and warnings when approaching limits.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'veto_audit_log',
    description: 'Queryable log of every council verdict, decision, and session event. Filter by session, agent, verdict, or date. Essential for tracing what happened and why.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Filter to a specific session.' },
        verdict:    { type: 'string', description: 'Filter by council verdict (GREEN, YELLOW, RED).' },
        since:      { type: 'string', description: 'ISO date — only return events after this time.' },
        limit:      { type: 'number', description: 'Max events to return (default 20, max 100).' },
      },
      required: [],
    },
  },
  // ── Developer Tools ───────────────────────────────────────────────────────────
  {
    name: 'veto_platform_setup',
    description: 'Returns the exact MCP config and setup steps to connect a specific AI platform to this Veto server.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['claude', 'gemini', 'codex', 'copilot', 'jetbrains'], description: 'The platform to get setup instructions for.' },
        veto_server_path: { type: 'string', description: 'Absolute path to the built veto server (dist/server.js).' },
      },
      required: ['platform', 'veto_server_path'],
    },
  },
  {
    name: 'veto_plugins',
    description: 'Lists all custom agents loaded from ~/.veto/agents/. Drop a .js file there that exports plan(task, context?) to register a new agent available in veto_agent_plan and veto_execute_parallel.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'veto_docs_fetch',
    description: 'Fetches current, version-accurate documentation for any npm, PyPI, or crates.io package and returns it for injection into agent context. Eliminates hallucinated APIs. Results are cached for 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Package name (e.g. "react", "requests", "serde").' },
        ecosystem:    { type: 'string', enum: ['npm', 'pypi', 'crates'], description: 'Package ecosystem.' },
        version:      { type: 'string', description: 'Specific version. Defaults to latest.' },
        max_chars:    { type: 'number', description: 'Max characters to return (default 8000). Higher = more complete docs, more tokens.' },
      },
      required: ['package_name', 'ecosystem'],
    },
  },
  {
    name: 'veto_explain',
    description: 'Explains a file or raw text using the most appropriate expert agent. Pass file_path to explain a source file, or text to explain an error message, stack trace, or compiler output. Agent is auto-detected from file extension or content.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to explain.' },
        text:      { type: 'string', description: 'Raw text to explain — error messages, stack traces, compiler output, or any code snippet. Automatically routes to debugger agent for error-like content.' },
        depth:     { type: 'string', enum: ['overview', 'detailed', 'line-by-line'], description: 'Explanation depth. Default: overview.' },
        context:   { type: 'string', description: 'Optional focus area or context.' },
      },
      required: [],
    },
  },
  {
    name: 'veto_summarize',
    description: 'Generates a concise expert briefing of a project, directory, or file. Use at the start of a session to orient yourself on unfamiliar code. Returns bullet-point summary, key components, tech stack, and entry points. Faster and higher-level than veto_explain.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to a project directory to summarize.' },
        file_path:   { type: 'string', description: 'Absolute path to a single file to summarize. If both project_dir and file_path are given, file_path takes precedence.' },
        focus:       { type: 'string', description: 'Optional focus area: e.g. "security", "APIs", "data flow", "architecture". Narrows the summary.' },
        format:      { type: 'string', enum: ['brief', 'detailed'], description: 'brief: 4–6 bullet points (default). detailed: paragraph-level prose.' },
      },
      required: [],
    },
  },
  // ── Part 4: New Tools ────────────────────────────────────────────────────────
  {
    name: 'veto_metrics',
    description: 'Returns a usage dashboard for the current Veto installation — sessions saved, council debates, quality trend, most-used agents, and knowledge base stats. Zero cost: pure SQLite reads. Great for a weekly health check.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'veto_git_blame',
    description: 'Returns ownership and contribution history for a file or directory — total commits, contributor list with commit counts, and last-modified metadata. Uses local git history: instant, zero network.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to a project directory to analyse.' },
        file_path:   { type: 'string', description: 'Absolute path to a single file. If both are provided, file_path takes precedence.' },
      },
      required: [],
    },
  },
  {
    name: 'veto_changelog',
    description: 'Generates a structured changelog from git commits since the last tag, grouped by conventional commit type (feat, fix, refactor, etc.). Pure local git — no external calls.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir:  { type: 'string', description: 'Absolute path to the project directory. Defaults to the active project.' },
        max_entries:  { type: 'number', description: 'Maximum commits to include (default 50, max 200).' },
      },
      required: [],
    },
  },
  // ── Phase 7: Intelligence & Advanced ──────────────────────────────────────────
  {
    name: 'veto_local_llm',
    description: 'Routes a task to a local LLM (via Ollama or LM Studio) instead of a cloud provider. Useful for privacy-sensitive data or simple, repetitive tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task:     { type: 'string', description: 'The task or prompt.' },
        model:    { type: 'string', description: 'Local model name (e.g. llama3, mistral).' },
        provider: { type: 'string', enum: ['ollama', 'lmstudio'], description: 'Local provider.' }
      },
      required: ['task'],
    },
  },
  {
    name: 'veto_clone_detector',
    description: 'Scans the project for duplicated code blocks or structural clones. Returns grouped findings and refactoring suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project root.' },
        extensions:  { type: 'array', items: { type: 'string' }, description: 'File extensions to scan.' },
        min_lines:   { type: 'number', description: 'Minimum number of identical lines to flag (default 5).' }
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'veto_lint_rules',
    description: 'Analyzes project coding style and auto-generates or updates ESLint/Prettier/Ruff configurations to match current conventions.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project root.' },
        tool:        { type: 'string', enum: ['eslint', 'prettier', 'ruff'], description: 'The linting tool to configure.' }
      },
      required: ['project_dir', 'tool'],
    },
  },
  {
    name: 'veto_api_contract',
    description: 'Analyzes API endpoints and generates/verifies API contracts (e.g. OpenAPI or TypeScript types) to ensure front/back compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string', description: 'Absolute path to project root.' },
        target:      { type: 'string', enum: ['generate', 'verify'], description: 'Action to perform.' }
      },
      required: ['project_dir', 'target'],
    },
  },
  {
    name: 'veto_merge_conflict',
    description: 'Analyzes a file with git conflict markers and returns a semantically correct resolution by understanding the intent of both branches.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'Path to the file containing conflict markers.' },
        project_dir: { type: 'string', description: 'Optional project directory for context.' }
      },
      required: ['file_path'],
    },
  },
  {
    name: 'veto_translate',
    description: 'Translates text or structured i18n files (JSON/YAML) to target languages while preserving variables and formatting.',
    inputSchema: {
      type: 'object',
      properties: {
        text:         { type: 'string', description: 'Text to translate (optional if file_path provided).' },
        file_path:    { type: 'string', description: 'Path to i18n file (optional if text provided).' },
        target_langs: { type: 'array', items: { type: 'string' }, description: 'Target language codes.' }
      },
      required: ['target_langs'],
    },
  },
  {
    name: 'veto_a11y_advisor',
    description: 'Analyzes UI components (React, Vue, HTML) for accessibility (a11y) compliance (WCAG) and provides actionable fix recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'Path to the UI component file.' },
        project_dir: { type: 'string', description: 'Optional project directory context.' }
      },
      required: ['file_path'],
    },
  },
  {
    name: 'veto_session_replay',
    description: 'Replays an event stream session to restore full conversational context from a past interaction.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to replay.' },
      },
      required: ['session_id'],
    },
  },
] as const;
