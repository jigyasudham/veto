import { AgentPlan, WorkerAgentType } from '../types.js';

type KBCategory = 'store-solution' | 'search' | 'dedup' | 'general';

function detectCategory(task: string): KBCategory {
  const t = task.toLowerCase();
  if (t.includes('store') || t.includes('save') || t.includes('record') || t.includes('add to') || t.includes('log solution')) return 'store-solution';
  if (t.includes('find') || t.includes('search') || t.includes('retrieve') || t.includes('look up') || t.includes('query')) return 'search';
  if (t.includes('dedup') || t.includes('duplicate') || t.includes('clean') || t.includes('merge')) return 'dedup';
  return 'general';
}

const categoryApproach: Record<KBCategory, string> = {
  'store-solution': 'Before storing, check for a similar existing entry via veto_memory_search to avoid duplicates. If found, update the existing entry. If new, store via veto_memory_store with a precise title, type classification (solution/pattern/error/reference), relevant tags, and the project_dir for scoped retrieval. A good knowledge entry is self-contained: a future agent should understand and apply it without the original context.',
  'search': 'Query the knowledge base via veto_memory_search before starting any task. Use type filters and tags to narrow results. Combine a keyword query with the project_dir filter for project-scoped results. Search for prior errors before debugging — the same error may already be solved. Search for patterns before writing code — the established style may already be documented.',
  'dedup': 'Search for entries with similar titles using multiple keyword variants. Group semantically similar entries. Merge by: keeping the entry with higher relevance, combining the content, and deleting the duplicate. Update the merged entry\'s tags to include all tags from both entries.',
  'general': 'Check the knowledge base at the start of every task (veto_memory_search). Store new solutions, discovered patterns, and resolved errors after every task. Keep entries self-contained and searchable. Prune stale entries that no longer apply to the current codebase version.',
};

const categorySteps: Record<KBCategory, string[]> = {
  'store-solution': [
    'Identify what type this entry is: solution | pattern | error | reference | decision | context',
    'Write a precise, searchable title (not "Fixed the bug" — use "Fix: Node 22 sqlite binding fails on Windows without --experimental-sqlite flag")',
    'Write content that is self-contained: problem statement → root cause → solution steps → outcome',
    'Choose 3–5 tags that describe the topic, technology, and error category',
    'Set project_dir if this is project-specific knowledge (not general programming knowledge)',
    'Search veto_memory_search for similar entries before storing',
    'If a similar entry exists: update it, do not create a duplicate',
    'If new: call veto_memory_store with all fields populated',
    'Confirm storage by searching for the entry by title',
  ],
  'search': [
    'Identify the key terms of what you are searching for',
    'Call veto_memory_search with query=key terms, type filter if known',
    'If results are empty: try synonyms or broader terms',
    'Add project_dir filter for project-specific knowledge',
    'Read the top 3 results — check relevance and recency',
    'If an old result has been superseded by a newer approach, mark the old entry for deletion',
    'Apply the found solution or pattern directly if the context matches',
    'If the context is different from the stored entry, adapt the solution and update the entry with the new context',
  ],
  'dedup': [
    'Search for entries with the same title or very similar titles',
    'Search for entries with the same tags to find topic overlap',
    'Group semantically similar entries',
    'For each duplicate group: identify the most complete and accurate entry to keep',
    'Merge content: combine unique information from all entries into the survivor',
    'Merge tags: union of all tags across the group',
    'Set the survivor\'s relevance to the maximum of the group',
    'Delete duplicate entries via veto_memory_search (note IDs) + internal delete',
    'Confirm dedup by re-running the search — only one entry should appear per topic',
  ],
  'general': [
    'At session start: call veto_memory_search with the current task description',
    'Review results for prior solutions, patterns, or errors that apply to this task',
    'During the task: note any new solutions, patterns, or errors discovered',
    'At session end: store all new knowledge via veto_memory_store',
    'Check for duplicates before each store',
    'Periodically review low-relevance entries and delete stale ones',
    'Keep the knowledge base scoped: use project_dir for project-specific entries',
  ],
};

const categoryChecklist: Record<KBCategory, string[]> = {
  'store-solution': [
    '[ ] Type classification chosen: solution | pattern | error | reference | decision | context',
    '[ ] Title is precise and searchable — not vague',
    '[ ] Content is self-contained (problem → root cause → solution)',
    '[ ] At least 3 tags chosen',
    '[ ] project_dir set if project-specific',
    '[ ] Duplicate search performed before storing',
    '[ ] Entry confirmed via follow-up search',
  ],
  'search': [
    '[ ] Knowledge base queried before starting the task',
    '[ ] Synonyms tried if initial query returns empty results',
    '[ ] Top 3 results evaluated for relevance',
    '[ ] Stale results flagged for deletion',
    '[ ] Found solution adapted to current context if needed',
  ],
  'dedup': [
    '[ ] Title-based and tag-based search performed',
    '[ ] Duplicate groups identified',
    '[ ] Best entry per group selected',
    '[ ] Content merged',
    '[ ] Tags merged',
    '[ ] Duplicates deleted',
    '[ ] Dedup confirmed by re-search',
  ],
  'general': [
    '[ ] Knowledge base searched at session start',
    '[ ] New knowledge stored at session end',
    '[ ] No duplicates created',
    '[ ] Stale entries reviewed',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'knowledge-base' as WorkerAgentType,
    task,
    tier: 1,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: [
      'Storing entries with vague titles — "Fixed bug" is not searchable; "Fix: X fails when Y" is',
      'Creating duplicate entries — always search before storing',
      'Storing entries without tags — makes retrieval rely entirely on full-text search',
      'Storing project-specific knowledge without project_dir — it bleeds into unrelated projects',
      'Not searching the knowledge base before starting a task — solving the same problem twice',
      'Keeping stale entries after the codebase has moved on — old solutions become misleading',
      'Storing too much: copying entire file contents instead of the key insight',
    ],
    patterns: [
      'Search-first: always query the knowledge base before solving a problem from scratch',
      'Self-contained entries: each entry stands alone — future agent needs no original context',
      'Type-and-tag taxonomy: type (solution/pattern/error/reference/decision) + tags enables faceted retrieval',
      'Dedup-on-write: search for duplicates before every store operation',
    ],
    duration_estimate: '5-15 minutes',
  };
}
