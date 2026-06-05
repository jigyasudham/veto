// Review/scan pipelines: the triple-scan (code review + security + secrets)
// surfaced as a diff review, a CI gate, a GitHub PR review, a full review
// (triple scan + a quality pass), and a staged-changes pre-commit gate. They
// share runTripleScan/readGitDiff/buildContextString and record critical
// failures via autoStoreCritical. Bodies are the verbatim switch handlers.

import { execSync } from 'node:child_process';
import { readGitDiff, runTripleScan } from '../scan-core.js';
import { autoStoreCritical } from '../runtime.js';
import { buildContextString } from '../../context/reader.js';
import { executeOne } from '../../agents/executor.js';
import { recordOutcome } from '../../router/index.js';
import { fetchPrDiff } from '../../github/pr-fetcher.js';
import type { HandlerMap } from '../registry.js';

export const reviewHandlers: HandlerMap = {
  veto_diff_review: async ({ args }) => {
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const userContext = args?.context ? String(args.context) : undefined;

    // Resolve diff — use provided or read from git
    let diff = args?.diff ? String(args.diff).trim() : '';
    if (!diff) diff = readGitDiff(projectDir);

    if (!diff) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No diff provided and no git changes detected. Pass diff or point to a project_dir with uncommitted changes.' }) }], isError: true };
    }

    // Parse changed files from diff header lines
    const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);

    const context = buildContextString(projectDir, userContext);
    const scanResult = await runTripleScan(diff, context, true, args?.agent_outputs as any);
    if ('mode' in scanResult && scanResult.mode === 'agentic_loop') return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
    if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult) }] };
    const { reviewResult, secResult, secretsResult, verdict } = scanResult as any;
    const verdictEmoji = verdict === 'pass' ? '✅ PASS' : verdict === 'warn' ? '⚠️  WARN' : '❌ FAIL';

    // Per-file finding counts (approximate from line refs)
    const fileFindings: Record<string, number> = {};
    for (const f of changedFiles) fileFindings[f] = 0;
    for (const finding of [...(reviewResult.analysis?.findings ?? []), ...(secResult.analysis?.findings ?? [])]) {
      const match = changedFiles.find(f => finding.location?.includes(f));
      if (match) fileFindings[match]++;
    }

    if (verdict === 'fail') {
      const blockingIssues: string[] = [];
      if ((reviewResult.analysis?.critical_count ?? 0) > 0) blockingIssues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
      if ((secResult.analysis?.critical_count ?? 0) > 0) blockingIssues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
      if ((secretsResult.analysis?.findings?.length ?? 0) > 0) blockingIssues.push(`Secrets: exposed credentials detected`);
      autoStoreCritical(`Diff review failed: ${changedFiles.slice(0, 2).join(', ')}`, blockingIssues, projectDir, ['diff-review']);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict,
          verdict_label: verdictEmoji,
          files_changed: changedFiles.length,
          files: changedFiles,
          file_findings: fileFindings,
          code_review: {
            score: reviewResult.analysis?.score ?? null,
            verdict: reviewResult.analysis?.verdict ?? null,
            critical: reviewResult.analysis?.critical_count ?? 0,
            high: reviewResult.analysis?.high_count ?? 0,
            findings: reviewResult.analysis?.findings ?? [],
          },
          security: {
            score: secResult.analysis?.score ?? null,
            verdict: secResult.analysis?.verdict ?? null,
            critical: secResult.analysis?.critical_count ?? 0,
            high: secResult.analysis?.high_count ?? 0,
            findings: secResult.analysis?.findings ?? [],
          },
          secrets: {
            verdict: secretsResult.analysis?.verdict ?? null,
            findings: secretsResult.analysis?.findings ?? [],
          },
          summary: [
            `${verdictEmoji} — ${changedFiles.length} file(s) changed`,
            `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} (score ${reviewResult.analysis?.score ?? '?'}/100)`,
            `Security: ${secResult.analysis?.verdict ?? 'n/a'} — ${secResult.analysis?.critical_count ?? 0} critical, ${secResult.analysis?.high_count ?? 0} high`,
            `Secrets: ${(secretsResult.analysis?.findings?.length ?? 0) > 0 ? '🔴 Exposed credentials detected' : '✅ Clean'}`,
          ].join('\n'),
        }, null, 2),
      }],
    };
  },

  veto_ci_gate: async ({ args }) => {
    const project_dir = String(args?.project_dir ?? '').trim();
    const diff_input  = args?.diff    ? String(args.diff)    : undefined;
    const context     = args?.context ? String(args.context) : undefined;
    const fail_on     = args?.fail_on === 'warn' ? 'warn' : 'fail';

    if (!project_dir) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    }

    const start = Date.now();

    // Read diff if not provided
    let diff = diff_input;
    if (!diff) {
      try { diff = execSync('git diff HEAD', { cwd: project_dir, encoding: 'utf8', timeout: 15000 }); } catch { diff = ''; }
    }

    if (!diff?.trim()) {
      return { content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', exit_code: 0, message: 'No changes detected.', duration_ms: Date.now() - start }) }] };
    }

    const projectCtx = (() => { try { return buildContextString(project_dir); } catch { return ''; } })();
    const fullContext = [context, projectCtx].filter(Boolean).join('\n\n');

    const scanResult = await runTripleScan(diff, fullContext);
    if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
    const { reviewResult: codeResult, secResult, secretsResult, verdict } = scanResult;
    const exit_code = verdict === 'fail' || (verdict === 'warn' && fail_on === 'warn') ? 1 : 0;

    const codeScore    = codeResult.analysis?.score ?? Math.round((codeResult.output?.confidence ?? 0.8) * 100);
    const secScore     = secResult.analysis?.score  ?? Math.round((secResult.output?.confidence  ?? 0.8) * 100);
    const secretsClean = (secretsResult.analysis?.findings?.length ?? 0) === 0;

    const blocking_issues: string[] = [];
    if ((codeResult.analysis?.critical_count ?? 0) > 0) blocking_issues.push(`Code review: ${codeResult.analysis?.summary ?? 'critical issues found'}`);
    if ((secResult.analysis?.critical_count  ?? 0) > 0) blocking_issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
    if (!secretsClean) blocking_issues.push(`Secrets: ${secretsResult.analysis?.summary ?? 'exposed credentials detected'}`);

    const icon = verdict === 'pass' ? '✅' : verdict === 'warn' ? '⚠️' : '❌';
    const ci_summary = [
      `${icon} **Veto CI Gate: ${verdict.toUpperCase()}**`,
      ``,
      `| Check | Score | Status |`,
      `|---|---|---|`,
      `| Code Review | ${codeScore}% | ${(codeResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
      `| Security Scan | ${secScore}% | ${(secResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
      `| Secrets Scan | — | ${secretsClean ? '✅ Clean' : '❌ Found'} |`,
      blocking_issues.length > 0 ? `\n**Blocking issues:**\n${blocking_issues.map(i => `- ${i}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    autoStoreCritical(`CI gate failed: ${project_dir}`, blocking_issues, project_dir, ['ci-gate']);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict, exit_code,
          checks: {
            code_review: { score: codeScore, critical: codeResult.analysis?.critical_count ?? 0, high: codeResult.analysis?.high_count ?? 0 },
            security:    { score: secScore,  critical: secResult.analysis?.critical_count  ?? 0, high: secResult.analysis?.high_count  ?? 0 },
            secrets:     { clean: secretsClean, findings: secretsResult.analysis?.findings ?? [] },
          },
          blocking_issues,
          ci_summary,
          duration_ms: Date.now() - start,
        }, null, 2),
      }],
    };
  },

  veto_pr_review: async ({ args }) => {
    const pr_url  = String(args?.pr_url ?? '').trim();
    const context = args?.context ? String(args.context) : '';
    const fail_on = args?.fail_on === 'warn' ? 'warn' : 'fail';

    if (!pr_url) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'pr_url is required.' }) }], isError: true };
    }

    const start = Date.now();
    const fetched = await fetchPrDiff(pr_url);
    if (!fetched.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: fetched.error }) }], isError: true };
    }

    const { diff, meta } = fetched;
    const prContext = [
      `PR: ${meta.title} (${meta.html_url})`,
      `Author: ${meta.author} · ${meta.head_branch} → ${meta.base_branch}`,
      `Changes: +${meta.additions} -${meta.deletions} across ${meta.changed_files} files`,
      context,
    ].filter(Boolean).join('\n');

    const scanResult = await runTripleScan(diff, prContext);
    if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
    const { reviewResult, secResult, secretsResult, verdict } = scanResult;
    const exit_code = verdict === 'fail' || (verdict === 'warn' && fail_on === 'warn') ? 1 : 0;

    const codeScore    = reviewResult.analysis?.score ?? Math.round((reviewResult.output?.confidence ?? 0.8) * 100);
    const secScore     = secResult.analysis?.score    ?? Math.round((secResult.output?.confidence    ?? 0.8) * 100);
    const secretsClean = (secretsResult.analysis?.findings?.length ?? 0) === 0;

    const blocking_issues: string[] = [];
    if ((reviewResult.analysis?.critical_count ?? 0) > 0) blocking_issues.push(`Code review: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
    if ((secResult.analysis?.critical_count    ?? 0) > 0) blocking_issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
    if (!secretsClean) blocking_issues.push(`Secrets: ${secretsResult.analysis?.summary ?? 'exposed credentials detected'}`);

    // Build ready-to-post GitHub review comment (Markdown)
    const icon = verdict === 'pass' ? '✅' : verdict === 'warn' ? '⚠️' : '❌';
    const review_comment = [
      `## ${icon} Veto Review — ${verdict.toUpperCase()}`,
      ``,
      `| Check | Score | Status |`,
      `|---|---|---|`,
      `| Code Review | ${codeScore}% | ${(reviewResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
      `| Security Scan | ${secScore}% | ${(secResult.analysis?.critical_count ?? 0) === 0 ? '✅' : '❌'} |`,
      `| Secrets Scan | — | ${secretsClean ? '✅ Clean' : '❌ Found'} |`,
      ``,
      blocking_issues.length > 0
        ? `**Blocking issues:**\n${blocking_issues.map(i => `- ${i}`).join('\n')}`
        : `No blocking issues found.`,
      ``,
      `> Reviewed by [Veto](https://github.com/jigyasudham/veto) · ${meta.changed_files} files · +${meta.additions}/-${meta.deletions} · ${Date.now() - start}ms`,
    ].join('\n');

    autoStoreCritical(`PR review failed: ${meta.title}`, blocking_issues, undefined, ['pr-review']);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict, exit_code,
          pr: { title: meta.title, author: meta.author, url: meta.html_url, base: meta.base_branch, head: meta.head_branch, additions: meta.additions, deletions: meta.deletions, changed_files: meta.changed_files },
          checks: {
            code_review: { score: codeScore, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0 },
            security:    { score: secScore,  critical: secResult.analysis?.critical_count    ?? 0, high: secResult.analysis?.high_count    ?? 0 },
            secrets:     { clean: secretsClean, findings: secretsResult.analysis?.findings ?? [] },
          },
          blocking_issues,
          review_comment,
          duration_ms: Date.now() - start,
        }, null, 2),
      }],
    };
  },

  veto_full_review: async ({ args }) => {
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const userContext = args?.context ? String(args.context) : undefined;

    let diff = args?.diff ? String(args.diff).trim() : '';
    if (!diff) diff = readGitDiff(projectDir);
    if (!diff) return { content: [{ type: 'text', text: 'No diff provided and git diff failed. Provide a diff or project_dir.' }], isError: true };

    const changedFiles = [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
    const context = buildContextString(projectDir, userContext);

    const [scanResult, qualityResult] = await Promise.all([
      runTripleScan(diff, context) as any,
      executeOne({ id: 'quality-1', agent: 'code-quality', task: 'Assess overall code quality and maintainability of these changes', code: diff.slice(0, 8000), context }),
    ]);

    if ('mode' in scanResult) return { content: [{ type: 'text', text: JSON.stringify(scanResult, null, 2) }] };
    const { reviewResult, secResult, secretsResult, verdict: scanVerdict } = scanResult;

    const qualityScore = qualityResult.analysis?.score ?? Math.round(qualityResult.output.confidence * 100);
    const verdict = (scanVerdict === 'fail' || qualityScore < 40) ? 'fail'
                  : (scanVerdict === 'warn' || qualityScore < 70) ? 'warn' : 'pass';

    const issues: string[] = [];
    if (verdict === 'fail') {
      if ((reviewResult.analysis?.critical_count ?? 0) > 0) issues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
      if ((secResult.analysis?.critical_count ?? 0) > 0) issues.push(`Security: ${secResult.analysis?.summary ?? 'vulnerabilities detected'}`);
      if ((secretsResult.analysis?.findings?.length ?? 0) > 0) issues.push('Secrets: exposed credentials detected');
      if (qualityScore < 40) issues.push(`Quality: Score ${qualityScore}/100 is below the critical threshold`);
    }

    if (issues.length > 0) {
      autoStoreCritical(`Full review failed: ${changedFiles.slice(0, 2).join(', ')}`, issues, projectDir, ['full-review']);
    }

    recordOutcome('full-review', 50, 2, 'code-quality', qualityScore);

    return { content: [{ type: 'text', text: JSON.stringify({
      verdict,
      score: qualityScore,
      scans: {
        code_review: { score: reviewResult.analysis?.score ?? null, verdict: reviewResult.analysis?.verdict ?? null, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0, findings: reviewResult.analysis?.findings ?? [] },
        security:    { score: secResult.analysis?.score ?? null, verdict: secResult.analysis?.verdict ?? null, critical: secResult.analysis?.critical_count ?? 0, high: secResult.analysis?.high_count ?? 0, findings: secResult.analysis?.findings ?? [] },
        secrets:     { verdict: secretsResult.analysis?.verdict ?? null, findings: secretsResult.analysis?.findings ?? [] },
      },
      findings: [
        `Quality: ${qualityScore}/100 (${verdict})`,
        `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} (score ${reviewResult.analysis?.score ?? '?'}/100)`,
        `Security: ${secResult.analysis?.verdict ?? 'n/a'} — ${secResult.analysis?.critical_count ?? 0} critical, ${secResult.analysis?.high_count ?? 0} high`,
        `Secrets: ${(secretsResult.analysis?.findings?.length ?? 0) > 0 ? '🔴 Exposed credentials detected' : '✅ Clean'}`,
      ],
      files_changed: changedFiles,
    }, null, 2) }] };
  },

  veto_pre_commit: async ({ args }) => {
    const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
    const userContext = args?.context ? String(args.context) : undefined;

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    const diff = readGitDiff(projectDir, true);
    if (!diff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No staged changes found. Stage files with git add before running veto_pre_commit.' }) }], isError: true };

    const context = buildContextString(projectDir, userContext);
    const [secretsResult, reviewResult] = await Promise.all([
      executeOne({ id: 'pre-secrets', agent: 'secrets',  task: 'Scan staged changes for exposed secrets or credentials', code: diff }),
      executeOne({ id: 'pre-review',  agent: 'reviewer', task: 'Review staged changes for critical code quality issues', code: diff, context }),
    ]);

    const hasSecrets = (secretsResult.analysis?.findings?.length ?? 0) > 0;
    const hasCriticalCode = (reviewResult.analysis?.critical_count ?? 0) > 0;
    const verdict = (hasSecrets || hasCriticalCode) ? 'fail' : (reviewResult.analysis?.high_count ?? 0) > 0 ? 'warn' : 'pass';
    const verdictEmoji = verdict === 'pass' ? '✅ PASS' : verdict === 'warn' ? '⚠️  WARN' : '❌ FAIL';

    if (verdict === 'fail') {
      const issues: string[] = [];
      if (hasSecrets) issues.push('Secrets: exposed credentials detected');
      if (hasCriticalCode) issues.push(`Code: ${reviewResult.analysis?.summary ?? 'critical issues found'}`);
      autoStoreCritical(`Pre-commit blocked: ${projectDir}`, issues, projectDir, ['pre-commit']);
    }
    recordOutcome('pre-commit', 50, 2, 'secrets',  hasSecrets ? 0 : 100);
    recordOutcome('pre-commit', 50, 2, 'reviewer', reviewResult.analysis?.score ?? Math.round(reviewResult.output.confidence * 100));

    return { content: [{ type: 'text', text: JSON.stringify({
      pipeline: 'pre_commit',
      verdict,
      verdict_label: verdictEmoji,
      blocked: verdict === 'fail',
      secrets:     { found: hasSecrets, findings: secretsResult.analysis?.findings ?? [] },
      code_review: { score: reviewResult.analysis?.score ?? null, critical: reviewResult.analysis?.critical_count ?? 0, high: reviewResult.analysis?.high_count ?? 0, findings: reviewResult.analysis?.findings ?? [] },
      summary: [
        `${verdictEmoji} — Pre-commit check`,
        `Secrets: ${hasSecrets ? '🔴 Found — commit BLOCKED' : '✅ Clean'}`,
        `Code: ${reviewResult.analysis?.verdict ?? 'n/a'} — ${reviewResult.analysis?.critical_count ?? 0} critical, ${reviewResult.analysis?.high_count ?? 0} high`,
      ].join('\n'),
    }, null, 2) }] };
  },
};
