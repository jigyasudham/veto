// Skill: session-restore — guide to restoring context from a saved session

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'session-restore',
    template: undefined,
    checklist: [
      'Call veto_sessions_list to get all available saved sessions',
      'Identify the most relevant session: sort by updatedAt descending, read the task summary',
      'If multiple sessions match the current task, read the top 2-3 and pick the most recent',
      'Call veto_session_restore with the selected sessionId to load the full session object',
      'Read the phase field to understand where work was left off (planning/implementing/reviewing/blocked)',
      'Read progress.completed to know what has already been done — do not redo this work',
      'Read progress.inProgress to know the exact subtask that was interrupted',
      'Read progress.remaining to understand the full remaining scope before starting',
      'Read decisions to understand constraints and design choices already made — do not revisit them without cause',
      'Read findings to get codebase context (key files, discovered patterns, constraints)',
      'Read blockers: if any blockers are listed, address them before continuing other work',
      'Read nextAction and treat it as the starting instruction for this session',
      'Re-read any key files mentioned in findings.filePaths before making changes',
      'Verify that the code state matches expectations: if the session is old, re-check completed items',
      'Save a new session checkpoint immediately after restoring and verifying context',
    ],
    patterns: [
      'Restore-verify-continue: always verify actual code state matches what the session recorded before acting',
      'Trust but verify: session describes intent; re-read key files to confirm they match expectations',
      'Single source of truth: the saved session is authoritative about decisions and progress',
      'Restore at the start of every new conversation before doing any work on a multi-session task',
    ],
    gotchas: [
      'Restoring an old session and acting on stale file paths — files may have been moved or deleted',
      'Skipping the verify step and redoing work already marked as completed — wastes time and may undo changes',
      'Picking the wrong session when multiple tasks are in progress — check the task field carefully',
      'Not saving a new checkpoint after restore — the next session will still start from the old state',
      'Trusting a session that was saved in a "blocked" state without first resolving the blocker',
    ],
    resources: [
      'Use the veto_session_restore MCP tool: { sessionId } → returns full session object',
      'Use the veto_sessions_list MCP tool: returns all sessions sorted by updatedAt',
      'Use the veto_session_save MCP tool after restoration to record the new starting point',
      'MCP Session spec: https://modelcontextprotocol.io/docs/concepts/resources',
    ],
  };
}
