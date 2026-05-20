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
      'Call veto_sessions_list to find available sessions; pick the most recent one matching your task',
      'Call veto_session_restore with the session_id — read the resume_instructions field first',
      'Trust the restored context. Do NOT re-read source files to orient yourself — that defeats session restore and wastes tokens',
      'Read task_state.nextAction (or context.nextAction) — that is your starting instruction, execute it directly',
      'Read decisions[] to understand constraints already made — do not revisit them without cause',
      'Read progress.completed to know what is done — do not redo this work',
      'Read progress.remaining to know what is left before you start',
      'Only open a file if you are about to EDIT it — not to "familiarize yourself" or "verify" it',
      'If you find a file has changed since the save (e.g. a function is missing), read only that file, note the discrepancy, and continue',
      'Save a new checkpoint after restore so future sessions start from your updated state, not the old one',
    ],
    patterns: [
      'Trust-then-act: the saved session is your context — start working from nextAction immediately',
      'Read-only-to-edit: only read a file when you are about to change it, never for orientation',
      'Stale-signal: if restored context mentions a symbol that does not exist, read only that file to reconcile',
      'Checkpoint-on-restore: always save a new session immediately after restoring so the next session is current',
    ],
    gotchas: [
      'Re-reading the whole codebase after restore — this is the token-waste the tool exists to prevent; do not do it',
      'Ignoring resume_instructions and falling back to default "read all files" behavior',
      'Picking the wrong session when multiple tasks are in progress — check the task/summary field carefully',
      'Not saving a new checkpoint after restore — the next session will start from the old stale state',
      'Acting on a session saved in "blocked" state without first resolving the listed blocker',
    ],
    resources: [
      'Use the veto_session_restore MCP tool: { sessionId } → returns full session object',
      'Use the veto_sessions_list MCP tool: returns all sessions sorted by updatedAt',
      'Use the veto_session_save MCP tool after restoration to record the new starting point',
      'MCP Session spec: https://modelcontextprotocol.io/docs/concepts/resources',
    ],
  };
}
