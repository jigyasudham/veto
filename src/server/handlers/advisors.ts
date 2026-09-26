// Single-purpose advisory tools that scan a project (deps, SQL, bundle stats,
// dead code, feature flags, API routes) and run one expert agent over the
// gathered evidence, recording the outcome for router learning. Plus the
// human-in-the-loop checkpoint, which is pure formatting. They share the
// executeOne + recordOutcome shape but each gathers evidence differently.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { recordOutcome } from '../../router/index.js';
import { runHandlerAgent, handlerAgentResponse } from '../scan-core.js';
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
    let packages: Array<{ name: string; version: string | null; version_source: string }> = [];

    // The version OSV is asked about must be the one in use. Before 3.7.0 every
    // range was cut to its major ("^4.19.2" → "4.0.0"), so OSV reported
    // vulnerabilities fixed long before the version actually installed.
    const exactVersion = (range: string): string | null => {
      const m = String(range).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : null;
    };
    if (ecosystem === 'auto' || ecosystem === 'npm') {
      try {
        const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
        let lock: Record<string, { version?: string }> = {};
        try { lock = (JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> }).packages ?? {}; } catch { /* no lockfile */ }
        const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
        packages = Object.entries(deps).slice(0, 50).map(([name, range]) => {
          try {
            const installed = JSON.parse(readFileSync(join(projectDir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string };
            if (installed.version) return { name, version: installed.version, version_source: 'installed' };
          } catch { /* not installed */ }
          const locked = lock[`node_modules/${name}`]?.version;
          if (locked) return { name, version: locked, version_source: 'package-lock.json' };
          const v = exactVersion(range);
          return { name, version: v, version_source: v ? `lowest version allowed by "${range}"` : `unresolvable range "${range}"` };
        });
        ecosystem = 'npm';
      } catch { /* try next */ }
    }
    if ((ecosystem === 'auto' || ecosystem === 'pypi') && packages.length === 0) {
      try {
        const req = readFileSync(join(projectDir, 'requirements.txt'), 'utf8');
        packages = req.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-')).slice(0, 50).map(l => {
          const m = l.match(/^([A-Za-z0-9_.\-[\]]+)\s*(==|>=|~=)?\s*([0-9][^\s;,]*)?/);
          const name = (m?.[1] ?? l).replace(/\[.*\]$/, '');
          const version = m?.[3] ? exactVersion(m[3]) : null;
          return { name, version, version_source: m?.[2] === '==' ? 'pinned' : version ? `lowest version allowed by "${l}"` : 'unpinned' };
        });
        ecosystem = 'pypi';
      } catch { /* skip */ }
    }
    if (packages.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No package.json or requirements.txt found in project_dir.' }) }], isError: true };

    const checkable = packages.filter(p => p.version);
    let vulnerabilities: Array<{ package: string; version: string; vuln_id: string; severity: string; summary: string }> = [];
    let osvAvailable = false;
    let osvError: string | null = null;
    try {
      const osvEcosystem = ecosystem === 'npm' ? 'npm' : ecosystem === 'pypi' ? 'PyPI' : 'crates.io';
      const batch = checkable.slice(0, 30);
      const body = { queries: batch.map(p => ({ package: { name: p.name, ecosystem: osvEcosystem }, version: p.version })) };
      const resp = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json() as { results: Array<{ vulns?: Array<{ id: string; summary?: string; database_specific?: { severity?: string } }> }> };
        data.results.forEach((r, i) => {
          for (const v of (r.vulns ?? [])) {
            vulnerabilities.push({ package: batch[i].name, version: batch[i].version!, vuln_id: v.id, severity: v.database_specific?.severity?.toLowerCase() ?? 'unknown', summary: v.summary ?? '' });
          }
        });
        osvAvailable = true;
        // querybatch returns ids only — every vuln came back with severity
        // "unknown" and an empty summary. Fetch the details (bounded).
        const ids = [...new Set(vulnerabilities.map(v => v.vuln_id))].slice(0, 25);
        const details = new Map<string, { summary?: string; severity?: string; affected?: Array<{ package?: { name?: string }; ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> }>();
        await Promise.all(ids.map(async id => {
          try {
            const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(6000) });
            if (r.ok) {
              const d = await r.json() as { summary?: string; details?: string; database_specific?: { severity?: string }; affected?: Array<{ package?: { name?: string }; ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> };
              details.set(id, { summary: d.summary ?? d.details?.slice(0, 200), severity: d.database_specific?.severity, affected: d.affected });
            }
          } catch { /* keep the id-only record */ }
        }));
        vulnerabilities = vulnerabilities.map(v => {
          const d = details.get(v.vuln_id);
          if (!d) return v;
          const fixed = d.affected?.filter(a => a.package?.name === v.package).flatMap(a => a.ranges ?? []).flatMap(r => r.events ?? []).map(e => e.fixed).filter((f): f is string => !!f);
          return { ...v, summary: d.summary ?? v.summary, severity: d.severity?.toLowerCase() ?? v.severity, ...(fixed?.length ? { fixed_in: fixed } : {}) };
        });
      } else {
        osvError = `OSV returned HTTP ${resp.status}`;
      }
    } catch (e) { osvError = `OSV unreachable: ${e instanceof Error ? e.message : String(e)}`; }

    const depRun = await runHandlerAgent('veto_dep_advisor', {
      id: 'dep-1',
      agent: 'dependency-audit',
      task: 'Produce a risk-ranked upgrade plan for these dependencies.',
      code: JSON.stringify({ packages: packages.slice(0, 30), vulnerabilities }, null, 2).slice(0, 8000),
      deliverable: {
        description: 'From the packages and OSV vulnerabilities in the material, produce an upgrade plan ranked by risk. Only list packages that have a vulnerability or a concrete reason to upgrade; do not invent CVEs.',
        shape: {
          upgrade_plan: '[{ "package": "...", "current": "...", "recommended": "<version>", "risk": "critical|high|medium|low", "breaking_change_risk": "high|medium|low", "steps": ["..."] }, ...] ([] if nothing needs upgrading)',
          summary: '"<one paragraph>"',
        },
        required: ['summary'],
      },
    }, args?.agent_response);

    recordOutcome('dep_advisor', 50, 2, 'dependency-audit', depRun.deliverable ? 80 : 50);

    return handlerAgentResponse({
      ecosystem,
      packages_scanned:      packages.length,
      packages_checked:      Math.min(checkable.length, 30),
      unchecked:             packages.filter(p => !p.version).map(p => ({ name: p.name, why: p.version_source })),
      vulnerabilities_found: vulnerabilities.length,
      vulns:                 vulnerabilities,
      osv_available:         osvAvailable,
      ...(osvError ? { osv_error: osvError } : {}),
      upgrade_plan:          depRun.deliverable?.upgrade_plan ?? null,
      summary:               depRun.deliverable?.summary ?? null,
    }, depRun, { generated: ['upgrade_plan', 'summary'] });
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

    const queryRun = await runHandlerAgent('veto_query_advisor', {
      id: 'query-1',
      agent: 'database',
      task: 'Optimise this SQL query.',
      code: query.slice(0, 4000),
      context: [schema && `Schema:\n${schema}`, explainOutput && `EXPLAIN:\n${explainOutput}`, issues.length ? `Deterministic checks found:\n${issues.map(i => `- ${i}`).join('\n')}` : ''].filter(Boolean).join('\n\n') || undefined,
      deliverable: {
        description: 'Optimise the SQL query in the material using the schema and EXPLAIN output if given. Only propose indexes on columns that exist in the schema (or say the schema is needed).',
        shape: {
          optimized_query: '"<rewritten SQL>"',
          index_statements: '["CREATE INDEX ...", ...] ([] if none needed)',
          n_plus_one_risk: 'true|false',
          estimated_improvement: '"<e.g. full scan → index seek; say \'unknown without EXPLAIN\' when it is>"',
          lock_risk: '"<will creating the indexes lock the table, and how to avoid it>"',
          recommendations: '["...", ...]',
        },
        required: ['optimized_query'],
      },
    }, args?.agent_response);
    const qd = queryRun.deliverable;
    recordOutcome('query_advisor', 50, 2, 'database', qd ? 80 : 50);

    return handlerAgentResponse({
      issues_detected:       issues,
      optimized_query:       qd?.optimized_query ?? null,
      index_statements:      qd?.index_statements ?? null,
      n_plus_one_risk:       qd?.n_plus_one_risk ?? null,
      estimated_improvement: qd?.estimated_improvement ?? null,
      lock_risk:             qd?.lock_risk ?? null,
      recommendations:       qd?.recommendations ?? null,
    }, queryRun, { generated: ['optimized_query', 'index_statements', 'n_plus_one_risk', 'estimated_improvement', 'lock_risk', 'recommendations'] });
  },

  veto_bundle_advisor: async ({ args }) => {
    let statsRaw = '';
    try { statsRaw = readFileSync(String(args?.stats_file ?? ''), 'utf8'); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read stats file: ${e}` }) }], isError: true }; }
    let statsData: Record<string, unknown> = {};
    try { statsData = JSON.parse(statsRaw); } catch { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stats_file is not valid JSON' }) }], isError: true }; }

    // webpack stats: { assets[], modules[] }. Anything else is not understood —
    // say so rather than advising on an empty list.
    const assets = ((statsData.assets as Array<{ name: string; size: number }>) ?? []).filter(a => a && typeof a.size === 'number').sort((a, b) => b.size - a.size);
    const modules = ((statsData.modules as Array<{ name: string; size: number }>) ?? []).filter(m => m && typeof m.size === 'number').sort((a, b) => b.size - a.size);
    if (!assets.length && !modules.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'stats_file has no assets[] or modules[] with sizes. Generate it with `webpack --json > stats.json` (or an equivalent webpack-format stats file).' }) }], isError: true };
    }
    const totalSize = assets.reduce((s, a) => s + a.size, 0) || modules.reduce((s, m) => s + m.size, 0);
    // Packages that appear under more than one path are duplicated in the bundle.
    const byPackage: Record<string, Set<string>> = {};
    for (const m of modules) {
      const pm = m.name.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g);
      if (!pm) continue;
      const pkg = pm[pm.length - 1].replace(/^node_modules[\\/]/, '');
      const at = m.name.slice(0, m.name.lastIndexOf(pkg));
      (byPackage[pkg] ??= new Set()).add(at);
    }
    const duplicates = Object.entries(byPackage).filter(([, paths]) => paths.size > 1).map(([pkg, paths]) => ({ package: pkg, copies: paths.size }));
    const facts = {
      total_size_kb: Math.round(totalSize / 1024),
      assets_analyzed: assets.length,
      heaviest_assets: assets.slice(0, 10).map(a => ({ name: a.name, size_kb: Math.round(a.size / 1024) })),
      heaviest_modules: modules.slice(0, 15).map(m => ({ name: m.name, size_kb: Math.round(m.size / 1024) })),
      duplicate_packages: duplicates,
    };

    const bundleRun = await runHandlerAgent('veto_bundle_advisor', {
      id: 'bundle-1',
      agent: 'frontend',
      task: 'Advise how to shrink this bundle.',
      code: JSON.stringify(facts, null, 2).slice(0, 6000),
      deliverable: {
        description: 'From the bundle facts in the material, say what to cut. Base size estimates only on the sizes shown.',
        shape: {
          code_split_candidates: '["<module or route> — why", ...]',
          externalize: '["<package safe to load from a CDN> — why", ...]',
          recommendations: '["...", ...]',
          estimated_reduction_kb: '<number, from the sizes shown>',
        },
        required: ['recommendations'],
      },
    }, args?.agent_response);
    const bd = bundleRun.deliverable;
    recordOutcome('bundle_advisor', 50, 2, 'frontend', bd ? 80 : 50);

    return handlerAgentResponse({
      ...facts,
      code_split_candidates:  bd?.code_split_candidates ?? null,
      externalize:            bd?.externalize ?? null,
      recommendations:        bd?.recommendations ?? null,
      estimated_reduction_kb: bd?.estimated_reduction_kb ?? null,
    }, bundleRun, { generated: ['code_split_candidates', 'externalize', 'recommendations', 'estimated_reduction_kb'] });
  },

  veto_dead_code: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    const exts = Array.isArray(args?.extensions) ? (args.extensions as unknown[]).map(String) : ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    // Real analysis, not a grep that could not match: before 3.7.0 this passed
    // GNU grep's --include to `git grep` (which rejects it) and used `|` in a
    // basic regex, so it always reported "No dead code patterns detected".
    const { unusedExports, codeMarkers } = await import('../worker-evidence.js');
    const unused = unusedExports(projectDir, exts);
    const markers = codeMarkers(projectDir, exts);
    const facts = {
      files_scanned: unused.files_scanned,
      exports_found: unused.exports_found,
      unused_exports: unused.unused,
      public_api_exports: unused.public_api.length,
      todo_markers: markers.todos,
      commented_code_blocks: markers.commented_code_blocks,
    };
    if (!unused.unused.length && !markers.commented_code_blocks.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...facts, summary: `No export is unused and no commented-out code was found in ${unused.files_scanned} files.` }, null, 2) }] };
    }

    const deadRun = await runHandlerAgent('veto_dead_code', {
      id: 'dead-1',
      agent: 'code-quality',
      task: 'Judge which of these candidates are safe to delete.',
      code: JSON.stringify({ unused_exports: unused.unused.slice(0, 60), commented_code_blocks: markers.commented_code_blocks.slice(0, 30) }, null, 2).slice(0, 8000),
      context: buildContextString(projectDir) || undefined,
      deliverable: {
        description: 'For each candidate in the material (exports no other project file mentions, and commented-out code), judge whether it is really dead. Consider dynamic use, public API, tests, and framework conventions (e.g. Next.js page exports).',
        shape: { items: '[{ "symbol_or_block": "...", "file": "...", "line": <n>, "dead": true|false, "safe_to_delete": true|false, "risk": "high|medium|low", "why": "..." }, ...]' },
        required: ['items'],
      },
    }, args?.agent_response);
    recordOutcome('dead_code', 50, 2, 'code-quality', deadRun.deliverable ? 80 : 50);

    return handlerAgentResponse({
      ...facts,
      assessment: deadRun.deliverable?.items ?? null,
      council_note: 'Run veto_council_debate before deleting exports another package might use.',
    }, deadRun, { generated: ['assessment'] });
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

    // Route definitions, found by what the code says rather than what the file
    // is called: before 3.7.0 only files NAMED route/router/api/controller were
    // read, so an Express app in src/app.ts had "no route files".
    const ROUTE_RE = /\b(?:app|router|server|api|fastify)\.(?:get|post|put|patch|delete|route|all)\s*\(|@(?:Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping)\s*\(|@(?:app|router|bp|blueprint)\.(?:route|get|post|put|patch|delete)\s*\(|\bHandleFunc\s*\(|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/;
    let routeContent = '';
    const routeFiles: string[] = [];
    if (filePath) {
      try { routeContent = readFileSync(filePath, 'utf8').slice(0, 10000); routeFiles.push(filePath); } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Cannot read ${filePath}: ${e}` }) }], isError: true }; }
    } else if (projectDir) {
      const { listProjectFiles } = await import('../worker-evidence.js');
      for (const f of listProjectFiles(projectDir, ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.go', '.java', '.kt'])) {
        if (routeFiles.length >= 8 || routeContent.length > 16000) break;
        let text = '';
        try { text = readFileSync(join(projectDir, f), 'utf8'); } catch { continue; }
        if (!ROUTE_RE.test(text)) continue;
        routeFiles.push(f);
        routeContent += `\n// FILE: ${f}\n${text.slice(0, 4000)}\n`;
      }
    }
    if (!routeContent) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No route definitions found (Express/Fastify/Nest/Flask/FastAPI/Spring/Go http/Next.js route handlers). Pass file_path to point at one.' }) }], isError: true };
    const routesDetected = routeContent.split('\n').filter(l => ROUTE_RE.test(l)).length;

    const openapiRun = await runHandlerAgent('veto_openapi_gen', {
      id:    'openapi-1',
      agent: 'api' as WorkerAgentType,
      task:  `Write the OpenAPI 3.1 spec for these ${framework === 'auto' ? '' : framework + ' '}routes.`,
      code:  routeContent,
      deliverable: {
        description: 'Write an OpenAPI 3.1 specification (YAML) covering exactly the routes in the material: every path and method, parameters, request bodies and responses inferred from the handlers, and security schemes only if auth is visible in the code.',
        shape: { spec: '"<YAML starting with openapi: 3.1.0>"', unknowns: '["<what could not be inferred from the code>", ...]' },
        required: ['spec'],
        max_tokens: 8000,
      },
    }, args?.agent_response);

    let spec = typeof openapiRun.deliverable?.spec === 'string' ? openapiRun.deliverable.spec.replace(/^```(?:ya?ml)?\s*|```\s*$/g, '').trim() : null;
    const problem = spec && !/^openapi:\s*3\./m.test(spec) ? 'The generated text is not an OpenAPI 3 document (no "openapi: 3.x" line), so it was not returned or written.' : null;
    if (problem) spec = null;

    let writtenTo: string | null = null;
    if (writeFileArg && projectDir && spec) {
      const outPath = join(projectDir, 'openapi.yaml');
      writeFileSync(outPath, spec + '\n', 'utf8');
      writtenTo = outPath;
    }
    recordOutcome('openapi_gen', 50, 2, 'api', spec ? 80 : 40);

    return handlerAgentResponse({
      route_files:      routeFiles,
      routes_detected:  routesDetected,
      framework,
      spec,
      unknowns:         openapiRun.deliverable?.unknowns ?? null,
      written_to:       writtenTo,
      ...(problem ? { problem } : {}),
    }, openapiRun, { generated: ['spec', 'unknowns'] });
  },

  veto_flag_auditor: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const sdk        = String(args?.sdk ?? 'auto');

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    // A real scan (the old `git grep --include=` call always failed, so this
    // tool always reported 0 flags).
    const { featureFlags } = await import('../worker-evidence.js');
    const scan = featureFlags(projectDir);
    const flags = sdk === 'auto' ? scan.flags : scan.flags.filter(f => f.sdk === sdk || (sdk === 'custom' && f.sdk === 'env'));
    if (!flags.length) return { content: [{ type: 'text', text: JSON.stringify({ success: true, flags_found: 0, flags: [], summary: 'No feature-flag usage found.' }, null, 2) }] };

    const flagRun = await runHandlerAgent('veto_flag_auditor', {
      id:    'flags-1',
      agent: 'code-quality' as WorkerAgentType,
      task:  'Classify these feature flags.',
      code:  JSON.stringify(flags.slice(0, 60), null, 2).slice(0, 8000),
      deliverable: {
        description: 'Classify each flag in the material as ACTIVE (still meaningfully toggled), CANDIDATE_REMOVAL (always on/off or obsolete) or ORPHANED (read but never defined/set). Say what evidence each classification rests on.',
        shape: { flags: '[{ "name": "...", "classification": "ACTIVE|CANDIDATE_REMOVAL|ORPHANED", "safe_to_remove": true|false, "why": "..." }, ...]' },
        required: ['flags'],
      },
    }, args?.agent_response);
    recordOutcome('flag_audit', 50, 2, 'code-quality', flagRun.deliverable ? 80 : 50);

    const classified = Array.isArray(flagRun.deliverable?.flags) ? flagRun.deliverable!.flags as Array<{ classification?: string }> : null;
    const count = (c: string) => classified ? classified.filter(f => f.classification === c).length : null;
    return handlerAgentResponse({
      flags_found:       flags.length,
      occurrences:       flags.reduce((n, f) => n + f.locations.length, 0),
      flags,
      sdks_seen:         [...new Set(flags.map(f => f.sdk))],
      classification:    classified,
      active:            count('ACTIVE'),
      candidate_removal: count('CANDIDATE_REMOVAL'),
      orphaned:          count('ORPHANED'),
      council_note:      'Run veto_council_debate before removing any flags to assess downstream risk.',
    }, flagRun, { generated: ['classification', 'active', 'candidate_removal', 'orphaned'] });
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
    let driftRun: import('../scan-core.js').HandlerAgentRun | undefined;

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

      driftRun = await runHandlerAgent('veto_drift_check', {
        id: `drift-${Date.now().toString(36)}`,
        agent: 'debugger' as WorkerAgentType,
        task: 'Check this session trace for compounding errors or loops.',
        code: JSON.stringify(analysisPayload, null, 2),
        project_dir: projectDir,
        deliverable: {
          description: 'The AI coding assistant is checking its own session for compounding errors or loops. From the trace and heuristics in the material, list the specific actions that would break the loop (read a specific file, check a syntax error, check whether a server is down, revert a commit...).',
          shape: { remediation_plan: '["<specific action>", ...] 2-3 items, or [] if there is no loop' },
          required: [],
        },
      }, args?.agent_response);
      if (driftRun.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: driftRun.error }, null, 2) }], isError: true };
      }
      const plan = Array.isArray(driftRun.deliverable?.remediation_plan) ? (driftRun.deliverable!.remediation_plan as unknown[]).map(String) : null;
      if (plan) {
        agentOut = plan.join('\n');
        recommendations = plan.length ? plan.map((s, i) => `${i + 1}. ${s}`).join('\n') : recommendations;
      } else if (verdict !== 'GREEN') {
        // No LLM ran: the heuristics above are real; the remediation is not written yet.
        recommendations = 'Loop indicators found (see above). Remediation needs the LLM step — see llm_upgrade.';
      }
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
          ...(driftRun?.llm_upgrade ? { llm_upgrade: driftRun.llm_upgrade } : {}),
        }, null, 2),
      }],
    };
  },
};
