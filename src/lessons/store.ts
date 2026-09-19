import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { getDb } from '../memory/local.js';
import type { LessonSource } from './adapters/index.js';
import type { LessonScope, ScopeReason } from './classify.js';

export type LessonRow = {
  id: string;
  source_cli: LessonSource;
  source_path: string;
  section_anchor: string;
  project_identity: string;
  project_label: string | null;
  scope: LessonScope;
  scope_reason: ScopeReason | null;
  kind: string;
  text_masked: string;
  source_hash: string;
  source_mtime: string;
  quarantined: number;
  quarantine_reason: string | null;
  created_at: string;
  updated_at: string;
};

/** A section after masking and classification; raw memory text never reaches the store. */
export type HarvestedSection = {
  anchor: string;
  textMasked: string;
  scope: LessonScope;
  scopeReason: ScopeReason;
  kind: string;
  quarantineReason: string | null;
};

export type SyncLessonsInput = {
  sourceCli: LessonSource;
  sourcePath: string;
  projectIdentity: string;
  projectLabel: string | null;
  sourceMtime: string;
  sections: HarvestedSection[];
};

/** Per SECTION, over everything stored: an edit elsewhere in the file leaves this row alone. */
function sectionHash(input: SyncLessonsInput, section: HarvestedSection): string {
  return createHash('sha256')
    .update(JSON.stringify([input.projectIdentity, input.projectLabel, section.scope, section.scopeReason, section.kind, section.quarantineReason, section.textMasked]))
    .digest('hex');
}

/** A note's text, compared the way a person would: case and spacing do not make it a different note. */
export function lessonSignature(textMasked: string): string {
  return createHash('sha256').update(textMasked.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * One memory entry wherever it is kept: the same file name and section in any
 * checkout of the same project (the D:, F: and G: copies of one Claude memory
 * folder) is one entry, held in several places.
 */
export function lessonEntryKey(row: { source_cli: string; project_identity: string; source_path: string; section_anchor: string }): string {
  return [row.source_cli, row.project_identity, basename(row.source_path).toLowerCase(), row.section_anchor].join('\n');
}

type TombstoneProbe = { source_cli: string; source_path: string; section_anchor: string; project_identity: string; text_masked: string };

function tombstoneMatcher(): (probe: TombstoneProbe) => boolean {
  const stmt = getDb().prepare(`SELECT 1 FROM lesson_tombstones
    WHERE (source_cli = ? AND source_path = ? AND section_anchor = ?) OR entry_key = ? OR signature = ? LIMIT 1`);
  return probe => stmt.get(probe.source_cli, probe.source_path, probe.section_anchor, lessonEntryKey(probe), lessonSignature(probe.text_masked)) !== undefined;
}

/**
 * Tombstone a note and delete it with every version and copy of it. Each row
 * removed gets a tombstone of its own, so a copy's later edits stay forgotten,
 * and so does text identical to a copy (not only to the note picked). Returns
 * how many rows were removed, the note itself included.
 */
export function tombstoneLesson(row: LessonRow): number {
  return inTransaction(() => {
    const db = getDb();
    const forgetId = randomUUID();
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO lesson_tombstones (id, forget_id, source_cli, source_path, section_anchor, entry_key, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const del = db.prepare('DELETE FROM lessons WHERE id = ?');
    const forgotten = tombstoneMatcher();
    const tombstoned = new Set<string>();
    let pending = [row];
    let removed = 0;
    while (pending.length) {
      for (const r of pending) {
        tombstoned.add(r.id);
        insert.run(randomUUID(), forgetId, r.source_cli, r.source_path, r.section_anchor, lessonEntryKey(r), lessonSignature(r.text_masked), now);
      }
      const matches = (db.prepare('SELECT * FROM lessons').all() as LessonRow[]).filter(forgotten);
      for (const r of matches) removed += Number(del.run(r.id).changes);
      pending = matches.filter(r => !tombstoned.has(r.id));
    }
    return removed;
  });
}

export function isProjectExcluded(projectIdentity: string): boolean {
  return getDb().prepare('SELECT 1 FROM lesson_project_exclusions WHERE project_identity = ?').get(projectIdentity) !== undefined;
}

export type ProjectExclusion = { project_identity: string; project_label: string | null; created_at: string };

export function excludedProjects(): ProjectExclusion[] {
  return getDb().prepare('SELECT project_identity, project_label, created_at FROM lesson_project_exclusions ORDER BY created_at').all() as ProjectExclusion[];
}

/** Keep a project out of sharing, and delete what was already harvested from it. */
export function excludeProject(projectIdentity: string, projectLabel: string | null): { added: boolean; removed: number } {
  return inTransaction(() => {
    const db = getDb();
    const added = Number(db.prepare('INSERT OR IGNORE INTO lesson_project_exclusions (project_identity, project_label, created_at) VALUES (?, ?, ?)')
      .run(projectIdentity, projectLabel, new Date().toISOString()).changes) > 0;
    const removed = Number(db.prepare('DELETE FROM lessons WHERE project_identity = ?').run(projectIdentity).changes);
    return { added, removed };
  });
}

export function includeProject(projectIdentity: string): boolean {
  return Number(getDb().prepare('DELETE FROM lesson_project_exclusions WHERE project_identity = ?').run(projectIdentity).changes) > 0;
}

function inTransaction<T>(run: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try { const out = run(); db.exec('COMMIT'); return out; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}

/**
 * Make a source's rows exactly its current sections: insert new ones, update
 * changed ones, delete the rest (lifetime = source). A source that failed to
 * parse never reaches this function, so a malformed file cannot erase rows;
 * an empty section list is a successful parse of nothing and clears them.
 * A forgotten section counts as absent: it is deleted, never re-added.
 */
export function syncLessons(input: SyncLessonsInput): { inserted: number; updated: number; removed: number } {
  return inTransaction(() => {
    const db = getDb();
    const existing = db.prepare('SELECT id, source_hash FROM lessons WHERE source_cli = ? AND source_path = ? AND section_anchor = ?');
    const insert = db.prepare(`INSERT INTO lessons (id, source_cli, source_path, section_anchor, project_identity, project_label, scope, scope_reason, kind, text_masked, source_hash, source_mtime, quarantined, quarantine_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE lessons SET project_identity = ?, project_label = ?, scope = ?, scope_reason = ?, kind = ?, text_masked = ?, source_hash = ?, source_mtime = ?, quarantined = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?`);
    const forgotten = tombstoneMatcher();
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    const kept = input.sections.filter(section => !forgotten({
      source_cli: input.sourceCli, source_path: input.sourcePath, section_anchor: section.anchor,
      project_identity: input.projectIdentity, text_masked: section.textMasked,
    }));
    for (const section of kept) {
      const hash = sectionHash(input, section);
      const quarantined = section.quarantineReason ? 1 : 0;
      const row = existing.get(input.sourceCli, input.sourcePath, section.anchor) as { id: string; source_hash: string } | undefined;
      if (!row) {
        insert.run(randomUUID(), input.sourceCli, input.sourcePath, section.anchor, input.projectIdentity, input.projectLabel, section.scope, section.scopeReason,
          section.kind, section.textMasked, hash, input.sourceMtime, quarantined, section.quarantineReason, now, now);
        inserted++;
      } else if (row.source_hash !== hash) {
        update.run(input.projectIdentity, input.projectLabel, section.scope, section.scopeReason, section.kind, section.textMasked, hash, input.sourceMtime,
          quarantined, section.quarantineReason, now, row.id);
        updated++;
      }
    }
    const anchors = kept.map(section => section.anchor);
    const keep = anchors.length ? ` AND section_anchor NOT IN (${anchors.map(() => '?').join(', ')})` : '';
    const removed = Number(db.prepare(`DELETE FROM lessons WHERE source_cli = ? AND source_path = ?${keep}`)
      .run(input.sourceCli, input.sourcePath, ...anchors).changes);
    return { inserted, updated, removed };
  });
}

/** Delete every row harvested from one source file. */
export function deleteLessonSource(source: LessonSource, sourcePath: string): number {
  return Number(getDb().prepare('DELETE FROM lessons WHERE source_cli = ? AND source_path = ?').run(source, sourcePath).changes);
}

/** Delete every row whose source file is no longer among the discovered ones. */
export function purgeVanishedLessonSources(present: Array<{ source: LessonSource; sourcePath: string }>): number {
  const keep = new Set(present.map(p => `${p.source}\u0000${p.sourcePath}`));
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT source_cli, source_path FROM lessons').all() as Array<{ source_cli: string; source_path: string }>;
  const del = db.prepare('DELETE FROM lessons WHERE source_cli = ? AND source_path = ?');
  let removed = 0;
  for (const row of rows) {
    if (!keep.has(`${row.source_cli}\u0000${row.source_path}`)) removed += Number(del.run(row.source_cli, row.source_path).changes);
  }
  return removed;
}

export function enableLessonSource(source: LessonSource): boolean {
  return Number(getDb().prepare('DELETE FROM lesson_source_state WHERE source_cli = ?').run(source).changes) > 0;
}

export function disableLessonSource(source: LessonSource, reason: string): void {
  getDb().prepare(`INSERT INTO lesson_source_state (source_cli, enabled, disabled_reason, checked_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(source_cli) DO UPDATE SET enabled = 0, disabled_reason = excluded.disabled_reason, checked_at = excluded.checked_at`)
    .run(source, reason, new Date().toISOString());
}

export function isLessonSourceEnabled(source: LessonSource): boolean {
  const row = getDb().prepare('SELECT enabled FROM lesson_source_state WHERE source_cli = ?').get(source) as { enabled: number } | undefined;
  return !row || row.enabled === 1;
}

/** Hosts whose adapter tripped the format-drift canary; their rows are not served. */
export function disabledLessonSources(): Set<LessonSource> {
  return new Set(disabledLessonSourceReasons().keys());
}

export function disabledLessonSourceReasons(): Map<LessonSource, string> {
  const rows = getDb().prepare('SELECT source_cli, disabled_reason FROM lesson_source_state WHERE enabled = 0').all() as Array<{ source_cli: LessonSource; disabled_reason: string | null }>;
  return new Map(rows.map(row => [row.source_cli, row.disabled_reason ?? 'format drift']));
}
