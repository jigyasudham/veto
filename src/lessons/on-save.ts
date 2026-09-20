// Save-time harvesting.
//
// Recording a lesson by hand is the step that never happens, so saving a
// session re-reads each AI's own memory and records what changed. The pass is
// consent-gated, time-boxed and idempotent: anything it does not reach waits
// for the next save.
//
// It never throws. The caller wraps it too, but a harvest problem must not be
// able to affect whether a session was saved.
//
// Nothing here delivers a note to any AI. Delivery is a separate, still-gated
// step that requires its own consent version (council 534e2bd5).

import { firstHarvestOnSave, isHarvestOnSaveEnabled } from '../memory/config.js';
import { syncLessonSources } from './harvest.js';

/**
 * A quiet pass costs one stat per file and opens no transaction, so this bound
 * is only ever reached by a genuinely cold one: a first run, an upgrade that
 * bumped HARVESTER_VERSION, or a day's worth of edits at once. Such a pass
 * stops here and the rest is picked up by the next save.
 */
const BUDGET_MS = 150;

export type OnSaveLessons = {
  /** Notes added, changed and removed; all zero means nothing is worth saying. */
  added: number;
  updated: number;
  removed: number;
  /** Sources left for the next save because the budget ran out. */
  pending: number;
  note?: string;
};

const FIRST_NOTE = 'Veto now re-reads your AIs\' notes when you save. See them with `veto lessons list`; stop it with `veto lessons off`.';

/**
 * Harvest what changed since the last pass. Returns null when there is nothing
 * to report — sharing is off, the switch is off, or no note moved — so a save
 * that changed nothing says nothing.
 */
export function harvestOnSave(options: { home?: string } = {}): OnSaveLessons | null {
  if (!isHarvestOnSaveEnabled()) return null;
  let report;
  try {
    report = syncLessonSources({ home: options.home, budgetMs: BUDGET_MS });
  } catch {
    return null;
  }
  const added = report.inserted;
  const { updated, removed } = report;
  // Work still queued is not news. A cold pass drains over several saves, and
  // saying "nothing changed, 66 to go" each time is noise about our own
  // bookkeeping. Only a note actually moving is worth a line.
  if (added === 0 && updated === 0 && removed === 0) return null;
  // Claimed only once anything was actually harvested, so the note lands on a
  // save the user can see the result of.
  const first = firstHarvestOnSave();
  return {
    added, updated, removed, pending: report.notReached,
    ...(first ? { note: FIRST_NOTE } : {}),
  };
}
