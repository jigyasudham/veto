// Tools that run one worker agent over material they are handed or gather.
//
// Each declares what its material is (a code/text argument, or a file it
// names), what deterministic evidence it gathers first, and — where the answer
// is not a plan or an analysis — the exact deliverable it needs back. Before
// 3.7.0 these were bare delegations that forwarded only task/code/context, so
// a translation never received its text, a search never received its query,
// and a merge-conflict resolver never read the file.

import { handleAgenticWorker, type WorkerSpec } from '../scan-core.js';
import { conflictHunks, lintConfigs, listProjectFiles, projectDigest, readCoverage, searchCode, testGaps, typeCoverage } from '../worker-evidence.js';
import { storeScanDiagnostics } from '../../memory/local.js';
import type { HandlerMap, ToolHandler } from '../registry.js';
import type { WorkerAgentType } from '../../agents/types.js';

function worker(name: string, agent: WorkerAgentType, defaultTask: string, spec: WorkerSpec = {}): ToolHandler {
  return (ctx) => handleAgenticWorker(name, ctx.args, agent, defaultTask, spec);
}

const needProject = (args: Record<string, unknown>, projectDir: string | undefined): string | { error: string } =>
  projectDir ? projectDir : { error: 'project_dir is required.' };

/**
 * Scanners store what they found for the VS Code extension's inline squiggles
 * when given a file_path — the tool description always promised this, and
 * nothing ever called storeScanDiagnostics.
 */
function scanner(name: string, agent: WorkerAgentType, defaultTask: string, spec: WorkerSpec): ToolHandler {
  return async (ctx) => {
    const res = await handleAgenticWorker(name, ctx.args, agent, defaultTask, spec);
    const filePath = ctx.args?.file_path ? String(ctx.args.file_path) : '';
    if (filePath && !('isError' in res && res.isError)) {
      try {
        const body = JSON.parse(res.content[0].text) as { findings?: Array<{ location?: string; description: string; severity: string }>; deterministic_findings?: { findings?: Array<{ location?: string; description: string; severity: string }> } };
        const findings = body.findings ?? body.deterministic_findings?.findings ?? [];
        storeScanDiagnostics(filePath, findings.map(f => ({
          line: Number(f.location?.match(/(\d+)(?!.*\d)/)?.[1] ?? 1),
          message: f.description,
          severity: f.severity,
        })), name);
      } catch { /* diagnostics are best-effort */ }
    }
    return res;
  };
}

export const workerHandlers: HandlerMap = {
  veto_code_review: scanner('veto_code_review', 'reviewer', 'Review the following code.', { fileArgs: ['file_path'] }),
  veto_security_scan: scanner('veto_security_scan', 'security-scanner', 'Scan the following code for vulnerabilities.', { fileArgs: ['file_path'] }),
  veto_secrets_scan: scanner('veto_secrets_scan', 'secrets', 'Scan for exposed secrets.', { textArg: 'text', fileArgs: ['file_path'] }),

  veto_summarize: worker('veto_summarize', 'documentation', 'Summarize this project or file for a developer who is new to it.', {
    fileArgs: ['file_path'],
    gather: async (args, projectDir) => (args.file_path || !projectDir ? { facts: {} } : { facts: {}, context: projectDigest(projectDir) }),
    deliverable: {
      description: 'Write an expert briefing of the project or file in the material.',
      shape: {
        summary: '["<bullet>", ...] 4-6 bullets (more, as prose, if format is "detailed")',
        key_components: '["<file or module — what it does>", ...]',
        tech_stack: '["<language/framework/library>", ...]',
        entry_points: '["<file:function or command where execution starts>", ...]',
      },
      required: ['summary'],
    },
  }),

  veto_type_coverage: worker('veto_type_coverage', 'reviewer', 'Suggest concrete replacement types for these `any` usages, most security-sensitive first.', {
    gather: async (args, projectDir) => {
      const dir = needProject(args, projectDir);
      if (typeof dir !== 'string') return dir;
      const cov = typeCoverage(dir, typeof args.max_files === 'number' ? Math.min(args.max_files, 30) : 20);
      return { facts: cov, context: `any usage (computed):\n${JSON.stringify({ ...cov, sample: cov.sample.slice(0, 40) }, null, 1)}` };
    },
    deliverable: {
      description: 'For the `any` usages listed in the context, propose specific replacement types based on how each value is used.',
      shape: { replacements: '[{ "file": "...", "line": <n>, "current": "...", "suggested": "...", "severity": "high|medium|low" }, ...]', summary: '"<one paragraph>"' },
      required: ['summary'],
    },
  }),

  veto_test_gaps: worker('veto_test_gaps', 'tester', 'Suggest the most valuable tests for the untested files listed.', {
    gather: async (args, projectDir) => {
      const dir = needProject(args, projectDir);
      if (typeof dir !== 'string') return dir;
      const gaps = testGaps(dir);
      let coverage: ReturnType<typeof readCoverage> = null;
      if (args.coverage_report) {
        const { isAbsolute, resolve } = await import('node:path');
        const p = String(args.coverage_report);
        coverage = readCoverage(isAbsolute(p) ? p : resolve(dir, p));
        if (!coverage) return { error: `coverage_report could not be read as lcov or an Istanbul coverage-summary JSON: ${p}` };
      }
      const least = coverage?.slice(0, 40) ?? null;
      return {
        facts: { ...gaps, ...(least ? { least_covered: least } : {}) },
        context: [
          `Source files with no test file of the same name (computed):\n${gaps.untested.join('\n') || '(none)'}`,
          least ? `Least-covered files from the coverage report:\n${least.map(c => `${c.file}  ${c.lines_pct}% (${c.lines_hit}/${c.lines_total} lines)`).join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
      };
    },
    deliverable: {
      description: 'Propose concrete test cases for the untested source files, most important first.',
      shape: { test_cases: '[{ "file": "...", "cases": ["<what to assert>", ...] }, ...]', summary: '"<one paragraph>"' },
      required: ['test_cases'],
    },
  }),

  veto_lint_rules: worker('veto_lint_rules', 'reviewer', 'Write a lint configuration that matches this project\'s existing conventions.', {
    gather: async (args, projectDir) => {
      const dir = needProject(args, projectDir);
      if (typeof dir !== 'string') return dir;
      const configs = lintConfigs(dir);
      return { facts: { existing_configs: configs.map(c => c.file), files_in_project: listProjectFiles(dir).length }, context: configs.map(c => `=== ${c.file} ===\n${c.content}`).join('\n\n') || 'No lint or format config exists yet.' };
    },
    deliverable: {
      description: 'Produce the configuration file for the requested tool, consistent with the existing configs and code style shown.',
      shape: { config_file: '"<file name to write>"', config: '"<complete file content>"', rationale: '["<why each non-default rule>", ...]' },
      required: ['config_file', 'config'],
    },
  }),

  veto_api_contract: worker('veto_api_contract', 'api', 'Analyze or generate the API contract for this project.', {
    gather: async (args, projectDir) => {
      const dir = needProject(args, projectDir);
      if (typeof dir !== 'string') return dir;
      const routes = searchCode(dir, 'app.get app.post router.get router.post route endpoint @Get @Post fastapi flask', 40);
      return { facts: { route_hits: routes.hits.length }, context: `Route-like lines (computed):\n${routes.hits.map(h => `${h.file}:${h.line}  ${h.text}`).join('\n')}` };
    },
    deliverable: {
      description: 'Perform the requested contract action (target) for the API routes found in the context.',
      shape: { contract: '"<OpenAPI YAML or TypeScript types, as fits the action>"', mismatches: '["<front/back incompatibility found>", ...]', notes: '"<what was not determinable from the material>"' },
      required: ['contract'],
    },
  }),

  veto_merge_conflict: worker('veto_merge_conflict', 'debugger', 'Resolve the git merge conflicts in this file, keeping the intent of both sides.', {
    fileArgs: ['file_path'],
    gather: async (args, projectDir) => {
      const { readFileSync } = await import('node:fs');
      const { isAbsolute, resolve } = await import('node:path');
      const p = String(args.file_path ?? '');
      if (!p) return { error: 'file_path is required.' };
      let text: string;
      try { text = readFileSync(isAbsolute(p) || !projectDir ? resolve(p) : resolve(projectDir, p), 'utf8'); } catch { return { error: `file_path not found: ${p}` }; }
      const hunks = conflictHunks(text);
      if (!hunks.length) return { error: `No conflict markers (<<<<<<< … >>>>>>>) in ${p} — nothing to resolve.` };
      return { facts: { conflicts: hunks.length, hunks: hunks.map(h => ({ start_line: h.start_line, end_line: h.end_line })) } };
    },
    deliverable: {
      description: 'Resolve every conflict block in the file. Keep both sides\' intent; never leave conflict markers.',
      shape: { resolved_content: '"<the complete file with every conflict resolved>"', decisions: '[{ "lines": "<start-end>", "kept": "ours|theirs|both|rewritten", "why": "..." }, ...]' },
      required: ['resolved_content'],
      max_tokens: 8000,
    },
  }),

  veto_translate: worker('veto_translate', 'documentation', 'Translate the material into each target language.', {
    textArg: 'text',
    fileArgs: ['file_path'],
    gather: async (args) => {
      const langs = Array.isArray(args.target_langs) ? args.target_langs.map(String).filter(Boolean) : [];
      if (!langs.length) return { error: 'target_langs is required (e.g. ["fr", "de"]).' };
      if (!args.text && !args.file_path) return { error: 'Provide text or file_path.' };
      return { facts: { target_langs: langs } };
    },
    deliverable: {
      description: 'Translate the material into every target language. Keep placeholders ({name}, %s, {{x}}, ICU plurals), keys, markup and formatting exactly as they are; translate only human-readable text.',
      shape: { translations: '{ "<lang code>": "<translated text or file content>", ... } — one entry per target language' },
      required: ['translations'],
      max_tokens: 6000,
    },
  }),

  veto_a11y_advisor: scanner('veto_a11y_advisor', 'accessibility', 'Review this UI component for WCAG accessibility issues.', { fileArgs: ['file_path'] }),

  veto_semantic_search: worker('veto_semantic_search', 'search-agent', 'Answer the query from the ranked code matches.', {
    gather: async (args, projectDir) => {
      const dir = needProject(args, projectDir);
      if (typeof dir !== 'string') return dir;
      const q = String(args.query ?? '').trim();
      if (!q) return { error: 'query is required.' };
      const r = searchCode(dir, q);
      return { facts: r, context: `Ranked keyword matches for "${q}" (computed):\n${r.hits.map(h => `${h.file}:${h.line}  ${h.text}`).join('\n') || '(no matches)'}` };
    },
    deliverable: {
      description: 'Answer the query using the ranked matches in the context. Cite locations; say so if the matches do not answer it.',
      shape: { answer: '"<direct answer>"', locations: '["<file:line — why it is relevant>", ...]' },
      required: ['answer'],
    },
  }),

  veto_sdd_agent: worker('veto_sdd_agent', 'task-planner', 'Carry out the requested spec-driven-development action on this spec.', { fileArgs: ['spec_file'] }),

  veto_playwright: worker('veto_playwright', 'tester', 'Write a Playwright test for this browser scenario.', {
    deliverable: {
      description: 'Write a runnable Playwright test (TypeScript, @playwright/test) for the scenario. Veto does not run a browser; the test is for the user to run.',
      shape: { test_file: '"<suggested path, e.g. tests/e2e/buy.spec.ts>"', test_code: '"<complete test file>"', run_command: '"<how to run it>"' },
      required: ['test_code'],
    },
  }),

  // agent type depends on whether a file path was supplied
  veto_explain: (ctx) => handleAgenticWorker(
    'veto_explain',
    ctx.args,
    ctx.args?.file_path ? 'coder' : 'debugger',
    'Explain this.',
    {
      textArg: 'text',
      fileArgs: ['file_path'],
      deliverable: {
        description: 'Explain the material at the requested depth: what it does or means, how it works, and anything surprising or risky.',
        shape: { explanation: '"<markdown>"', key_points: '["<point>", ...]' },
        required: ['explanation'],
      },
    },
  ),
};
