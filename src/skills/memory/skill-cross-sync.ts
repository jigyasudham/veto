// Skill: cross-sync — how to move veto memory between machines using file export/import

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
// ── Cross-Machine Memory Transfer ────────────────────────────────────────
//
// Veto stores everything in ~/.veto/veto.db (SQLite).
// To continue work on another machine: export → copy → import.
//
// No external services. No accounts. No env vars.
//
// ── Step 1: Export on Machine A ───────────────────────────────────────────
//
//   veto_memory_export
//   → writes to ~/.veto/veto-export.json by default
//   → or specify output_path to write directly to shared storage
//
//   Example with shared storage:
//   veto_memory_export { output_path: "/Users/you/Dropbox/veto-export.json" }
//
// ── Step 2: Copy the file ─────────────────────────────────────────────────
//
//   Options (pick any):
//   • Dropbox / OneDrive / Google Drive — put output_path in your sync folder
//   • USB drive
//   • scp / rsync over SSH
//   • Email / messaging app
//   • AirDrop (Mac)
//
// ── Step 3: Import on Machine B ───────────────────────────────────────────
//
//   veto_memory_import { input_path: "/path/to/veto-export.json" }
//   → merges into local ~/.veto/veto.db
//   → INSERT OR IGNORE — local rows are never overwritten
//   → returns { merged: {...}, skipped: {...} } showing what was added
//
// ── Step 4: Verify and resume ─────────────────────────────────────────────
//
//   veto_sessions_list           — confirm sessions arrived
//   veto_session_restore { id }  — load the session you want to continue
//   veto_memory_search { query } — confirm knowledge base arrived
//
// ── What gets exported ────────────────────────────────────────────────────
//
//   sessions         — all saved sessions with task state and context
//   decisions        — all logged decisions and rationale
//   knowledge_base   — all stored solutions, patterns, errors, references
//   patterns         — coding style and convention patterns
//   project_map      — codebase structure maps
//   council_outcomes — all council debate results
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'cross-sync',
    template: TEMPLATE,
    checklist: [
      'Before leaving Machine A: call veto_memory_export to create the export file',
      'Check the export result — confirm row counts look right for sessions and knowledge_base',
      'Copy the export file to Machine B via any method (Dropbox, USB, scp, etc.)',
      'On Machine B: call veto_memory_import with the file path',
      'Check the import result — merged counts show what was added, skipped counts show duplicates',
      'Call veto_sessions_list to confirm the sessions you need are present',
      'Call veto_session_restore with the session ID to load your prior context',
      'Call veto_memory_search to confirm knowledge base entries are available',
      'If working across multiple machines regularly: use a shared folder (Dropbox) as output_path so no manual copy is needed',
      'After significant work on Machine B: run veto_memory_export again before switching back',
    ],
    patterns: [
      'Export-before-switch: always export before ending a session, not only when switching machines',
      'Shared-folder shortcut: point output_path at a Dropbox/OneDrive folder — no manual copy step',
      'Merge semantics: INSERT OR IGNORE means both machines can export/import in any order without data loss',
      'Verify-after-import: always call veto_sessions_list after import to confirm data arrived before starting work',
    ],
    gotchas: [
      'Forgetting to export before switching — Machine B starts with no memory of Machine A\'s work',
      'Importing a stale export (from yesterday) — you lose today\'s work on Machine A; always export fresh',
      'The export file is plain JSON — it contains your session context. Don\'t commit it to a public git repo',
      'Pattern merge adds seen_counts from both machines — this is intentional (more observations = higher confidence)',
      'INSERT OR IGNORE means if Machine B already has a session with the same ID, it is not updated. Export fresh from Machine A if you need the latest version of a session',
    ],
    resources: [
      'veto_memory_export — export all memory to JSON (default path: ~/.veto/veto-export.json)',
      'veto_memory_import — import and merge JSON into local SQLite',
      'veto_sessions_list — verify sessions after import',
      'veto_session_restore — load a specific session to resume work',
      'veto_memory_search — verify knowledge base after import',
    ],
  };
}
