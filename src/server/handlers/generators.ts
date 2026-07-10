// Single-agent generator/advisor tools: each gathers project evidence (git
// history, config files, source) and runs one expert agent to produce an
// artifact — a debt register, ADR, .env.example, optimized prompt, error-budget
// advice, Mermaid diagram, RCA, release notes, postmortem, doc comments, or an
// onboarding guide. They share the executeOne + recordOutcome + buildContextString
// shape; bodies are the verbatim switch handlers.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { recordOutcome } from '../../router/index.js';
import { runHandlerAgent, handlerAgentResponse } from '../scan-core.js';
import { getAuditLog } from '../../memory/local.js';
import { buildContextString } from '../../context/reader.js';
import type { WorkerAgentType } from '../../agents/types.js';
import type { HandlerMap } from '../registry.js';

export const generatorHandlers: HandlerMap = {
  veto_debt_register: async ({ args }) => {
    const project_dir = String(args?.project_dir ?? '').trim();
    if (!project_dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let gitLog = '';
    try {
      gitLog = execSync('git log --since=90.days --name-only --format="" --no-merges', {
        cwd: project_dir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch { /* not a git repo */ }

    const churnMap: Record<string, number> = {};
    for (const line of gitLog.split('\n').filter(Boolean)) {
      if (line.includes('.')) {
        churnMap[line.trim()] = (churnMap[line.trim()] ?? 0) + 1;
      }
    }

    const maxFiles = typeof args?.max_files === 'number' ? Math.min(args.max_files, 30) : 10;
    const extensions = Array.isArray(args?.extensions) ? args.extensions.map(String) : ['.ts', '.js', '.py', '.go', '.java'];
    const topFiles = Object.entries(churnMap)
      .filter(([f]) => extensions.some((ext: string) => f.endsWith(ext)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles)
      .map(([file, commits]) => ({ file, commits }));

    const fileContents = topFiles.map(({ file, commits }) => {
      try {
        const abs = join(project_dir, file);
        const content = readFileSync(abs, 'utf8').slice(0, 3000);
        return { file, commits, content };
      } catch { return { file, commits, content: '' }; }
    }).filter(f => f.content);

    if (fileContents.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({
        total_files_analyzed: 0,
        date_range: 'last 90 days',
        debt_items: [],
        summary: 'No eligible files found in git history for the last 90 days.',
      }, null, 2) }] };
    }

    const debtCode = fileContents
      .map(f => `=== ${f.file} (${f.commits} commits) ===\n${f.content}`)
      .join('\n\n')
      .slice(0, 8000);

    const debtRun = await runHandlerAgent('veto_debt_register', {
      id: `debt-${Date.now()}`,
      agent: 'code-quality',
      task: 'Analyze these high-churn source files for technical debt. For each file, identify: (1) the primary debt type (complexity/duplication/coupling/coverage/documentation), (2) severity (high/medium/low), (3) estimated fix effort in hours, (4) recommended agent to fix it. Rank by: high-churn × high-severity first.',
      code: debtCode,
    }, args?.agent_response);
    const debtResult = debtRun.result;

    recordOutcome('debt-register', 50, 2, 'code-quality', Math.round(debtResult.output.confidence * 100));

    const steps = debtResult.plan?.steps ?? [];
    let debtItems: Array<{
      file: string;
      churn_commits: number;
      priority: string;
      debt_type: string;
      suggested_agent: string;
      estimated_hours: number;
    }>;

    if (steps.length > 0) {
      debtItems = steps.map((step: string, i: number) => {
        const matchedFile = fileContents[i] ?? fileContents[0];
        return {
          file: matchedFile.file,
          churn_commits: matchedFile?.commits ?? 0,
          priority: i < Math.ceil(steps.length / 3) ? 'high' : i < Math.ceil(steps.length * 2 / 3) ? 'medium' : 'low',
          debt_type: 'complexity',
          suggested_agent: 'refactor',
          estimated_hours: 2,
          description: step,
        };
      });
    } else {
      debtItems = fileContents.map(f => ({
        file: f.file,
        churn_commits: f.commits,
        priority: f.commits > 20 ? 'high' : f.commits > 10 ? 'medium' : 'low',
        debt_type: 'complexity',
        suggested_agent: 'refactor',
        estimated_hours: 2,
      }));
    }

    return handlerAgentResponse({
      total_files_analyzed: fileContents.length,
      date_range: 'last 90 days',
      debt_items: debtItems,
      summary: (debtResult.plan?.approach ?? debtResult.output.recommendation ?? '').trim(),
    }, debtRun);
  },

  veto_adr: ({ args }) => {
    const task         = String(args?.task         ?? '').trim();
    const verdict      = String(args?.verdict      ?? '').trim().toUpperCase();
    const recommended  = String(args?.recommended  ?? '').trim();
    const rationale    = args?.rationale    ? String(args.rationale)    : undefined;
    const consequences = args?.consequences ? String(args.consequences) : undefined;
    const projectDir   = args?.project_dir  ? String(args.project_dir)  : undefined;
    const outcomeId    = args?.outcome_id   ? String(args.outcome_id)   : undefined;

    if (!task || !verdict || !recommended) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'task, verdict, and recommended are required.' }) }], isError: true };
    }

    const statusMap: Record<string, string> = {
      GREEN:    'Accepted',
      YELLOW:   'Accepted with reservations',
      RED:      'Rejected',
      DEADLOCK: 'Deferred',
    };
    const adrStatus  = statusMap[verdict] ?? 'Under review';
    const today      = new Date().toISOString().slice(0, 10);
    const outcomeRef = outcomeId ? ` (outcome: ${outcomeId})` : '';

    const adrContent = [
      `# ${task.slice(0, 80)}`,
      '',
      `Date: ${today}`,
      `Status: ${adrStatus}`,
      `Council verdict: ${verdict}${outcomeRef}`,
      '',
      '## Context',
      '',
      task,
      ...(rationale ? ['', rationale] : []),
      '',
      '## Decision',
      '',
      recommended,
      '',
      '## Consequences',
      '',
      consequences ?? 'Under review.',
    ].join('\n');

    let adrFilePath: string | null = null;
    if (projectDir) {
      const slug         = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const decisionsDir = join(projectDir, 'docs', 'decisions');
      let nextNum = 1;
      try {
        const files = readdirSync(decisionsDir);
        nextNum = files.filter(f => /^\d{4}-/.test(f)).length + 1;
      } catch { /* directory doesn't exist yet */ }
      const paddedNum = String(nextNum).padStart(4, '0');
      adrFilePath = join(decisionsDir, `${paddedNum}-${slug}.md`);
      mkdirSync(decisionsDir, { recursive: true });
      writeFileSync(adrFilePath, adrContent, 'utf8');
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      success:   true,
      adr:       adrContent,
      file_path: adrFilePath,
      status:    adrStatus,
    }, null, 2) }] };
  },

  veto_env_setup: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const writeFiles = args?.write_files === true;

    if (!projectDir) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    }

    const detected: string[]     = [];
    const summaryParts: string[] = [];

    // Read package.json
    const pkgPath = join(projectDir, 'package.json');
    if (existsSync(pkgPath)) {
      detected.push('node');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        summaryParts.push(`Node project: ${pkg.name ?? 'unnamed'}`);
        if (pkg.scripts && typeof pkg.scripts === 'object') {
          summaryParts.push(`Scripts: ${Object.keys(pkg.scripts as object).join(', ')}`);
        }
        if (pkg.dependencies && typeof pkg.dependencies === 'object') {
          summaryParts.push(`Dependencies: ${Object.keys(pkg.dependencies as object).slice(0, 20).join(', ')}`);
        }
      } catch { /* ignore parse errors */ }
    }

    // Read .env or .env.local
    for (const envFile of ['.env', '.env.local']) {
      const envPath = join(projectDir, envFile);
      if (existsSync(envPath)) {
        try {
          const lines = readFileSync(envPath, 'utf8').split('\n');
          const vars  = lines.filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')[0]);
          if (vars.length > 0) {
            summaryParts.push(`Existing env vars (${envFile}): ${vars.join(', ')}`);
          }
        } catch { /* ignore */ }
      }
    }

    // Note other config files
    for (const f of ['requirements.txt', 'pyproject.toml']) {
      if (existsSync(join(projectDir, f))) { detected.push('python'); summaryParts.push(`Python config found: ${f}`); }
    }
    if (existsSync(join(projectDir, 'Cargo.toml'))) {
      detected.push('rust'); summaryParts.push('Rust project found: Cargo.toml');
    }
    for (const f of ['docker-compose.yml', 'docker-compose.yaml']) {
      if (existsSync(join(projectDir, f))) { summaryParts.push(`Docker Compose found: ${f}`); }
    }

    const projectSummary = summaryParts.join('\n') || 'No configuration files found.';
    const enrichedCtx    = buildContextString(projectDir, projectSummary);
    const agentTask      = 'Generate a .env.example file for this project. List every environment variable needed with a placeholder value and a one-line comment explaining what it is. Then write a numbered setup guide (5-10 steps) for a developer setting up this project from scratch.';
    const envRun         = await runHandlerAgent('veto_env_setup', { id: 'env-setup-1', agent: 'devops', task: agentTask, context: enrichedCtx || undefined, project_dir: projectDir }, args?.agent_response);
    const envResult      = envRun.result;

    const rawOutput  = envResult.output.recommendation ?? envResult.plan?.approach ?? '';
    const envLines   = rawOutput.split('\n').filter((l: string) => /^[A-Z_]+=/.test(l));
    const envExample = envLines.length > 0 ? envLines.join('\n') : '# Add your environment variables here\n';

    let written = false;
    if (writeFiles) {
      writeFileSync(join(projectDir, '.env.example'), envExample, 'utf8');
      written = true;
    }

    return handlerAgentResponse({
      env_example: envExample,
      setup_guide: rawOutput,
      written,
      detected:    [...new Set(detected)],
    }, envRun);
  },

  veto_prompt_optimizer: async ({ args }) => {
    const rawPrompt = String(args?.prompt ?? '').trim();
    const goal      = args?.goal ? String(args.goal) : undefined;

    if (!rawPrompt) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'prompt is required.' }) }], isError: true };

    const prompt = rawPrompt.length > 8000 ? rawPrompt.slice(0, 8000) : rawPrompt;

    // Deterministic pre-scan
    const issues: Array<{ category: string; severity: string; finding: string }> = [];
    const p = prompt.toLowerCase();
    if (!p.includes('you are') && !p.includes('your role') && !p.includes('act as') && !p.includes('you\'re a')) {
      issues.push({ category: 'role', severity: 'medium', finding: 'No role definition found. Add "You are a [role]..." to anchor behavior.' });
    }
    if (!p.includes('format') && !p.includes('json') && !p.includes('markdown') && !p.includes('return') && !p.includes('output')) {
      issues.push({ category: 'output_format', severity: 'medium', finding: 'No output format specified. Specify JSON, markdown, or plain text.' });
    }
    if (/ignore (previous|prior|above|all)|disregard|forget|pretend/i.test(prompt)) {
      issues.push({ category: 'injection', severity: 'high', finding: 'Prompt may be injection-prone — contains phrases attackers commonly use.' });
    }
    if (prompt.trim().split(/\s+/).length < 20) {
      issues.push({ category: 'specificity', severity: 'low', finding: 'Prompt is very short. Add more context and constraints for better results.' });
    }

    const promptRun = await runHandlerAgent('veto_prompt_optimizer', {
      id:      'prompt-optimizer-1',
      agent:   'documentation' as WorkerAgentType,
      task:    'You are a prompt engineering expert. Analyze this prompt for failure modes: vague instructions, missing context, ambiguous outputs, injection risks, lack of examples, poor role definition. Then rewrite it to be clearer, more specific, and safer. Return: 1) A numbered list of issues found, 2) A complete rewritten version of the prompt.',
      code:    prompt,
      context: goal ? `Goal: ${goal}` : undefined,
    }, args?.agent_response);
    const result = promptRun.result;

    const quality = result.analysis?.score ?? Math.round(result.output.confidence * 100);
    recordOutcome('prompt-optimizer', 50, 2, 'documentation', quality);

    const highCount   = issues.filter(i => i.severity === 'high').length;
    const mediumCount = issues.filter(i => i.severity === 'medium').length;
    const lowCount    = issues.filter(i => i.severity === 'low').length;
    const score = Math.min(100, Math.max(0, 100 - highCount * 20 - mediumCount * 10 - lowCount * 5));

    const rewritten_prompt    = result.plan?.approach ?? result.output.recommendation ?? '';
    const improvement_summary = result.analysis?.summary ?? result.plan?.steps?.join('; ') ?? '';

    return handlerAgentResponse({
      score,
      issues,
      rewritten_prompt,
      improvement_summary,
    }, promptRun);
  },

  veto_sre_advisor: async ({ args }) => {
    const slo_target       = Number(args?.slo_target);
    const window_days      = Number(args?.window_days);
    const downtime_minutes = Number(args?.downtime_minutes);
    const service_name     = args?.service_name ? String(args.service_name) : undefined;
    const incidents        = Array.isArray(args?.incidents) ? (args.incidents as Array<{ date: string; duration_minutes: number; description: string }>) : [];

    if (!slo_target || !window_days || isNaN(downtime_minutes)) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'slo_target, window_days, and downtime_minutes are required.' }) }], isError: true };
    }

    // Deterministic error budget math
    const sloFraction        = slo_target / 100;
    const windowMinutes      = window_days * 24 * 60;
    const totalBudgetMinutes = windowMinutes * (1 - sloFraction);
    const consumedMinutes    = downtime_minutes;
    const remainingMinutes   = Math.max(0, totalBudgetMinutes - consumedMinutes);
    const remainingPct       = totalBudgetMinutes > 0 ? Math.round((remainingMinutes / totalBudgetMinutes) * 1000) / 10 : 0;
    const exhaustedAt: string | null = consumedMinutes > 0 && remainingMinutes > 0
      ? new Date(Date.now() + (remainingMinutes / consumedMinutes) * window_days * 86400_000).toISOString().slice(0, 10)
      : consumedMinutes >= totalBudgetMinutes ? 'EXHAUSTED' : null;
    const status = remainingPct > 50 ? 'healthy' : remainingPct > 20 ? 'at_risk' : remainingPct > 0 ? 'critical' : 'exhausted';

    // Build incident summary for the agent
    const incidentSummary = incidents.length > 0
      ? 'Recent incidents:\n' + incidents.map(i => `- ${i.date}: ${i.duration_minutes} min — ${i.description}`).join('\n')
      : 'No incident data provided.';

    const sreRun = await runHandlerAgent('veto_sre_advisor', {
      id:      'sre-advisor-1',
      agent:   'performance' as WorkerAgentType,
      task:    'You are an SRE advisor. Given this service\'s error budget status, suggest: 1) Top 3 reliability improvements ranked by error budget recovery potential, 2) Whether to freeze non-critical deployments, 3) Specific monitoring improvements. Be concrete and actionable.',
      context: `Service: ${service_name || 'unknown'}\nSLO: ${slo_target}%\nWindow: ${window_days} days\nBudget remaining: ${remainingPct}% (${remainingMinutes.toFixed(1)} min)\nStatus: ${status}\n${incidentSummary}`,
    }, args?.agent_response);
    const sreResult = sreRun.result;

    const recommendations = sreResult.plan?.approach ?? sreResult.output.recommendation ?? '';

    return handlerAgentResponse({
      slo_target_pct:       slo_target,
      window_days,
      total_budget_minutes: Math.round(totalBudgetMinutes * 10) / 10,
      consumed_minutes:     consumedMinutes,
      remaining_minutes:    Math.round(remainingMinutes * 10) / 10,
      remaining_pct:        remainingPct,
      status,
      projected_exhaustion: exhaustedAt,
      recommendations,
      freeze_recommended:   remainingPct < 20,
    }, sreRun);
  },

  veto_diagram: async ({ args }) => {
    const project_dir = String(args?.project_dir ?? '').trim();
    const diagramType = String(args?.diagram_type ?? 'flowchart').trim();
    const focus       = args?.focus ? String(args.focus) : undefined;

    if (!project_dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    const ctx = buildContextString(project_dir);

    let fileTree = '';
    try {
      fileTree = execSync('git ls-files --others --cached --exclude-standard', {
        cwd: project_dir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().split('\n').filter((f: string) => !f.includes('node_modules') && !f.includes('dist/')).slice(0, 60).join('\n');
    } catch { /* not a git repo */ }

    const diagramRun = await runHandlerAgent('veto_diagram', {
      id:      'diagram-1',
      agent:   'documentation' as WorkerAgentType,
      task:    `Generate a ${diagramType} Mermaid diagram of this project's architecture. Output ONLY the raw Mermaid diagram code (starting with 'flowchart TD' or similar — no markdown fences, no explanation text). Focus on: ${focus || 'overall system architecture, main modules, and data flow'}. Keep it under 30 nodes for readability.`,
      code:    fileTree.slice(0, 4000),
      context: ctx || undefined,
    }, args?.agent_response);
    const diagramResult = diagramRun.result;

    const diagramQuality = diagramResult.analysis?.score ?? Math.round(diagramResult.output.confidence * 100);
    recordOutcome('diagram', 50, 2, 'documentation', diagramQuality);

    const rawOutput = diagramResult.plan?.approach ?? diagramResult.output.recommendation ?? '';

    // Extract Mermaid block — find first line matching a known diagram type keyword
    const lines = rawOutput.split('\n');
    const startIdx = lines.findIndex((l: string) => /^(flowchart|graph|classDiagram|sequenceDiagram|C4Context|erDiagram)/.test(l.trim()));
    const mermaid = startIdx >= 0 ? lines.slice(startIdx).join('\n').trim() : rawOutput.trim();

    return handlerAgentResponse({
      diagram_type: diagramType,
      mermaid,
      render_hint: 'Paste into https://mermaid.live or a GitHub markdown code block with ```mermaid',
    }, diagramRun);
  },

  veto_rca: async ({ args }) => {
    const error      = String(args?.error ?? '').trim();
    const projectDir = args?.project_dir ? String(args.project_dir).trim() : '';
    const fileHint   = args?.file_hint   ? String(args.file_hint).trim()   : '';

    if (!error) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'error is required.' }) }], isError: true };

    const userContext = buildContextString(projectDir || undefined);

    let gitContext = '';
    try {
      const recent = execSync('git log --oneline -15', { cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      gitContext = `Recent commits:\n${recent}`;
      if (fileHint) {
        const blame = execSync(`git log --oneline -10 -- "${fileHint}"`, { cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        gitContext += `\nRecent changes to ${fileHint}:\n${blame}`;
      }
    } catch { /* not a git repo */ }

    const rcaRun = await runHandlerAgent('veto_rca', {
      id:      'rca-1',
      agent:   'debugger' as WorkerAgentType,
      task:    'Perform a structured root-cause analysis. Identify: (1) the most likely root cause, (2) the probable introducing commit or change, (3) immediate fix steps, (4) prevention recommendations.',
      code:    error.slice(0, 6000),
      context: [gitContext, userContext].filter(Boolean).join('\n') || undefined,
    }, args?.agent_response);
    const result = rcaRun.result;

    const quality = Math.round(result.output.confidence * 100);
    recordOutcome('rca', 50, 2, 'debugger', quality);

    const root_cause = result.plan?.approach?.slice(0, 200) ?? result.output.recommendation.slice(0, 200);
    const fix_steps  = result.plan?.steps?.slice(0, 5) ?? [];
    const hypothesis = result.output.recommendation;

    return handlerAgentResponse({
      root_cause,
      hypothesis,
      suspect_commits: [],
      fix_steps,
      prevention:  [],
      confidence:  quality,
    }, rcaRun);
  },

  veto_release_notes: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const audience   = String(args?.audience ?? 'user') === 'developer' ? 'developer' : 'user';

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let fromRef = args?.from_ref ? String(args.from_ref) : '';
    if (!fromRef) {
      try { fromRef = execSync('git describe --tags --abbrev=0', { cwd: projectDir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
      catch { fromRef = ''; }
    }

    const logCmd = fromRef ? `git log ${fromRef}..HEAD --oneline --no-merges` : 'git log --oneline --no-merges -30';
    let commits = '';
    try { commits = execSync(logCmd, { cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Could not read git log. Ensure project_dir is a git repository.' }) }], isError: true }; }

    if (!commits) return { content: [{ type: 'text', text: JSON.stringify({ success: true, release_notes: 'No changes since last tag.', commits_processed: 0 }) }] };

    const commitsCount = commits.split('\n').filter(Boolean).length;

    const relnotesRun = await runHandlerAgent('veto_release_notes', {
      id:    'relnotes-1',
      agent: 'documentation' as WorkerAgentType,
      task:  `Generate ${audience === 'developer' ? 'developer-facing' : 'user-facing'} release notes from these git commits. Rewrite technical commit messages into clear benefit-focused language. Group by: New Features, Improvements, Bug Fixes, Other. Each line should be one sentence describing the user benefit.`,
      code:  commits.slice(0, 4000),
    }, args?.agent_response);
    const result = relnotesRun.result;

    const release_notes = result.plan?.approach ?? result.output.recommendation;

    return handlerAgentResponse({
      release_notes,
      from_ref:          fromRef || 'HEAD~30',
      commits_processed: commitsCount,
      audience,
    }, relnotesRun);
  },

  veto_postmortem: async ({ args }) => {
    const incident   = String(args?.incident ?? '').trim();
    const timeline   = args?.timeline    ? String(args.timeline).trim()   : '';
    const projectDir = args?.project_dir ? String(args.project_dir).trim() : '';
    const service    = args?.service     ? String(args.service).trim()     : '';

    if (!incident) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'incident is required.' }) }], isError: true };

    let auditCtx = '';
    let correlatedRedVerdicts = 0;
    try {
      const log = getAuditLog({ verdict: 'RED', limit: 5 });
      if (log.length > 0) {
        correlatedRedVerdicts = log.length;
        auditCtx = `Past RED council verdicts:\n${log.map((e: { summary?: string }) => `- ${e.summary ?? ''}`).join('\n')}`;
      }
    } catch { /* ignore */ }

    const context = [
      timeline   && `Timeline:\n${timeline}`,
      service    && `Service: ${service}`,
      auditCtx   || '',
    ].filter(Boolean).join('\n\n') || undefined;

    const pmRun = await runHandlerAgent('veto_postmortem', {
      id:      'pm-1',
      agent:   'debugger' as WorkerAgentType,
      task:    'Write a blameless postmortem. Include: (1) Incident summary (2) Root cause (five-whys analysis) (3) Impact (4) Timeline of detection/response/resolution (5) Action items with owner and deadline (6) What went well (7) Prevention measures. Use a constructive tone — blame systems not people.',
      code:    incident.slice(0, 4000),
      context,
    }, args?.agent_response);
    const result = pmRun.result;

    const postmortem  = result.plan?.approach ?? result.output.recommendation;
    const root_cause  = result.output.recommendation.split(/[.!?]/)[0]?.trim() ?? '';
    const action_items = result.plan?.steps?.slice(0, 10) ?? [];

    return handlerAgentResponse({
      postmortem,
      root_cause,
      action_items,
      correlated_red_verdicts: correlatedRedVerdicts,
    }, pmRun);
  },

  veto_doc_gen: async ({ args }) => {
    const filePath = String(args?.file_path ?? '').trim();
    const styleArg = String(args?.style ?? 'auto').trim();

    if (!filePath) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'file_path is required.' }) }], isError: true };

    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (e: unknown) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Could not read file: ${(e as Error).message}` }) }], isError: true };
    }

    let detectedStyle = styleArg;
    if (styleArg === 'auto') {
      const ext = extname(filePath).toLowerCase();
      if (ext === '.ts' || ext === '.tsx') detectedStyle = 'tsdoc';
      else if (ext === '.py') detectedStyle = 'docstring';
      else detectedStyle = 'jsdoc';
    }

    const docGenRun = await runHandlerAgent('veto_doc_gen', {
      id:    'docgen-1',
      agent: 'documentation' as WorkerAgentType,
      task:  `Add ${detectedStyle} documentation comments to all public functions, classes, interfaces, and exported constants in this file. For each, add: (1) a one-line summary, (2) @param descriptions, (3) @returns description, (4) @throws if applicable. Return the COMPLETE file content with documentation added — do not truncate.`,
      code:  content.slice(0, 10000),
    }, args?.agent_response);
    const docGenResult = docGenRun.result;

    const docQuality = docGenResult.analysis?.score ?? Math.round(docGenResult.output.confidence * 100);
    recordOutcome('doc-gen', 50, 2, 'documentation', docQuality);

    const annotatedContent = docGenResult.plan?.approach ?? docGenResult.output.recommendation ?? '';
    const symbolsDocumented = (annotatedContent.match(/@param\b/g) ?? []).length;

    return handlerAgentResponse({
      file_path:          filePath,
      style:              detectedStyle,
      annotated_content:  annotatedContent,
      symbols_documented: symbolsDocumented,
    }, docGenRun);
  },

  veto_onboard: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const role       = args?.role ? String(args.role).trim() : '';

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let readme = '';
    for (const name of ['README.md', 'readme.md', 'README.txt']) {
      try { readme = readFileSync(join(projectDir, name), 'utf8').slice(0, 3000); break; } catch { /* skip */ }
    }

    const onboardRun = await runHandlerAgent('veto_onboard', {
      id:          'onboard-1',
      agent:       'documentation' as WorkerAgentType,
      task:        `Write a complete onboarding guide for a new ${role || 'fullstack'} developer joining this project. Include: (1) Setup steps (clone, install, env vars, first run), (2) Architecture overview (key directories and their purpose), (3) Key files to understand first, (4) How to run tests, (5) Development workflow, (6) First PR checklist (what to check before submitting). Be specific to this codebase.`,
      context:     [buildContextString(projectDir), readme ? `README:\n${readme}` : ''].filter(Boolean).join('\n\n') || undefined,
      project_dir: projectDir,
    }, args?.agent_response);
    const onboardResult = onboardRun.result;

    const onboardQuality = onboardResult.analysis?.score ?? Math.round(onboardResult.output.confidence * 100);
    recordOutcome('onboard', 50, 2, 'documentation', onboardQuality);

    return handlerAgentResponse({
      guide:    onboardResult.plan?.approach ?? onboardResult.output.recommendation ?? '',
      role:     role || 'fullstack',
      sections: ['Setup', 'Architecture', 'Key Files', 'Testing', 'Workflow', 'First PR'],
    }, onboardRun);
  },
};
