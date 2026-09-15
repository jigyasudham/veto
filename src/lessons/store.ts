import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../memory/local.js';
import type { LessonSource } from './adapters/index.js';
import type { LessonScope } from './classify.js';

export type LessonRow = {
  id: string;
  source_cli: LessonSource;
  source_path: string;
  section_anchor: string;
  project_identity: string;
  project_label: string | null;
  scope: LessonScope;
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
    .update(JSON.stringify([input.projectIdentity, input.projectLabel, section.scope, section.kind, section.quarantineReason, section.textMasked]))
    .digest('hex');
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
 */
export function syncLessons(input: SyncLessonsInput): { inserted: number; updated: number; removed: number } {
  return inTransaction(() => {
    const db = getDb();
    const existing = db.prepare('SELECT id, source_hash FROM lessons WHERE source_cli = ? AND source_path = ? AND section_anchor = ?');
    const insert = db.prepare(`INSERT INTO lessons (id, source_cli, source_path, section_anchor, project_identity, project_label, scope, kind, text_masked, source_hash, source_mtime, quarantined, quarantine_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE lessons SET project_identity = ?, project_label = ?, scope = ?, kind = ?, text_masked = ?, source_hash = ?, source_mtime = ?, quarantined = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?`);
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    for (const section of input.sections) {
      const hash = sectionHash(input, section);
      const quarantined = section.quarantineReason ? 1 : 0;
      const row = existing.get(input.sourceCli, input.sourcePath, section.anchor) as { id: string; source_hash: string } | undefined;
      if (!row) {
        insert.run(randomUUID(), input.sourceCli, input.sourcePath, section.anchor, input.projectIdentity, input.projectLabel, section.scope, section.kind,
          section.textMasked, hash, input.sourceMtime, quarantined, section.quarantineReason, now, now);
        inserted++;
      } else if (row.source_hash !== hash) {
        update.run(input.projectIdentity, input.projectLabel, section.scope, section.kind, section.textMasked, hash, input.sourceMtime, quarantined, section.quarantineReason, now, row.id);
        updated++;
      }
    }
    const anchors = input.sections.map(section => section.anchor);
    const keep = anchors.length ? ` AND section_anchor NOT IN (${anchors.map(() => '?').join(', ')})` : '';
    const removed = Number(db.prepare(`DELETE FROM lessons WHERE source_cli = ? AND source_path = ?${keep}`)
      .run(input.sourceCli, input.sourcePath, ...anchors).changes);
    return { inserted, updated, removed };
  });
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
  const rows = getDb().prepare('SELECT source_cli FROM lesson_source_state WHERE enabled = 0').all() as Array<{ source_cli: LessonSource }>;
  return new Set(rows.map(row => row.source_cli));
}
