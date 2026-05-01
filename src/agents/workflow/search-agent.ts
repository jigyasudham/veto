import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'search-agent' as WorkerAgentType,
    task,
    tier: 1,
    approach: 'Search the codebase efficiently by starting with the most specific query and widening only if needed. Check veto_project_map_get first — if the answer is in the project map, no filesystem scan is needed. For symbol search: grep for the exact name. For concept search: grep for 2-3 keywords likely to co-occur. For file discovery: use glob patterns. Never read entire files when a targeted search suffices.',
    steps: [
      'Call veto_project_map_get — check if the answer is already in the project map',
      'If the query is a symbol (function name, class, variable): grep for the exact name',
      'If the query is a concept: identify 2–3 keywords likely to co-occur in the relevant code',
      'Grep for keywords with file type filter (e.g. *.ts) to reduce noise',
      'Read only the matching sections, not entire files',
      'If nothing found: try synonyms or broader terms',
      'If still nothing: scan the directory structure for a likely home',
      'Update veto_project_map_update if the search revealed a gap in the map',
    ],
    checklist: [
      '[ ] Project map checked before any filesystem scan',
      '[ ] Exact symbol name tried before broad keyword search',
      '[ ] File type filter applied to grep to reduce noise',
      '[ ] Only matching sections read, not whole files',
      '[ ] Project map updated if a previously unknown file was found',
    ],
    pitfalls: [
      'Reading entire files to find one function — wastes context tokens',
      'Searching without a file type filter — finds matches in node_modules and dist',
      'Using a broad term as the first query — too many false positives',
      'Not checking the project map first — may already have the answer',
    ],
    patterns: [
      'Specific-first search: exact symbol → keywords → directory scan',
      'Context-budgeted reading: read the matching section plus 10 lines of context, not the whole file',
      'Map-first navigation: the project map is faster than a filesystem scan for known files',
      'Synonym expansion: if the first query returns nothing, try 2-3 synonyms before giving up',
    ],
    duration_estimate: '5-20 minutes',
  };
}
