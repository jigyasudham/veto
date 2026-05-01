// Skill: session-save — when and how to save MCP sessions

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

const TEMPLATE = `
// ── What to include in a session save ────────────────────────────────────
//
// A session save should capture enough context so that a future agent
// can resume work without re-reading all the source files.
//
// Recommended session object shape:
{
  "task": "The original task description in one sentence",
  "phase": "planning | implementing | reviewing | blocked | complete",
  "progress": {
    "completed": ["List of finished subtasks or files written"],
    "inProgress": ["Current subtask being worked on"],
    "remaining": ["Subtasks still to do"]
  },
  "decisions": [
    {
      "decision": "What was decided",
      "rationale": "Why this approach was chosen",
      "alternatives": ["Other options that were considered"],
      "timestamp": "ISO 8601 timestamp"
    }
  ],
  "findings": [
    "Any important discoveries that affect future work",
    "File paths of key files that were read or modified",
    "Patterns or constraints discovered in the codebase"
  ],
  "blockers": [
    "Anything preventing progress that needs human input"
  ],
  "nextAction": "The single most important next step to resume work"
}
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'session-save',
    template: TEMPLATE,
    checklist: [
      'Save at the start of every new significant phase: planning, implementing, reviewing',
      'Save after completing each major file or subtask — checkpoint before moving to the next',
      'Save before any risky operation (file overwrites, schema migrations, destructive commands)',
      'Save immediately when a blocker is encountered that requires human input',
      'Save when token context is getting large — a compact save enables a fresh continuation',
      'Include the original task description verbatim so it is never lost across sessions',
      'Include current phase: planning / implementing / reviewing / blocked / complete',
      'Include progress: completed[], inProgress[], remaining[] as concrete task lists',
      'Include decisions made: decision + rationale + alternatives considered',
      'Include codebase findings: key file paths discovered, constraints, patterns found',
      'Include blockers: anything requiring human action before work can continue',
      'Include nextAction: the single most important next step as a concrete instruction',
      'Keep each save concise — aim for < 500 tokens; link to files rather than copying content',
      'Use the veto_session_save MCP tool to persist the session to SQLite',
      'Verify the save succeeded by calling veto_sessions_list and confirming the session appears',
    ],
    patterns: [
      'Checkpoint pattern: save after each completed unit of work, not only at the end',
      'Progressive detail: early saves capture intent; later saves add findings and decisions',
      'Minimal viable context: save enough to resume, not a full transcript of every action',
      'Blocker-first save: when stuck, save immediately with the blocker clearly stated',
    ],
    gotchas: [
      'Not saving before a context switch — the next session starts blind without a save',
      'Saving too much detail — a 5,000-token session save is expensive to restore and read',
      'Forgetting to include nextAction — the restoring agent does not know where to start',
      'Saving only at the very end — if the task fails partway through, the intermediate work is lost',
      'Using vague phase descriptions ("working") instead of concrete phases (implementing step 3 of 7)',
    ],
    resources: [
      'Use the veto_session_save MCP tool: { sessionId, task, phase, progress, decisions, findings }',
      'Use the veto_sessions_list MCP tool to verify saves and list available sessions',
      'Use the veto_session_restore MCP tool to reload a previous session',
      'MCP Session spec: https://modelcontextprotocol.io/docs/concepts/resources',
    ],
  };
}
