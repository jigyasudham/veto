// Single-purpose advisory tools that scan a project (deps, SQL, bundle stats,
// dead code, feature flags, API routes) and run one expert agent over the
// gathered evidence, recording the outcome for router learning. Plus the
// human-in-the-loop checkpoint, which is pure formatting. They share the
// executeOne + recordOutcome shape but each gathers evidence differently.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { executeOne } from '../../agents/executor.js';
import { recordOutcome } from '../../router/index.js';
import { buildContextString } from '../../context/reader.js';
import type { WorkerAgentType } from '../../agents/types.js';
import type { HandlerMap } from '../registry.js';
import { verifyPackages, type Ecosystem } from '../../agents/security/dep-verify.js';
import { getSessionReplay, listSessions } from '../../memory/local.js';
import { autoSave } from '../runtime.js';

export const advisorHandlers: HandlerMap = {
  veto_dep_verify: async ({ args }) => {
    const names = Array.isArray(args?.packages) ? args.packages.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
    if (names.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'packages (non-empty array of names) is required.' }) }], isError: true };
    }
    if (names.length > 30) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Max 30 packages per call.' }) }], isError: true };
    }
    const eco = String(args?.ecosystem ?? 'npm') as Ecosystem;
    if (!['npm', 'pypi', 'crates'].includes(eco)) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: "ecosystem must be 'npm', 'pypi', or 'crates'." }) }], isError: true };
    }

    const results = await verifyPackages(names, eco);
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;

    const worst =
      results.some(r => r.verdict === 'not_found' || r.verdict === 'high_risk') ? 'BLOCK' :
      results.some(r => r.verdict === 'caution' || r.verdict === 'unverifiable') ? 'REVIEW' : 'CLEAR';
    const guidance =
      worst === 'BLOCK' ? 'Do not install the flagged packages. not_found = likely hallucinated name (and a slopsquatting target); high_risk = squat-profile package.' :
      worst === 'REVIEW' ? 'Installable, but review the flagged signals first.' :
      'All packages verified against the registry.';

    recordOutcome('dep_verify', 40, 2, 'dependency-audit', results.some(r => r.verdict === 'unverifiable') ? 60 : 90);

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ecosystem: eco, overall: worst, guidance, counts, results }, null, 2) }] };
  },

  veto_dep_advisor: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    let ecosystem = String(args?.ecosystem ?? 'auto');
    let packages: Array<{ name: string; version: string }> = [];

    // Try npm first
    if (ecosystem === 'auto' || ecosystem === 'npm') {
      try {
        const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        packages = Object.entries(deps).map(([name, ver]) => ({ name, version: String(ver).replace(/[\^~>=<]/g, '').split('.')[0] + '.0.0' })).slice(0, 50);
        ecosystem = 'npm';
      } catch { /* try next */ }
    }
    if ((ecosystem === 'auto' || ecosystem === 'pypi') && packages.length === 0) {
      try {
        const req = readFileSync(join(projectDir, 'requirements.txt'), 'utf8');
        packages = req.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => { const [name, ver='0.0.0'] = l.split(/[==>=<]/); return { name: name.trim(), version: ver.trim() || '0.0.0' }; }).slice(0, 50);
        ecosystem = 'pypi';
      } catch { /* skip */ }
    }
    if (packages.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No package.json or requirements.txt found in project_dir.' }) }], isError: true };

    let vulnerabilities: Array<{ package: string; version: string; vuln_id: string; severity: string; summary: string }> = [];
    let osvAvailable = false;
    try {
      const osvEcosystem = ecosystem === 'npm' ? 'npm' : ecosystem === 'pypi' ? 'PyPI' : 'crates.io';
      const body = { queries: packages.slice(0, 30).map(p => ({ package: { name: p.name, ecosystem: osvEcosystem }, version: p.version })) };
      const resp = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json() as { results: Array<{ vulns?: Array<{ id: string; summary: string; database_specific?: { severity?: string } }> }> };
        data.results.forEach((r, i) => {
          for (const v of (r.vulns ?? [])) {
            vulnerabilities.push({ package: packages[i].name, version: packages[i].version, vuln_id: v.id, severity: v.database_specific?.severity?.toLowerCase() ?? 'unknown', summary: v.summary });
          }
        });
        osvAvailable = true;
      }
    } catch { /* OSV unavailable — proceed without vuln data */ }

    const depResult = await executeOne({
      id: 'dep-1',
      agent: 'dependency-audit',
      task: 'Analyze these dependencies and produce a risk-ranked upgrade plan. For each vulnerable or outdated package: (1) risk level, (2) recommended version, (3) breaking-change risk, (4) migration steps.',
      code: JSON.stringify({ packages: packages.slice(0, 20), vulnerabilities }, null, 2).slice(0, 6000),
    });

    recordOutcome('dep_advisor', 50, 2, 'dependency-audit', depResult.analysis?.score ?? Math.round(depResult.output.confidence * 100));

    return { content: [{ type: 'text', text: JSON.stringify({
      ecosystem,
      packages_scanned:    packages.length,
      vulnerabilities_found: vulnerabilities.length,
      vulns:               vulnerabilities,
      upgrade_plan:        depResult.plan?.approach ?? depResult.output.recommendation ?? '',
      osv_available:       osvAvailable,
    }, null, 2) }] };
  },

  veto_query_advisor: async ({ args }) => {
    const query         = String(args?.query ?? '').trim();
    const schema        = args?.schema         ? String(args.schema).trim()         : '';
    const explainOutput = args?.explain_output ? String(args.explain_output).trim() : '';

    if (!query) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'query is required.' }) }], isError: true };

    // Deterministic pre-scan for common issues
    const issues: string[] = [];
    const q = query.toLowerCase();
    if (/select \*/i.test(query)) issues.push('SELECT * detected — specify only needed columns');
    if (/where.*like\s+'%/i.test(query)) issues.push('Leading wildcard LIKE pattern prevents index use');
    if (!q.includes('limit') && (q.includes('select') && !q.includes('count'))) issues.push('No LIMIT clause — could return unbounded result set');
    const joinCount = (q.match(/\bjoin\b/g) ?? []).length;
    if (joinCount > 4) issues.push(`${joinCount} JOINs detected — verify indexes on join columns`);

    const queryResult = await executeOne({
      id: 'query-1',
      agent: 'database',
      task: 'Analyze this SQL query for performance issues. Provide: (1) Rewritten optimized query, (2) Specific CREATE INDEX statements needed, (3) N+1 query detection if this is part of a loop, (4) Estimated improvement percentage, (5) Index risk assessment (will this lock the table?)',
      code: query.slice(0, 4000),
      context: [schema && `Schema:\n${schema}`, explainOutput && `EXPLAIN:\n${explainOutput}`].filter(Boolean).join('\n'),
    });

    recordOutcome('query_advisor', 50, 2, 'database', queryResult.analysis?.score ?? Math.round(queryResult.output.confidence * 100));

    const agentOutput = queryResult.plan?.approach ?? queryResult.output.recommendation ?? '';
    const indexStatements = agentOutput.split('\n').filter((l: string) => /CREATE INDEX/i.test(l)).map((l: string) => l.trim());

    return { content: [{ type: 'text', text: JSON.stringify({
      issues_detected:      issues,
      optimized_query:      '',
      index_statements:     indexStatements,
      n_plus_one_risk:      /n\+1|n \+ 1/i.test(agentOutput),
      recommendations:      agentOutput,
      estimated_improvement: '',
    }, null, 2) }] };
  },

  veto_bundle_advisor: async ({ args }) => {
    let statsRaw = '';
    try { statsRaw = readFileSync(String(args?.stats_file ?? ''), 'utf8'); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read stats file: ${e}` }) }], isError: true }; }
    let statsData: Record<string, unknown> = {};
    try { statsData = JSON.parse(statsRaw); } catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stats_file is not valid JSON' }) }], isError: true }; }

    // Extract key metrics from webpack stats format
    const assets = ((statsData.assets as Array<{ name: string; size: number }>) ?? []).sort((a, b) => b.size - a.size).slice(0, 20);
    const totalSize = assets.reduce((s, a) => s + (a.size ?? 0), 0);
    const summary = JSON.stringify({
      total_assets: assets.length,
      total_size_kb: Math.round(totalSize / 1024),
      top_assets: assets.slice(0, 10).map(a => ({ name: a.name, size_kb: Math.round(a.size / 1024) })),
    }, null, 2);

    const bundleResult = await executeOne({
      id: 'bundle-1',
      agent: 'frontend',
      task: 'Analyze this bundle stats and provide: (1) Top 10 heaviest modules to target, (2) Duplicate packages to deduplicate, (3) Code-split candidates (lazy-loadable routes or heavy features), (4) Packages safe to move to CDN externals (React, lodash, etc.), (5) Estimated size reduction achievable.',
      code: summary,
    });

    recordOutcome('bundle_advisor', 50, 2, 'frontend', bundleResult.analysis?.score ?? Math.round(bundleResult.output.confidence * 100));

    return { content: [{ type: 'text', text: JSON.stringify({
      total_size_kb:        Math.round(totalSize / 1024),
      assets_analyzed:      assets.length,
      heaviest_modules:     assets.slice(0, 10).map(a => ({ name: a.name, size_kb: Math.round(a.size / 1024) })),
      recommendations:      bundleResult.plan?.approach ?? bundleResult.output.recommendation ?? '',
      estimated_reduction_pct: 0,
    }, null, 2) }] };
  },

  veto_dead_code: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const exts = Array.isArray(args?.extensions) ? (args.extensions as unknown[]).map(String) : ['.ts', '.js'];
    const includeArgs = exts.map(e => `--include="*${e}"`).join(' ');

    const patterns: Array<{ label: string; regex: string }> = [
      { label: 'exported but possibly unused', regex: 'export (function|const|class|interface|type)' },
      { label: 'TODO/FIXME markers',           regex: '// (TODO|FIXME|HACK|XXX)' },
      { label: 'feature flag patterns',         regex: 'if.*flags?\\.\\w+|if.*feature.*enabled|if.*isEnabled' },
      { label: 'commented-out code blocks',     regex: '^\\/\\/' },
    ];
    let findings = '';
    for (const { label, regex } of patterns) {
      try {
        const out = execSync(`git grep -rn "${regex}" ${includeArgs} -- . ":(exclude)node_modules" ":(exclude)dist"`, { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        const lines = out.split('\n').filter(Boolean).slice(0, 20);
        if (lines.length > 0) findings += `\n=== ${label} (${lines.length} found) ===\n${lines.join('\n')}`;
      } catch { /* no matches — git grep exits 1 */ }
    }
    if (!findings) return { content: [{ type: 'text', text: JSON.stringify({ success: true, dead_code_items: [], summary: 'No dead code patterns detected.' }) }] };

    const ctx = buildContextString(projectDir);
    const deadResult = await executeOne({
      id: 'dead-1',
      agent: 'code-quality',
      task: 'Identify dead code and safe deletion candidates from these patterns. For each item: (1) is it actually dead/unused?, (2) safe to delete?, (3) deletion risk (high/medium/low). Focus on exports with zero imports, always-true/false flags, and commented blocks older than 6 months.',
      code: findings.slice(0, 6000),
      context: ctx || undefined,
    });

    recordOutcome('dead_code', 50, 2, 'code-quality', deadResult.analysis?.score ?? Math.round(deadResult.output.confidence * 100));

    const agentOut = deadResult.plan?.approach ?? deadResult.output.recommendation ?? '';
    const safeMatches = agentOut.match(/\blow\b.*\bdelete\b|\bsafe to delete\b|\bsafely removed\b/gi) ?? [];

    return { content: [{ type: 'text', text: JSON.stringify({
      dead_code_items:  [],
      total_found:      findings.split('\n').filter(l => l.startsWith('===')).length,
      safe_to_delete:   safeMatches.length,
      recommendations:  agentOut,
      council_note:     'Run veto_council_debate before deleting any exports to check downstream impact.',
    }, null, 2) }] };
  },

  veto_hitl_checkpoint: ({ args }) => {
    const stage      = String(args?.stage ?? '').trim();
    const context    = String(args?.context ?? '').trim();
    const riskLevel  = String(args?.risk_level ?? 'medium');
    const workflowId = args?.workflow_id ? String(args.workflow_id) : null;
    const options: string[] = Array.isArray(args?.options) ? (args.options as unknown[]).map(String) : ['Approve', 'Reject', 'Modify'];

    if (!stage || !context) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stage and context are required.' }) }], isError: true };

    const riskEmoji = ({ low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' } as Record<string, string>)[riskLevel] ?? '🟡';
    const checkpoint_id = `hitl-${Date.now().toString(36)}`;

    const formatted = [
      `## ⏸️  Human-in-the-Loop Checkpoint`,
      ``,
      `**Stage:** ${stage}${workflowId ? ` (workflow: ${workflowId})` : ''}`,
      `**Risk:** ${riskEmoji} ${riskLevel.toUpperCase()}`,
      ``,
      `### What is about to happen`,
      context,
      ``,
      `### Your response options`,
      options.map((o, i) => `${i + 1}. **${o}**`).join('\n'),
      ``,
      `_Respond with your choice to continue the workflow. The agent is waiting._`,
    ].join('\n');

    return { content: [{ type: 'text', text: JSON.stringify({
      checkpoint_id,
      stage,
      risk_level: riskLevel,
      status: 'waiting_for_approval',
      options,
      formatted_request: formatted,
      workflow_id: workflowId,
      created_at: new Date().toISOString(),
    }, null, 2) }] };
  },

  veto_openapi_gen: async ({ args }) => {
    const filePath   = args?.file_path   ? String(args.file_path)   : null;
    const projectDir = args?.project_dir ? String(args.project_dir) : null;
    const writeFileArg = args?.write_file === true;
    const framework  = String(args?.framework ?? 'auto');

    let routeContent = '';
    if (filePath) {
      try { routeContent = readFileSync(filePath, 'utf8').slice(0, 10000); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read ${filePath}: ${e}` }) }], isError: true }; }
    } else if (projectDir) {
      try {
        const candidates = execSync(
          'git ls-files --cached -- "*.ts" "*.js" "*.py"',
          { cwd: projectDir, timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().split('\n').filter((f: string) => /route|router|api|endpoint|controller/i.test(f) && !f.includes('node_modules') && !f.includes('dist/')).slice(0, 5);
        for (const f of candidates) {
          try { routeContent += `\n// FILE: ${f}\n${readFileSync(join(projectDir, f), 'utf8').slice(0, 3000)}\n`; } catch { /* skip */ }
        }
      } catch { /* not a git repo */ }
    }
    if (!routeContent) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No route files found. Provide file_path or project_dir with route files.' }) }], isError: true };

    const openapiResult = await executeOne({
      id:    'openapi-1',
      agent: 'api' as WorkerAgentType,
      task:  `Generate a complete OpenAPI 3.1 specification in YAML format for these ${framework === 'auto' ? 'API' : framework} route definitions. Include: info block (title, version), servers, all paths with HTTP methods, request body schemas, response schemas (200, 400, 401, 404, 500), and security schemes if auth is detected. Output ONLY valid YAML — no markdown fences, no explanation.`,
      code:  routeContent,
    });

    const rawSpec = openapiResult.plan?.approach ?? openapiResult.output.recommendation ?? '';
    const specLines = rawSpec.split('\n');
    const specStart = specLines.findIndex((l: string) => /^(openapi:|info:)/.test(l.trim()));
    const spec = specStart >= 0 ? specLines.slice(specStart).join('\n').trim() : rawSpec.trim();

    let writtenTo: string | null = null;
    if (writeFileArg && projectDir && spec) {
      try {
        const outPath = join(projectDir, 'openapi.yaml');
        writeFileSync(outPath, spec, 'utf8');
        writtenTo = outPath;
      } catch { /* skip write errors */ }
    }

    const routeLineCount = (routeContent.match(/\bget\b|\bpost\b|\bput\b|\bpatch\b|\bdelete\b/gi) ?? []).length;

    recordOutcome('openapi_gen', 50, 2, 'api', openapiResult.analysis?.score ?? Math.round(openapiResult.output.confidence * 100));

    return { content: [{ type: 'text', text: JSON.stringify({
      spec,
      written_to:       writtenTo,
      routes_detected:  routeLineCount,
      framework,
    }, null, 2) }] };
  },

  veto_flag_auditor: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const sdk        = String(args?.sdk ?? 'auto');

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    const patterns = [
      { label: 'LaunchDarkly', regex: 'ldClient\\.variation|isFeatureEnabled|client\\.boolVariation' },
      { label: 'Unleash',      regex: 'isEnabled\\(|getVariant\\(|unleash\\.isEnabled' },
      { label: 'Custom flags', regex: 'flags?\\[|flags?\\.\\w+|feature[Ff]lag|isFeature|FEATURE_' },
      { label: 'Env-based flags', regex: 'process\\.env\\.FEATURE_|process\\.env\\.ENABLE_|process\\.env\\.FF_' },
    ];

    let findings = '';
    let totalMatches = 0;
    for (const { label, regex } of patterns) {
      try {
        const out = execSync(
          `git grep -rn "${regex}" --include="*.ts" --include="*.js" --include="*.py" -- . ":(exclude)node_modules" ":(exclude)dist"`,
          { cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString();
        const lines = out.split('\n').filter(Boolean);
        totalMatches += lines.length;
        if (lines.length > 0) findings += `\n=== ${label} (${lines.length} occurrences) ===\n${lines.slice(0, 15).join('\n')}`;
      } catch { /* no matches */ }
    }

    if (!findings) return { content: [{ type: 'text', text: JSON.stringify({ success: true, flags_found: 0, flag_items: [], summary: 'No feature flag patterns detected.' }) }] };

    const flagResult = await executeOne({
      id:    'flags-1',
      agent: 'code-quality' as WorkerAgentType,
      task:  'Analyze these feature flag usages and classify each unique flag as: (1) ACTIVE — still toggled in code and worth keeping, (2) CANDIDATE_REMOVAL — always-true/always-false or deprecated, (3) ORPHANED — referenced but flag definition not found. For each, provide: flag name, classification, last-seen location, and safe-to-remove assessment.',
      code:  findings.slice(0, 6000),
    });

    const agentOut = flagResult.plan?.approach ?? flagResult.output.recommendation ?? '';
    recordOutcome('flag_audit', 50, 2, 'code-quality', flagResult.analysis?.score ?? Math.round(flagResult.output.confidence * 100));

    // Parse a rough count from agentOut heuristics
    const activeCount    = (agentOut.match(/ACTIVE/g) ?? []).length;
    const removalCount   = (agentOut.match(/CANDIDATE_REMOVAL/g) ?? []).length;
    const orphanedCount  = (agentOut.match(/ORPHANED/g) ?? []).length;

    return { content: [{ type: 'text', text: JSON.stringify({
      flags_found:        totalMatches,
      active:             activeCount,
      candidate_removal:  removalCount,
      orphaned:           orphanedCount,
      flag_items:         [],
      recommendations:    agentOut,
      sdk_detected:       sdk === 'auto' ? (findings.includes('ldClient') ? 'launchdarkly' : findings.includes('unleash') ? 'unleash' : 'custom') : sdk,
      council_note:       'Run veto_council_debate before removing any flags to assess downstream risk.',
    }, null, 2) }] };
  },

  veto_drift_check: async ({ args }) => {
    let sessionId = args?.session_id ? String(args.session_id).trim() : null;
    if (!sessionId) {
      sessionId = autoSave.last_session_id;
    }
    if (!sessionId) {
      const recent = listSessions(1);
      if (recent.length > 0) sessionId = recent[0].id;
    }

    if (!sessionId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No active or saved sessions found. Save a session first.' }, null, 2) }],
        isError: true
      };
    }

    const limit = typeof args?.limit === 'number' ? Math.max(1, args.limit) : 50;
    const projectDir = args?.project_dir ? String(args.project_dir).trim() : undefined;

    const allTraces = getSessionReplay(sessionId);
    const traces = allTraces.slice(-limit);

    const total_calls = traces.length;
    const failed_calls = traces.filter(t => t.result_status === 'error').length;
    const error_rate = total_calls > 0 ? Math.round((failed_calls / total_calls) * 100) : 0;

    // Consecutive failures (from the end)
    let consecutive_failures = 0;
    for (let i = traces.length - 1; i >= 0; i--) {
      if (traces[i].result_status === 'error') {
        consecutive_failures++;
      } else {
        break;
      }
    }

    // Repeated error messages
    const errorCounts: Record<string, number> = {};
    for (const t of traces) {
      if (t.result_status === 'error' && t.error_message) {
        const msg = t.error_message.trim();
        errorCounts[msg] = (errorCounts[msg] ?? 0) + 1;
      }
    }
    const repeated_errors = Object.entries(errorCounts)
      .map(([error_message, count]) => ({ error_message, count }))
      .filter(item => item.count >= 2)
      .sort((a, b) => b.count - a.count);

    // Tool repetition and max consecutive tool calls
    const toolCounts: Record<string, number> = {};
    let max_consecutive_tool = '';
    let max_consecutive_tool_count = 0;
    let current_tool = '';
    let current_consecutive_count = 0;

    for (const t of traces) {
      toolCounts[t.tool_name] = (toolCounts[t.tool_name] ?? 0) + 1;
      if (t.tool_name === current_tool) {
        current_consecutive_count++;
      } else {
        if (current_consecutive_count > max_consecutive_tool_count) {
          max_consecutive_tool_count = current_consecutive_count;
          max_consecutive_tool = current_tool;
        }
        current_tool = t.tool_name;
        current_consecutive_count = 1;
      }
    }
    if (current_consecutive_count > max_consecutive_tool_count) {
      max_consecutive_tool_count = current_consecutive_count;
      max_consecutive_tool = current_tool;
    }

    const repeated_tools = Object.entries(toolCounts)
      .map(([tool_name, count]) => ({ tool_name, count }))
      .filter(item => item.count >= 3)
      .sort((a, b) => b.count - a.count);

    // Command repetition check
    const commandCounts: Record<string, number> = {};
    for (const t of traces) {
      if (t.tool_name === 'run_command' && t.args_json) {
        try {
          const parsed = JSON.parse(t.args_json);
          const cmd = String(parsed.CommandLine ?? '').trim();
          if (cmd) {
            commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1;
          }
        } catch { /* skip */ }
      }
    }
    const repeated_commands = Object.entries(commandCounts)
      .map(([command, count]) => ({ command, count }))
      .filter(item => item.count >= 2)
      .sort((a, b) => b.count - a.count);

    // Loop detection flag
    const hasRepeatedError = repeated_errors.some(e => e.count >= 3);
    const hasRepeatedCommand = repeated_commands.some(c => c.count >= 3);
    const loop_detected = consecutive_failures >= 3 || hasRepeatedError || hasRepeatedCommand || max_consecutive_tool_count >= 4;

    // Determine verdict
    let verdict: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
    if (consecutive_failures >= 5 || repeated_errors.some(e => e.count >= 4) || max_consecutive_tool_count >= 5) {
      verdict = 'RED';
    } else if (consecutive_failures >= 3 || repeated_errors.some(e => e.count >= 2) || max_consecutive_tool_count >= 3) {
      verdict = 'YELLOW';
    }

    let agentOut = '';
    let recommendations = 'No compounding-error loops detected. Proceed with your current task.';
    
    if (loop_detected || verdict !== 'GREEN' || total_calls > 0) {
      const formattedTraces = traces.map(t => {
        let cmdStr = '';
        if (t.tool_name === 'run_command' && t.args_json) {
          try {
            cmdStr = ` (cmd: ${JSON.parse(t.args_json).CommandLine})`;
          } catch {}
        }
        return `- ${t.recorded_at.slice(11, 19)}: ${t.tool_name}${cmdStr} -> ${t.result_status.toUpperCase()}${t.error_message ? ` (error: ${t.error_message})` : ''}`;
      }).join('\n');

      const analysisPayload = {
        session_id: sessionId,
        heuristics: {
          total_calls,
          failed_calls,
          error_rate_pct: error_rate,
          consecutive_failures,
          max_consecutive_tool: max_consecutive_tool ? `${max_consecutive_tool} (${max_consecutive_tool_count}x)` : 'none',
          repeated_errors,
          repeated_tools,
          repeated_commands,
        },
        recent_timeline: formattedTraces,
      };

      const agentResult = await executeOne({
        id: `drift-${Date.now().toString(36)}`,
        agent: 'debugger' as WorkerAgentType,
        task: `The AI coding assistant is verifying its session for compounding errors or loops. Analyze this trace. Under 'Remediation Plan', list 2-3 specific actions the AI should take to break the loop (e.g. read a specific file, check for syntax errors, check if a mock server is down, revert a commit).`,
        code: JSON.stringify(analysisPayload, null, 2),
        project_dir: projectDir,
      });

      agentOut = agentResult.plan?.approach ?? agentResult.output.recommendation ?? '';
      recommendations = agentOut;
    }

    recordOutcome('drift_check', 30, 2, 'debugger', verdict === 'RED' ? 30 : verdict === 'YELLOW' ? 60 : 95);

    const verdictEmoji = verdict === 'RED' ? '🔴 RED' : verdict === 'YELLOW' ? '🟡 YELLOW' : '🟢 GREEN';
    const formatted = [
      `## 🔄 Compounding-Error Circuit Breaker (Drift Check)`,
      ``,
      `**Verdict:** ${verdictEmoji}`,
      `**Session ID:** \`${sessionId}\``,
      ``,
      `### Heuristics Snapshot`,
      `- Total tool calls checked: ${total_calls}`,
      `- Consecutive failures: ${consecutive_failures}`,
      `- Error rate: ${error_rate}%`,
      max_consecutive_tool ? `- Max consecutive tool calls: ${max_consecutive_tool} (${max_consecutive_tool_count}x)` : '',
      ``,
      `### Loop Indicators`,
      `- Repeated errors: ${repeated_errors.length === 0 ? 'None' : repeated_errors.map(e => `\`${e.error_message}\` (${e.count}x)`).join(', ')}`,
      `- Repeated tools: ${repeated_tools.length === 0 ? 'None' : repeated_tools.map(t => `\`${t.tool_name}\` (${t.count}x)`).join(', ')}`,
      `- Repeated commands: ${repeated_commands.length === 0 ? 'None' : repeated_commands.map(c => `\`${c.command}\` (${c.count}x)`).join(', ')}`,
      ``,
      `### 🛠️ Remediation Recommendations`,
      recommendations,
    ].filter(l => l !== '').join('\n');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          session_id: sessionId,
          verdict,
          loop_detected,
          heuristics: {
            total_calls,
            failed_calls,
            error_rate,
            consecutive_failures,
            max_consecutive_tool: max_consecutive_tool || null,
            max_consecutive_tool_count,
            repeated_errors,
            repeated_tools,
            repeated_commands,
          },
          remediation_plan: agentOut || null,
          formatted_report: formatted,
        }, null, 2),
      }],
    };
  },
};
