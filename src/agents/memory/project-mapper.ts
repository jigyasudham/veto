import { AgentPlan, WorkerAgentType } from '../types.js';

type MapCategory = 'initial-map' | 'update' | 'query' | 'general';

function detectCategory(task: string): MapCategory {
  const t = task.toLowerCase();
  if (t.includes('initial') || t.includes('first time') || t.includes('new project') || t.includes('onboard') || t.includes('create map')) return 'initial-map';
  if (t.includes('update') || t.includes('refresh') || t.includes('new file') || t.includes('delete') || t.includes('rename') || t.includes('move')) return 'update';
  if (t.includes('find') || t.includes('where') || t.includes('locate') || t.includes('search') || t.includes('query')) return 'query';
  return 'general';
}

const categoryApproach: Record<MapCategory, string> = {
  'initial-map': 'Build the first project map by scanning the directory tree (excluding node_modules, .git, dist). Identify the tech stack from package.json / pyproject.toml / Cargo.toml. Identify key modules: entry points, router, config, schema, main service files. Store via veto_project_map_update.',
  'update': 'Incrementally update the project map after file changes. Add new files to the structure, remove deleted files, update module roles if they changed. Call veto_project_map_update after every session that modifies files. Do not re-scan the full tree — apply a diff.',
  'query': 'Query the project map via veto_project_map_get to answer "where is X" questions without reading the filesystem. Use the key_modules list for entry points, then follow imports. Fall back to a targeted filesystem search only if the map is stale.',
  'general': 'Check if a project map exists (veto_project_map_get). Create one if absent. Update if the last updated_at timestamp is more than one session old. Use the map to navigate the codebase before touching the filesystem.',
};

const categorySteps: Record<MapCategory, string[]> = {
  'initial-map': [
    'Read package.json (or equivalent) to identify language, framework, and key dependencies',
    'Scan the top-level src/ directory structure — list all directories and their purpose',
    'Identify entry points: main.ts / index.ts / app.ts / server.ts / cli.ts',
    'Identify router or routing config (routes.ts, app.ts, next.config.js, etc.)',
    'Identify database layer: schema files, migration files, ORM config',
    'Identify config files: .env, config/, settings files',
    'Identify test directories and test runner config',
    'Build the structure JSON: { "src/": { "agents/": [...], "router/": [...] } }',
    'Identify key_modules: list of the 10–20 most important files with their role',
    'Call veto_project_map_update with project_dir, structure, key_modules, tech_stack',
    'Verify the map with veto_project_map_get and confirm all key files are present',
  ],
  'update': [
    'Identify which files were added, removed, or renamed in this session',
    'Load the current map via veto_project_map_get',
    'Apply adds: add new file paths to the appropriate structure branch',
    'Apply removes: remove deleted file paths from the structure',
    'Update key_modules if a new important file was added or an important file was removed',
    'Update tech_stack if a new dependency was added (e.g. a new framework)',
    'Call veto_project_map_update with the modified structure',
    'Confirm the updated map reflects the current filesystem state',
  ],
  'query': [
    'Call veto_project_map_get to load the current map',
    'Check updated_at — if older than the current session, consider triggering a refresh',
    'Search key_modules for the file or module being queried',
    'If not in key_modules, traverse the structure JSON for the relevant directory',
    'Return the file path and module role without hitting the filesystem',
    'If the map query is inconclusive, fall back to a targeted Glob search',
    'If a Glob search finds a file missing from the map, trigger a map update',
  ],
  'general': [
    'Call veto_project_map_get to check if a map exists',
    'If no map: run the initial-map flow',
    'If map exists: check updated_at — update if stale',
    'Use the map to answer navigation questions before scanning the filesystem',
    'After each session that modifies files, call veto_project_map_update',
  ],
};

const categoryChecklist: Record<MapCategory, string[]> = {
  'initial-map': [
    '[ ] Tech stack identified: language, framework, key libraries',
    '[ ] All src/ directories listed with role description',
    '[ ] Entry points identified and listed in key_modules',
    '[ ] Database / schema layer identified',
    '[ ] Test directory and runner identified',
    '[ ] Structure JSON stored via veto_project_map_update',
    '[ ] Map verified via veto_project_map_get',
  ],
  'update': [
    '[ ] All added files included in structure',
    '[ ] All deleted files removed from structure',
    '[ ] key_modules updated if important file changed',
    '[ ] veto_project_map_update called with new structure',
    '[ ] Map verified post-update',
  ],
  'query': [
    '[ ] veto_project_map_get called before any filesystem scan',
    '[ ] key_modules checked first for fast lookup',
    '[ ] Structure JSON traversed if not in key_modules',
    '[ ] Filesystem fallback used only if map is inconclusive',
    '[ ] Map updated if filesystem revealed a gap',
  ],
  'general': [
    '[ ] Map existence checked at session start',
    '[ ] Map updated at session end if files were modified',
    '[ ] Map used as primary navigation source, not the filesystem',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const category = detectCategory(task + ' ' + (context ?? ''));
  return {
    agent: 'project-mapper' as WorkerAgentType,
    task,
    tier: 1,
    approach: categoryApproach[category],
    steps: categorySteps[category],
    checklist: categoryChecklist[category],
    pitfalls: [
      'Scanning the full project tree including node_modules — causes massive, useless maps',
      'Only building the map once and never updating — the map becomes stale after file changes',
      'Storing file contents in the map instead of just paths and roles — balloons storage',
      'Not listing key_modules — forces a full structure search for common lookups',
      'Building the map from memory instead of actually scanning — silently incorrect paths',
      'Forgetting to update the map after a refactor that moves or renames many files',
    ],
    patterns: [
      'Incremental update: diff-based map updates after file changes, not full re-scans',
      'Key modules first: maintain a flat list of the most important files for O(1) lookup',
      'Role annotation: each entry in key_modules includes the file\'s role (entry-point, router, schema, etc.)',
      'Lazy refresh: check updated_at and only refresh when the map is stale',
    ],
    duration_estimate: '5-10 minutes',
  };
}
