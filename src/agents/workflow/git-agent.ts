import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isMerge = t.includes('merge') || t.includes('conflict') || t.includes('rebase');
  const isPR = t.includes('pull request') || t.includes('pr') || t.includes('review');
  const isCommit = t.includes('commit') || t.includes('stage') || t.includes('message');

  const approach = isMerge
    ? 'Resolve merge conflicts by understanding what both sides intended, not just what they changed. Read both versions, understand the goal of each change, then write a resolution that preserves both intentions. Never resolve a conflict by picking one side blindly.'
    : isPR
    ? 'Structure the PR to make review fast: one clear title (what changed), a summary paragraph (why), a numbered list of changes (what files/functions), and a test plan. Small PRs merge faster than large ones — if the PR touches more than 10 files, split it.'
    : isCommit
    ? 'Write commit messages that explain WHY, not what. The diff shows what changed. The commit message tells future maintainers why. Format: imperative verb subject (50 chars), blank line, body if needed (72 chars per line).'
    : 'Execute the git operation safely. For destructive operations (reset --hard, force push, branch delete): state the exact command and its consequences before running. Never force-push a shared branch without explicit instruction.';

  return {
    agent: 'git-agent' as WorkerAgentType,
    task,
    tier: 1,
    approach,
    steps: [
      'Identify the git operation needed: commit, branch, merge, rebase, tag, PR',
      'For destructive operations: state what will be lost and confirm before running',
      'For commits: stage only the relevant files — never git add -A blindly',
      'Write a commit message: imperative verb, 50 char subject, body if needed',
      'For merges: read both sides of each conflict before resolving',
      'For PRs: title (what), summary (why), change list (how), test plan',
      'For branch cleanup: verify the branch is fully merged before deleting',
      'For rebases: ensure the branch is not shared with others before rewriting history',
    ],
    checklist: [
      '[ ] No accidental files staged (check git diff --staged before committing)',
      '[ ] Commit message is imperative and explains WHY',
      '[ ] No force-push to shared branches without explicit instruction',
      '[ ] Merge conflicts resolved by understanding intent, not picking one side',
      '[ ] Branch verified as merged before deletion',
      '[ ] .env, credentials, and secrets not included in staged files',
    ],
    pitfalls: [
      'git add -A without reviewing what is staged — accidentally commits secrets or build artifacts',
      'Commit messages that describe what the diff shows — useless to future maintainers',
      'Force-pushing a branch others have cloned — rewrites their history',
      'Resolving merge conflicts by always taking "ours" — loses the other branch\'s intent',
      'Deleting a branch before verifying it is merged — loses work',
    ],
    patterns: [
      'Why-first commit messages: the diff shows what; the message explains why',
      'Surgical staging: add specific files, not directories, to keep commits atomic',
      'Pre-commit diff review: git diff --staged before every commit to catch surprises',
      'Branch lifecycle: feature → PR → merge → delete (never skip the verify-merged step)',
    ],
    duration_estimate: '15-45 minutes',
  };
}
