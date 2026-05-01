import { AgentPlan, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  const t = (task + ' ' + (context ?? '')).toLowerCase();
  const isCreate = t.includes('creat') || t.includes('scaffold') || t.includes('new file') || t.includes('add');
  const isDelete = t.includes('delet') || t.includes('remov') || t.includes('clean') || t.includes('purge');
  const isMove = t.includes('mov') || t.includes('renam') || t.includes('restructur') || t.includes('reorgan');

  const approach = isDelete
    ? 'Before deleting: verify nothing imports the file (grep for the filename and all its exports). Check git log to understand why it was created. If it is safe to delete, remove it and fix all broken imports. Never delete without checking references first.'
    : isMove
    ? 'Before moving: map all import paths that reference this file. Update every import after moving. Run the build to confirm no broken imports remain. Update any barrel index files that re-export the moved module.'
    : isCreate
    ? 'Create files in the right location: match the existing directory conventions. Add the new file to any relevant barrel index. Do not create a new directory when an existing one fits. Name the file to match its primary export.'
    : 'Execute the file operation safely. For any destructive operation (delete, overwrite): verify the operation is correct before running it. For moves and renames: update all references atomically.';

  return {
    agent: 'file-manager' as WorkerAgentType,
    task,
    tier: 1,
    approach,
    steps: [
      'Identify the exact files to create, modify, move, or delete',
      'For deletes: grep for all imports/references to the file before touching it',
      'For moves: list all files that import from the source path',
      'Execute the operation',
      'Update all import paths that reference moved or deleted files',
      'Update barrel index files (index.ts) if the file is re-exported',
      'Run the TypeScript build to confirm no broken imports',
      'Update the project map via veto_project_map_update',
    ],
    checklist: [
      '[ ] References checked before any delete or rename',
      '[ ] All import paths updated after move/rename',
      '[ ] Barrel indexes updated',
      '[ ] Build passes after operation',
      '[ ] Project map updated via veto_project_map_update',
    ],
    pitfalls: [
      'Deleting a file without checking what imports it — silent build breakage',
      'Moving a file without updating all import paths — TypeScript will error',
      'Creating a new directory when an existing one is the right home',
      'Forgetting to update barrel index files after adding/removing a module',
    ],
    patterns: [
      'Reference-before-delete: always grep for imports before deleting a file',
      'Atomic rename: update the file and all its references in a single operation',
      'Barrel maintenance: every add/remove in a directory requires checking the index.ts',
    ],
    duration_estimate: '15-60 minutes',
  };
}
