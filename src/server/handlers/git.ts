// Git/GitHub tools: blame/ownership summary, conventional changelog, AI-written
// commit message and PR description (from the staged/branch diff), and posting a
// review to a GitHub PR via the REST API. The agent-backed ones share the
// executeOne + recordOutcome shape; blame/changelog are pure git plumbing.

import { statSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { recordOutcome } from '../../router/index.js';
import { readGitDiff, runHandlerAgent, handlerAgentResponse } from '../scan-core.js';
import { getActiveProjectDir } from '../runtime.js';
import type { WorkerAgentType } from '../../agents/types.js';
import type { HandlerMap } from '../registry.js';

export const gitHandlers: HandlerMap = {
  veto_git_blame: ({ args }) => {
    const blameDir  = args?.project_dir ? String(args.project_dir).trim() : '';
    const blameFile = args?.file_path   ? String(args.file_path).trim()   : '';
    const blameTarget = blameFile || blameDir;

    if (!blameTarget) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide project_dir or file_path.' }) }], isError: true };
    }

    // A relative file_path is relative to project_dir, not to wherever the
    // server happens to run (it used to resolve against the server's own cwd).
    const resolvedTarget = blameFile && blameDir && !isAbsolute(blameFile) ? resolve(blameDir, blameFile) : resolve(blameTarget);
    try { statSync(resolvedTarget); } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Path not found: ${resolvedTarget}` }) }], isError: true };
    }

    function gitExec(cmd: string, cwd: string): string {
      try { return execSync(cmd, { windowsHide: true, cwd, timeout: 5000, stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
      catch { return ''; }
    }

    const cwd = statSync(resolvedTarget).isDirectory() ? resolvedTarget : dirname(resolvedTarget);

    const shortlog = gitExec(`git shortlog -sn -- "${resolvedTarget}"`, cwd);
    const contributors = shortlog.split('\n').filter(Boolean).map(line => {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      return m ? { commits: parseInt(m[1], 10), author: m[2].trim() } : null;
    }).filter(Boolean);

    const lastModified = gitExec(`git log -1 --format="%ai|%aN|%s" -- "${resolvedTarget}"`, cwd);
    const [last_modified_at, last_author, last_commit_message] = lastModified.split('|');

    const totalCommits = gitExec(`git rev-list --count HEAD -- "${resolvedTarget}"`, cwd);

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      path: resolvedTarget,
      total_commits: parseInt(totalCommits || '0', 10),
      contributors,
      last_modified_at: last_modified_at?.trim(),
      last_author: last_author?.trim(),
      last_commit_message: last_commit_message?.trim(),
    }, null, 2) }] };
  },

  veto_changelog: ({ args }) => {
    const changelogDir = args?.project_dir ? String(args.project_dir).trim() : getActiveProjectDir() ?? process.cwd();
    const maxEntries   = typeof args?.max_entries === 'number' ? Math.min(args.max_entries, 200) : 50;

    const resolvedDir = resolve(changelogDir);
    try { statSync(resolvedDir); } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Directory not found: ${resolvedDir}` }) }], isError: true };
    }

    function gitRun(cmd: string): string {
      try { return execSync(cmd, { windowsHide: true, cwd: resolvedDir, timeout: 5000, stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
      catch { return ''; }
    }

    // stderr is already piped; a shell redirect here broke under cmd.exe.
    const lastTag = gitRun('git describe --tags --abbrev=0') || '';
    const range   = lastTag ? `${lastTag}..HEAD` : 'HEAD';
    const rawLog  = gitRun(`git log ${range} --format="%s|||%H|||%aN|||%ai" --no-merges -n ${maxEntries}`);

    if (!rawLog) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, since_tag: lastTag || 'beginning', entries: [], message: 'No commits found in range.' }) }] };
    }

    const typeLabels: Record<string, string> = {
      feat: 'Features', fix: 'Bug Fixes', refactor: 'Refactoring', perf: 'Performance',
      docs: 'Documentation', test: 'Tests', chore: 'Chores', ci: 'CI/CD',
      style: 'Style', build: 'Build', revert: 'Reverts',
    };

    const grouped: Record<string, Array<{ message: string; hash: string; author: string; date: string }>> = {};

    for (const line of rawLog.split('\n').filter(Boolean)) {
      const [subject, hash, author, date] = line.split('|||');
      if (!subject) continue;
      const typeMatch = subject.match(/^(\w+)(\([\w-]+\))?:\s*(.*)/);
      const type  = typeMatch ? typeMatch[1].toLowerCase() : 'other';
      const msg   = typeMatch ? typeMatch[3] : subject;
      const label = typeLabels[type] ?? 'Other';
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push({ message: msg.trim(), hash: hash?.trim().slice(0, 8) ?? '', author: author?.trim() ?? '', date: date?.trim().slice(0, 10) ?? '' });
    }

    const sections = Object.entries(grouped).map(([section, items]) => ({ section, items }));

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      since_tag: lastTag || '(beginning of history)',
      total_commits: rawLog.split('\n').filter(Boolean).length,
      sections,
    }, null, 2) }] };
  },

  veto_commit_message: async ({ args }) => {
    const projectDir = String(args?.project_dir ?? '').trim();
    const hint       = args?.hint ? String(args.hint) : undefined;

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    const diff = readGitDiff(projectDir, true);
    if (!diff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No staged changes. Run git add first.' }) }], isError: true };

    const truncatedDiff = diff.slice(0, 6000);

    const run = await runHandlerAgent('veto_commit_message', {
      id:      'commit-msg-1',
      agent:   'git-agent' as WorkerAgentType,
      task:    'Write the commit message for these staged changes.',
      code:    truncatedDiff,
      context: hint,
      project_dir: projectDir,
      deliverable: {
        description: 'Write a Conventional Commits message for the staged diff in the material: "type(scope): subject" (types feat/fix/docs/chore/refactor/test/perf/ci/build/style, subject ≤ 72 characters, imperative), then a blank line and a short body saying what changed and why. Describe only what the diff shows.',
        shape: { message: '"<the full commit message>"' },
        required: ['message'],
      },
    }, args?.agent_response);

    const message = typeof run.deliverable?.message === 'string' ? run.deliverable.message.trim() : null;
    const firstLine = message?.split('\n')[0] ?? '';
    const match = firstLine.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)/);
    recordOutcome('commit-message', 50, 2, 'git-agent', message ? (match ? 85 : 60) : 40);

    return handlerAgentResponse({
      message,
      type:       match ? match[1] : null,
      scope:      match ? (match[2] ?? null) : null,
      subject:    match ? match[3] : null,
      conventional: message ? Boolean(match) : null,
      subject_length: match ? firstLine.length : null,
      files_staged: [...truncatedDiff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]),
    }, run, { generated: ['message', 'type', 'scope', 'subject', 'conventional', 'subject_length'] });
  },

  veto_pr_description: async ({ args }) => {
    const projectDir  = String(args?.project_dir ?? '').trim();
    const baseBranch  = args?.base_branch ? String(args.base_branch) : 'main';
    const titleHint   = args?.title   ? String(args.title)   : undefined;
    const userContext = args?.context ? String(args.context) : undefined;

    if (!projectDir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };

    let stat = '';
    let commitLog = '';
    try {
      stat      = execSync(`git diff ${baseBranch}...HEAD --no-color --stat`,  { windowsHide: true, cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      commitLog = execSync(`git log ${baseBranch}...HEAD --oneline`,            { windowsHide: true, cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    } catch (e) {
      if (!stat && !commitLog) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `git diff failed: ${(e as Error).message}` }) }], isError: true };
    }

    let fullDiff = '';
    try {
      fullDiff = execSync(`git diff ${baseBranch}...HEAD --no-color`, { windowsHide: true, cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    } catch { /* ignore */ }

    const contextParts: string[] = [];
    if (titleHint)   contextParts.push(`PR Title: ${titleHint}`);
    if (userContext) contextParts.push(`Context: ${userContext}`);
    if (commitLog)   contextParts.push(`Commits:\n${commitLog}`);
    if (stat)        contextParts.push(`Diff stat:\n${stat}`);
    const builtContext = contextParts.join('\n\n');

    const run = await runHandlerAgent('veto_pr_description', {
      id:          'pr-desc-1',
      agent:       'documentation' as WorkerAgentType,
      task:        'Write the pull request title and description for this branch.',
      code:        fullDiff.slice(0, 8000),
      context:     builtContext || undefined,
      project_dir: projectDir,
      deliverable: {
        description: "Write a GitHub pull request for the diff and commits in the material. Body sections: ## Summary (3-5 bullets: what changed and why), ## Changes (per file, from the diff stat), ## Test Plan (checklist to verify), ## Breaking Changes ('None' if none). Only describe what the diff shows.",
        shape: { title: '"<≤ 72 characters>"', body: '"<markdown>"' },
        required: ['title', 'body'],
      },
    }, args?.agent_response);

    const body = typeof run.deliverable?.body === 'string' ? run.deliverable.body.trim() : null;
    const title = titleHint ?? (typeof run.deliverable?.title === 'string' ? run.deliverable.title.trim() : null);
    recordOutcome('pr-description', 50, 2, 'documentation', body ? 80 : 40);

    return handlerAgentResponse({
      title,
      body,
      base_branch: baseBranch,
      commits:     commitLog ? commitLog.split('\n').filter(Boolean) : [],
      diff_stat:   stat || null,
    }, run, { generated: titleHint ? ['body'] : ['title', 'body'] });
  },

  veto_pr_post: async ({ args }) => {
    const m = String(args?.pr_url ?? '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Invalid PR URL. Expected: https://github.com/owner/repo/pull/123' }) }], isError: true };
    const [, owner, repo, prNum] = m;

    if (!process.env.GITHUB_TOKEN) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'GITHUB_TOKEN env var not set' }) }], isError: true };

    const findings: Array<{ severity: string; message: string; location?: string }> =
      Array.isArray(args?.findings) ? args.findings : [];
    const eventVal = String(args?.event ?? '');
    const event = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(eventVal) ? eventVal : 'COMMENT';

    // Findings go in the review body. They used to be sent as inline review
    // comments with no `path`/`line`, which GitHub rejects (422) — so any
    // review with a critical or high finding failed to post at all. Inline
    // comments also need the line to be part of the diff, which Veto cannot
    // guarantee, and one bad line fails the whole review.
    const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const listed = [...findings].sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5)).slice(0, 50);
    const summary = `Veto review: ${findings.length} finding(s) — ${findings.filter(f => f.severity === 'critical' || f.severity === 'high').length} critical/high`;
    const list = listed.map(f => `- **[${String(f.severity).toUpperCase()}]** ${f.message}${f.location ? ` — \`${f.location}\`` : ''}`).join('\n');
    const reviewBody = [args?.body ? String(args.body) : summary, list].filter(Boolean).join('\n\n')
      + (findings.length > listed.length ? `\n\n…and ${findings.length - listed.length} more.` : '');

    const prPostUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/reviews`;
    const prPostHeaders: Record<string, string> = {
      'User-Agent': 'veto-mcp-server',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    };
    const prPostResp = await fetch(prPostUrl, {
      method: 'POST',
      headers: prPostHeaders,
      body: JSON.stringify({ body: reviewBody, event }),
    });
    if (!prPostResp.ok) {
      const err = await prPostResp.text();
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `GitHub API error ${prPostResp.status}: ${err.slice(0, 200)}` }) }], isError: true };
    }
    const review = await prPostResp.json() as { id: number; html_url: string; state: string };

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      review_id: review.id,
      review_url: review.html_url,
      event,
      findings_posted: listed.length,
      total_findings: findings.length,
    }, null, 2) }] };
  },
};
