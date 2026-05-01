import { AgentPlan, WorkerAgentType } from '../types.js';

type ContextCategory = 'session-start' | 'mid-task' | 'context-switch' | 'compression' | 'general';

function detectCategory(task: string): ContextCategory {
  const t = task.toLowerCase();
  if (t.includes('start') || t.includes('begin') || t.includes('new session') || t.includes('initialize')) return 'session-start';
  if (t.includes('compress') || t.includes('trim') || t.includes('reduce') || t.includes('shrink') || t.includes('token')) return 'compression';
  if (t.includes('switch') || t.includes('handoff') || t.includes('transfer') || t.includes('gemini') || t.includes('codex')) return 'context-switch';
  if (t.includes('mid') || t.includes('checkpoint') || t.includes('save') || t.includes('continue')) return 'mid-task';
  return 'general';
}

const categoryApproach: Record<ContextCategory, string> = {
  'session-start': 'Load prior session via veto_session_restore. Identify the active project, last completed task, and immediate next action. Build a compact working context — goals, constraints, key files, recent decisions. Discard old context that no longer applies.',
  'mid-task': 'Snapshot current progress to context: completed subtasks, in-progress work, emerging blockers. Trim historical conversation that is no longer load-bearing. Keep all active decisions and constraints live. Evaluate whether token budget warrants a save-and-compress cycle.',
  'context-switch': 'Serialize current context to a portable session snapshot. Include task state, file manifest, active decisions, and next action. Write to veto_session_save. Confirm the receiving platform can restore and resume without re-reading source files.',
  'compression': 'Identify context tiers: critical (keep verbatim), summarisable (compress to 1–3 sentences), droppable (no longer relevant). Apply the router\'s context-compressor module. Target < 30% of original token count while preserving all active constraints and decisions.',
  'general': 'Audit the current context window for relevance. Remove completed subtasks, resolved blockers, and superseded decisions. Elevate forward-looking content — pending work, live constraints, open questions. Summarise historical content to 1–2 sentences per topic.',
};

const categorySteps: Record<ContextCategory, string[]> = {
  'session-start': [
    'Call veto_sessions_list to find the most recent session for this project directory',
    'Call veto_session_restore with the session ID to load prior context',
    'Parse the restored task_state to identify completed, in-progress, and remaining work',
    'Call veto_memory_search with the project_dir to load relevant knowledge base entries',
    'Call veto_project_map_get to load the current codebase structure',
    'Synthesise a compact active-context object: goals, constraints, key files, decisions',
    'Identify the single most important next action and make it the session focus',
    'Discard any context older than the last significant decision or file change',
  ],
  'mid-task': [
    'List what has been completed since the last save',
    'Identify what is currently in progress and what is blocked',
    'Score each context item: critical | summarisable | droppable',
    'Draft a compressed context string using summarisable items',
    'Trigger a session save if token count exceeds 8,000 or a subtask just completed',
    'Record any new decisions or discoveries to veto_memory_store',
    'Update the project map if new files were created or deleted',
    'Verify the next action is concrete and unambiguous',
  ],
  'context-switch': [
    'Freeze the current session: write final progress state',
    'Call veto_session_save with full task_state including phase, progress, decisions',
    'Note the session ID — give it to the human to paste into the receiving platform',
    'Confirm the session summary is self-contained (receiving agent needs no prior context)',
    'Include the file manifest for files that were read or modified this session',
    'Include the single next action as the last line of the context',
    'Verify the save by calling veto_sessions_list and inspecting the new row',
  ],
  'compression': [
    'Count current context tokens using the router\'s compressor estimate',
    'Identify the compression target: what percentage reduction is needed?',
    'Categorise each context block: verbatim | summarise | drop',
    'Keep all active constraints, open blockers, and pending tasks verbatim',
    'Summarise historical completed work to one sentence per subtask',
    'Drop resolved blockers, superseded decisions, and read-back confirmations',
    'Verify compressed context passes a completeness check: can the task still be continued?',
    'Save the compressed state as a new session checkpoint',
  ],
  'general': [
    'Audit the context for items that are no longer relevant to the current task phase',
    'Identify decisions that have been superseded and mark them deprecated',
    'Summarise completed subtask history into single-sentence progress notes',
    'Elevate forward-looking items to the top of the active context',
    'Ensure all active file paths and module names are accurate (not stale)',
    'Record new patterns or solutions to the knowledge base',
    'Save the refined context as a session checkpoint',
  ],
};

const categoryChecklist: Record<ContextCategory, string[]> = {
  'session-start': [
    '[ ] Prior session restored via veto_session_restore',
    '[ ] Task phase identified: planning | implementing | reviewing | blocked',
    '[ ] Completed subtasks listed — no re-doing finished work',
    '[ ] Remaining subtasks listed in priority order',
    '[ ] All active file paths verified to exist',
    '[ ] Active constraints and decisions loaded from session',
    '[ ] Knowledge base queried for relevant prior solutions',
    '[ ] Project map loaded — key modules and entry points known',
    '[ ] Next action is a single concrete step, not a vague direction',
  ],
  'mid-task': [
    '[ ] Progress snapshot written: completed, in-progress, remaining',
    '[ ] New decisions or discoveries logged to knowledge base',
    '[ ] Stale context removed — no completed blockers still listed as active',
    '[ ] Session saved if checkpoint warranted (> 8k tokens or subtask complete)',
    '[ ] Project map updated if files were added or removed',
    '[ ] Next action re-confirmed: single concrete step',
  ],
  'context-switch': [
    '[ ] Session saved with full task_state before switching platforms',
    '[ ] Session ID recorded and ready to give to receiving platform',
    '[ ] Summary is self-contained — receiving agent needs no prior context',
    '[ ] File manifest included in session save',
    '[ ] Next action is the final line of the context',
    '[ ] Receiving platform tested with veto_session_restore before committing to switch',
  ],
  'compression': [
    '[ ] Original token count measured before compression',
    '[ ] Compression target set (aim for < 30% of original)',
    '[ ] All active constraints preserved verbatim',
    '[ ] Completed work compressed to one sentence per subtask',
    '[ ] No active blockers or decisions removed',
    '[ ] Compressed context passes completeness check',
    '[ ] Compressed state saved as new session checkpoint',
  ],
  'general': [
    '[ ] Context audit completed — stale items removed',
    '[ ] All file paths verified to be current',
    '[ ] Decisions table up to date — no deprecated decisions still marked accepted',
    '[ ] Knowledge base updated with new findings',
    '[ ] Session saved with current state',
    '[ ] Next action is concrete and prioritised',
  ],
};

const categoryPitfalls: Record<ContextCategory, string[]> = {
  'session-start': [
    'Starting work before restoring prior session — redoing completed subtasks',
    'Loading the session but ignoring the task_state — treating the session as read-only',
    'Not checking the project map — assuming file structure from memory instead of current state',
    'Taking the next action from the prior session without checking if it is still valid',
  ],
  'mid-task': [
    'Waiting until 50k tokens to compress — forces an emergency compression that risks losing context',
    'Saving a session without a nextAction — the restoring agent starts from scratch',
    'Not recording decisions to the knowledge base — the same decision gets relitigated next session',
    'Updating the project map only on session end — missing interim file creates/deletes',
  ],
  'context-switch': [
    'Switching platforms without calling veto_session_save first — all progress lost',
    'Including raw file contents in the session save instead of file paths — balloons token cost',
    'Not testing restore on the receiving platform before committing to the switch',
    'Switching while a destructive operation (migration, deploy) is in progress',
  ],
  'compression': [
    'Compressing active constraints as if they were completed work — causes silent constraint violations',
    'Over-compressing: removing the rationale for active decisions — future agent reverses them',
    'Not saving the compressed context — compression is lost at next context switch',
    'Targeting a fixed token number without checking completeness — may cut load-bearing context',
  ],
  'general': [
    'Context drift: the active context describes a different version of the task than the current one',
    'Stale file paths in context that no longer exist in the project',
    'Decisions still listed as "proposed" that have already been implemented',
    'Context growing monotonically without pruning — each session inherits all prior context',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'context-manager' as WorkerAgentType,
    task,
    tier: 1,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: categoryPitfalls[category],
    patterns: [
      'Checkpoint pattern: save context at phase boundaries, not only at session end',
      'Minimal viable context: enough to resume work, not a full transcript',
      'Tiered retention: verbatim | summarised | dropped — never binary keep/delete',
      'Forward-first ordering: next actions at the top, completed history at the bottom',
    ],
    duration_estimate: '5-15 minutes',
  };
}
