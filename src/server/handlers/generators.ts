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
import { executeOne } from '../../agents/executor.js';
import { getAuditLog } from '../../memory/local.js';
import { offerInvitation, invitationPayload } from '../../memory/decisions.js';
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
        windowsHide: true, cwd: project_dir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
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
      task: 'Analyze these high-churn source files for technical debt, ranked by churn × severity.',
      code: debtCode,
      deliverable: {
        description: 'Build a technical-debt register for the high-churn files shown (each is headed "=== file (N commits) ===").',
        shape: {
          items: '[{ "file": "<one of the files shown>", "debt_type": "complexity|duplication|coupling|coverage|documentation|other", "severity": "high|medium|low", "estimated_hours": <number>, "suggested_agent": "<veto agent id>", "description": "<the specific problem in this file>" }, ...]',
          summary: '"<one paragraph>"',
        },
        required: ['items'],
      },
    }, args?.agent_response);

    recordOutcome('debt-register', 50, 2, 'code-quality', debtRun.deliverable ? 80 : 50);

    // Churn is measured; everything about the debt itself comes from the LLM.
    // Before 3.7.0 every item got debt_type "complexity" and estimated_hours 2,
    // and plan steps were matched to files by list position.
    const churn = fileContents.map(f => ({ file: f.file, churn_commits: f.commits }));
    const items = Array.isArray(debtRun.deliverable?.items)
      ? (debtRun.deliverable!.items as Array<Record<string, unknown>>).map(it => ({
        ...it,
        churn_commits: churn.find(c => c.file === it.file)?.churn_commits ?? null,
      }))
      : null;

    return handlerAgentResponse({
      total_files_analyzed: fileContents.length,
      date_range: 'last 90 days',
      high_churn_files: churn,
      debt_items: items,
      summary: debtRun.deliverable?.summary ?? null,
    }, debtRun, { generated: ['debt_items', 'summary'] });
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

    // v3.3 step 1: recording a decision is the other moment to ask whether it
    // should be enforced. Keyed on outcome_id, so an ADR written from a verdict
    // the council already asked about stays silent. Deferred/unknown decided nothing.
    const invitation = ['GREEN', 'YELLOW', 'RED'].includes(verdict)
      ? offerInvitation({ source_kind: 'adr', source_id: outcomeId, project_dir: projectDir })
      : null;

    return { content: [{ type: 'text', text: JSON.stringify({
      success:   true,
      adr:       adrContent,
      file_path: adrFilePath,
      status:    adrStatus,
      ...(invitation ? { constraint_invitation: invitationPayload(invitation.id) } : {}),
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
    // Env vars the code actually reads — a fact, and the LLM's starting point.
    const referenced = new Set<string>();
    try {
      const { listProjectFiles } = await import('../worker-evidence.js');
      for (const rel of listProjectFiles(projectDir, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb'], 1500)) {
        let text = '';
        try { text = readFileSync(join(projectDir, rel), 'utf8'); } catch { continue; }
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]*)['"]|os\.Getenv\("([A-Z][A-Z0-9_]*)"\)|ENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
          referenced.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
        }
      }
    } catch { /* evidence is best-effort */ }
    const envRun = await runHandlerAgent('veto_env_setup', {
      id: 'env-setup-1',
      agent: 'devops',
      task: 'Write the .env.example and a from-scratch setup guide for this project.',
      context: [enrichedCtx, referenced.size ? `Environment variables the code reads: ${[...referenced].join(', ')}` : 'The code reads no environment variables that could be found.'].filter(Boolean).join('\n\n') || undefined,
      project_dir: projectDir,
      deliverable: {
        description: 'Write a .env.example covering every environment variable the project needs (at least those the code reads), and a numbered setup guide for a new developer.',
        shape: {
          env_example: '"<file content: one KEY=placeholder per line, each preceded by a # comment explaining it>"',
          setup_steps: '["<step>", ...] 5-10 steps, specific to this project',
        },
        required: ['env_example', 'setup_steps'],
      },
    }, args?.agent_response);

    const envExample = typeof envRun.deliverable?.env_example === 'string' ? envRun.deliverable.env_example : null;
    const examplePath = join(projectDir, '.env.example');
    // Only real content is written, and an existing file is never replaced
    // unless overwrite is asked for. Before 3.7.0, write_files with no LLM wrote
    // the placeholder "# Add your environment variables here" over whatever was there.
    let written = false;
    let write_skipped: string | null = null;
    if (writeFiles) {
      if (!envExample) write_skipped = 'nothing generated yet — complete the llm_upgrade step first';
      else if (existsSync(examplePath) && args?.overwrite !== true) write_skipped = '.env.example already exists — pass overwrite: true to replace it';
      else { writeFileSync(examplePath, envExample.endsWith('\n') ? envExample : envExample + '\n', 'utf8'); written = true; }
    }

    return handlerAgentResponse({
      env_example: envExample,
      setup_steps: envRun.deliverable?.setup_steps ?? null,
      env_vars_referenced: [...referenced].sort(),
      written,
      ...(write_skipped ? { write_skipped } : {}),
      detected:    [...new Set(detected)],
    }, envRun, { generated: ['env_example', 'setup_steps'] });
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
      task:    'Rewrite this prompt to be clearer, more specific and safer.',
      code:    prompt,
      context: [goal ? `Goal: ${goal}` : '', args?.role ? `Role the prompt is for: ${String(args.role)}` : '', issues.length ? `Deterministic checks found:\n${issues.map(i => `- [${i.severity}] ${i.finding}`).join('\n')}` : ''].filter(Boolean).join('\n\n') || undefined,
      deliverable: {
        description: 'Find the failure modes of the prompt in the material (vague instructions, missing context, ambiguous output, injection risk, no examples, weak role) and rewrite it.',
        shape: {
          rewritten_prompt: '"<the complete improved prompt>"',
          improvements: '["<what changed and why>", ...]',
        },
        required: ['rewritten_prompt'],
      },
    }, args?.agent_response);

    const highCount   = issues.filter(i => i.severity === 'high').length;
    const mediumCount = issues.filter(i => i.severity === 'medium').length;
    const lowCount    = issues.filter(i => i.severity === 'low').length;
    const score = Math.min(100, Math.max(0, 100 - highCount * 20 - mediumCount * 10 - lowCount * 5));
    recordOutcome('prompt-optimizer', 50, 2, 'documentation', score);

    return handlerAgentResponse({
      score,
      issues,
      rewritten_prompt:    promptRun.deliverable?.rewritten_prompt ?? null,
      improvements:        promptRun.deliverable?.improvements ?? null,
    }, promptRun, { generated: ['rewritten_prompt', 'improvements'] });
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
      task:    'Advise on this service\'s reliability given its error budget.',
      context: `Service: ${service_name || 'unknown'}\nSLO: ${slo_target}%\nWindow: ${window_days} days\nBudget remaining: ${remainingPct}% (${remainingMinutes.toFixed(1)} min)\nStatus: ${status}\n${incidentSummary}`,
      deliverable: {
        description: 'Given the error-budget numbers and incidents in the context, recommend what to do next.',
        shape: {
          improvements: '["<reliability improvement, ranked by budget recovered>", ...] top 3',
          freeze_non_critical_deploys: 'true|false',
          freeze_reason: '"<why>"',
          monitoring: '["<specific alert or dashboard to add>", ...]',
        },
        required: ['improvements'],
      },
    }, args?.agent_response);

    return handlerAgentResponse({
      slo_target_pct:       slo_target,
      window_days,
      total_budget_minutes: Math.round(totalBudgetMinutes * 10) / 10,
      consumed_minutes:     consumedMinutes,
      remaining_minutes:    Math.round(remainingMinutes * 10) / 10,
      remaining_pct:        remainingPct,
      status,
      projected_exhaustion: exhaustedAt,
      // A fixed rule on the numbers above, not advice: under 20% left.
      budget_rule_says_freeze: remainingPct < 20,
      improvements:         sreRun.deliverable?.improvements ?? null,
      freeze_non_critical_deploys: sreRun.deliverable?.freeze_non_critical_deploys ?? null,
      freeze_reason:        sreRun.deliverable?.freeze_reason ?? null,
      monitoring:           sreRun.deliverable?.monitoring ?? null,
    }, sreRun, { generated: ['improvements', 'freeze_non_critical_deploys', 'freeze_reason', 'monitoring'] });
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
        windowsHide: true, cwd: project_dir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().split('\n').filter((f: string) => !f.includes('node_modules') && !f.includes('dist/')).slice(0, 60).join('\n');
    } catch { /* not a git repo */ }

    if (!fileTree) {
      try { const { listProjectFiles } = await import('../worker-evidence.js'); fileTree = listProjectFiles(project_dir).slice(0, 80).join('\n'); } catch { /* none */ }
    }

    const diagramRun = await runHandlerAgent('veto_diagram', {
      id:      'diagram-1',
      agent:   'documentation' as WorkerAgentType,
      task:    `Draw a ${diagramType} Mermaid diagram of this project. Focus on: ${focus || 'overall system architecture, main modules, and data flow'}.`,
      code:    fileTree.slice(0, 4000),
      context: ctx || undefined,
      deliverable: {
        description: `Draw a Mermaid ${diagramType} diagram of the project whose file list is the material. Under 30 nodes. Use only modules that exist in the file list.`,
        shape: { mermaid: '"<raw Mermaid source starting with the diagram keyword, e.g. flowchart TD — no ``` fences>"' },
        required: ['mermaid'],
      },
    }, args?.agent_response);

    let mermaid = typeof diagramRun.deliverable?.mermaid === 'string' ? diagramRun.deliverable.mermaid.replace(/^```(?:mermaid)?\s*|```\s*$/g, '').trim() : null;
    const MERMAID_START = /^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram(-v2)?|erDiagram|C4Context|C4Container|C4Component|journey|gantt|mindmap|timeline|gitGraph|pie|quadrantChart|block-beta|architecture-beta)\b/;
    const mermaid_valid = mermaid ? MERMAID_START.test(mermaid) : null;
    if (mermaid && !mermaid_valid) mermaid = null;
    recordOutcome('diagram', 50, 2, 'documentation', mermaid ? 80 : 40);

    return handlerAgentResponse({
      diagram_type: diagramType,
      mermaid,
      ...(mermaid_valid === false ? { problem: 'The generated text did not start with a Mermaid diagram keyword, so it was not returned as a diagram. Ask again.' } : {}),
      render_hint: 'Paste into https://mermaid.live or a GitHub markdown code block with ```mermaid',
    }, diagramRun, { generated: ['mermaid'] });
  },

  veto_rca: async ({ args }) => {
    const error      = String(args?.error ?? '').trim();
    const projectDir = args?.project_dir ? String(args.project_dir).trim() : '';
    const fileHint   = args?.file_hint   ? String(args.file_hint).trim()   : '';

    if (!error) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'error is required.' }) }], isError: true };

    const userContext = buildContextString(projectDir || undefined);

    let gitContext = '';
    try {
      const recent = execSync('git log --oneline -15', { windowsHide: true, cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      gitContext = `Recent commits:\n${recent}`;
      if (fileHint) {
        const blame = execSync(`git log --oneline -10 -- "${fileHint}"`, { windowsHide: true, cwd: projectDir || undefined, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        gitContext += `\nRecent changes to ${fileHint}:\n${blame}`;
      }
    } catch { /* not a git repo */ }

    // The lines the stack trace points at, read from disk — the most useful
    // evidence there is, and never gathered before 3.7.0.
    const locations: Array<{ file: string; line: number; snippet: string }> = [];
    if (projectDir) {
      const seen = new Set<string>();
      for (const m of error.matchAll(/([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs|php|cs)):(\d+)/g)) {
        const key = `${m[1]}:${m[2]}`;
        if (seen.has(key) || locations.length >= 5) continue;
        seen.add(key);
        const lineNo = Number(m[2]);
        for (const candidate of [join(projectDir, m[1]), m[1]]) {
          try {
            const lines = readFileSync(candidate, 'utf8').split(/\r?\n/);
            const from = Math.max(0, lineNo - 6);
            const snippet = lines.slice(from, lineNo + 5).map((l, i) => `${from + i + 1}${from + i + 1 === lineNo ? '>' : ' '} ${l}`).join('\n');
            locations.push({ file: m[1], line: lineNo, snippet });
            break;
          } catch { /* try the next spelling */ }
        }
      }
    }

    const rcaRun = await runHandlerAgent('veto_rca', {
      id:      'rca-1',
      agent:   'debugger' as WorkerAgentType,
      task:    'Perform a structured root-cause analysis of this error.',
      code:    error.slice(0, 6000),
      context: [gitContext, locations.length ? `Code at the stack-trace locations:\n${locations.map(l => `=== ${l.file}:${l.line} ===\n${l.snippet}`).join('\n\n')}` : '', userContext].filter(Boolean).join('\n\n') || undefined,
      deliverable: {
        description: 'Find the root cause of the error in the material, using the code at the stack-trace locations and the recent commits in the context.',
        shape: {
          root_cause: '"<the specific cause, naming the file/line/variable>"',
          hypothesis: '"<how the failure happens, step by step>"',
          suspect_commits: '["<hash — why>", ...] from the commits listed, or []',
          fix_steps: '["<concrete step>", ...]',
          prevention: '["<test, type or check that stops it recurring>", ...]',
          confidence: '<0-100: how sure you are, given the evidence>',
        },
        required: ['root_cause', 'fix_steps'],
      },
    }, args?.agent_response);

    const d = rcaRun.deliverable;
    recordOutcome('rca', 50, 2, 'debugger', typeof d?.confidence === 'number' ? d.confidence : 50);

    return handlerAgentResponse({
      stack_locations: locations.map(l => ({ file: l.file, line: l.line })),
      root_cause:      d?.root_cause ?? null,
      hypothesis:      d?.hypothesis ?? null,
      suspect_commits: d?.suspect_commits ?? null,
      fix_steps:       d?.fix_steps ?? null,
      prevention:      d?.prevention ?? null,
      confidence:      d?.confidence ?? null,
    }, rcaRun, { generated: ['root_cause', 'hypothesis', 'suspect_commits', 'fix_steps', 'prevention', 'confidence'] });
  },

  veto_release_notes: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const audience   = String(args?.audience ?? 'user') === 'developer' ? 'developer' : 'user';

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let fromRef = args?.from_ref ? String(args.from_ref) : '';
    if (!fromRef) {
      try { fromRef = execSync('git describe --tags --abbrev=0', { windowsHide: true, cwd: projectDir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
      catch { fromRef = ''; }
    }

    const logCmd = fromRef ? `git log ${fromRef}..HEAD --oneline --no-merges` : 'git log --oneline --no-merges -30';
    let commits = '';
    try { commits = execSync(logCmd, { windowsHide: true, cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Could not read git log. Ensure project_dir is a git repository.' }) }], isError: true }; }

    if (!commits) return { content: [{ type: 'text', text: JSON.stringify({ success: true, release_notes: 'No changes since last tag.', commits_processed: 0 }) }] };

    const commitsCount = commits.split('\n').filter(Boolean).length;

    const relnotesRun = await runHandlerAgent('veto_release_notes', {
      id:    'relnotes-1',
      agent: 'documentation' as WorkerAgentType,
      task:  `Write ${audience === 'developer' ? 'developer-facing' : 'user-facing'} release notes from these commits.`,
      code:  commits.slice(0, 4000),
      deliverable: {
        description: `Write ${audience === 'developer' ? 'developer-facing' : 'user-facing'} release notes from the commits in the material. Group under New Features, Improvements, Bug Fixes, Other (omit empty groups). One sentence per line describing the benefit. Mention only what the commits show.`,
        shape: { release_notes: '"<markdown>"' },
        required: ['release_notes'],
      },
    }, args?.agent_response);

    return handlerAgentResponse({
      release_notes:     relnotesRun.deliverable?.release_notes ?? null,
      range:             fromRef ? `${fromRef}..HEAD` : 'last 30 commits (no tag found)',
      commits_processed: commitsCount,
      commits:           commits.split('\n').filter(Boolean),
      audience,
    }, relnotesRun, { generated: ['release_notes'] });
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
      task:    'Write a blameless postmortem for this incident.',
      code:    incident.slice(0, 4000),
      context,
      deliverable: {
        description: 'Write a blameless postmortem of the incident in the material: summary, root cause (five whys), impact, timeline of detection/response/resolution, what went well, prevention. Blame systems, not people. Use only facts given; mark anything assumed.',
        shape: {
          postmortem: '"<markdown document>"',
          root_cause: '"<one sentence>"',
          action_items: '[{ "action": "...", "owner": "<role>", "due": "<relative deadline>" }, ...]',
        },
        required: ['postmortem', 'root_cause'],
      },
    }, args?.agent_response);

    return handlerAgentResponse({
      postmortem:   pmRun.deliverable?.postmortem ?? null,
      root_cause:   pmRun.deliverable?.root_cause ?? null,
      action_items: pmRun.deliverable?.action_items ?? null,
      // The latest RED council verdicts, shown to the LLM as context. A count,
      // not a correlation — the old name "correlated_red_verdicts" overstated it.
      recent_red_council_verdicts: correlatedRedVerdicts,
    }, pmRun, { generated: ['postmortem', 'root_cause', 'action_items'] });
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

    // The whole file goes back to the caller, so it must go in whole: a file cut
    // short here would come back cut short, and writing it would lose the rest.
    const DOC_GEN_MAX = 60_000;
    if (content.length > DOC_GEN_MAX) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `File is ${content.length} characters; veto_doc_gen rewrites whole files up to ${DOC_GEN_MAX}. Split it, or document it in parts.` }) }], isError: true };
    }

    // Which symbols lack docs — a deterministic fact, with or without an LLM.
    const gaps = await executeOne({ id: 'docgen-gaps', agent: 'documentation' as WorkerAgentType, task: 'Find undocumented public symbols.', code: content, llm_backed: false });

    const docGenRun = await runHandlerAgent('veto_doc_gen', {
      id:    'docgen-1',
      agent: 'documentation' as WorkerAgentType,
      task:  `Add ${detectedStyle} documentation comments to this file.`,
      code:  content,
      deliverable: {
        description: `Add ${detectedStyle} documentation comments to every public function, class, interface and exported constant in the file: a one-line summary, @param for each parameter, @returns, and @throws where it can throw. Change nothing else — not code, not formatting.`,
        shape: { annotated_content: '"<the COMPLETE file with documentation added, nothing removed>"' },
        required: ['annotated_content'],
        max_tokens: 16000,
      },
    }, args?.agent_response);

    let annotated = typeof docGenRun.deliverable?.annotated_content === 'string' ? docGenRun.deliverable.annotated_content : null;
    // A result that lost code is worse than none: every original non-blank
    // line must still be there.
    let problem: string | null = null;
    if (annotated) {
      const keep = new Set(annotated.split(/\r?\n/).map(l => l.trim()));
      const lost = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !keep.has(l));
      if (lost.length) {
        problem = `The generated file dropped or changed ${lost.length} line(s) of the original (first: "${lost[0].slice(0, 80)}"), so it was not returned.`;
        annotated = null;
      }
    }
    recordOutcome('doc-gen', 50, 2, 'documentation', annotated ? 80 : 40);

    return handlerAgentResponse({
      file_path:          filePath,
      style:              detectedStyle,
      documentation_gaps: gaps.analysis?.findings ?? [],
      annotated_content:  annotated,
      symbols_documented: annotated ? (annotated.match(/@param\b|@returns?\b/g) ?? []).length : null,
      ...(problem ? { problem } : {}),
    }, docGenRun, { generated: ['annotated_content', 'symbols_documented'] });
  },

  veto_onboard: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const role       = args?.role ? String(args.role).trim() : '';

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let readme = '';
    for (const name of ['README.md', 'readme.md', 'README.txt']) {
      try { readme = readFileSync(join(projectDir, name), 'utf8').slice(0, 3000); break; } catch { /* skip */ }
    }

    const { projectDigest } = await import('../worker-evidence.js');
    const onboardRun = await runHandlerAgent('veto_onboard', {
      id:          'onboard-1',
      agent:       'documentation' as WorkerAgentType,
      task:        `Write an onboarding guide for a new ${role || 'fullstack'} developer joining this project.`,
      context:     [buildContextString(projectDir), projectDigest(projectDir), readme ? `README:\n${readme}` : ''].filter(Boolean).join('\n\n') || undefined,
      project_dir: projectDir,
      deliverable: {
        description: `Write an onboarding guide for a new ${role || 'fullstack'} developer, specific to this codebase: setup (clone, install, env vars, first run), architecture (key directories and their purpose), key files to read first, running tests, development workflow, first-PR checklist. Use only commands, files and scripts that appear in the context.`,
        shape: { guide: '"<markdown with one ## section per topic>"' },
        required: ['guide'],
      },
    }, args?.agent_response);
    recordOutcome('onboard', 50, 2, 'documentation', onboardRun.deliverable ? 80 : 40);

    return handlerAgentResponse({
      guide:    onboardRun.deliverable?.guide ?? null,
      role:     role || 'fullstack',
      readme_found: Boolean(readme),
    }, onboardRun, { generated: ['guide'] });
  },
};
