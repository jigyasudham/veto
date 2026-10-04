// Setting up and starting the shadow trial (council a085b10e). The trial is a
// separate opt-in: accepting sharing never starts it. Its lists hold project
// identities, set by the user or their AI before the start and frozen after.
// Only the user can start it, in their own terminal (cli/lessons.ts checks
// that); this module stores exactly the lists the user was shown.

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { getConfig, isLessonsSharingEnabled, setConfig, type TrialConfig, type TrialProject } from '../memory/config.js';
import { resolveProjectIdentity } from './identity.js';
import { TRIAL_CONSENT_VERSION, TRIAL_DAYS, TRIAL_ID, trialStatus, trialWindow } from './trial.js';

export type TrialList = 'use' | 'ignore';
export type TrialPhase = 'setup' | 'running' | 'finished';
export type TrialRefusal = { ok: false; reason: 'running' | 'finished' | 'missing_folder' | 'sharing_off' | 'lists_changed'; until?: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const empty = (): TrialConfig => ({ id: TRIAL_ID, consent_version: 0, started_at: null, use: [], ignore: [] });

/** The trial-2 entry being set up or run, or an empty one. An entry for another trial id is not this trial's. */
export function trialSetup(): TrialConfig {
  const trial = getConfig().lessons.trial;
  return trial && trial.id === TRIAL_ID ? trial : empty();
}

export function trialPhase(now = Date.now()): TrialPhase {
  const trial = trialSetup();
  if (!trial.started_at || trial.consent_version !== TRIAL_CONSENT_VERSION) return 'setup';
  const status = trialStatus(now);
  if (status) return status.complete ? 'finished' : 'running';
  // Started, but sharing is off: the record was kept, so it is not set up again.
  return Date.parse(trial.started_at) + TRIAL_DAYS * DAY_MS < now ? 'finished' : 'running';
}

function frozen(): TrialRefusal | null {
  const phase = trialPhase();
  if (phase === 'setup') return null;
  const window = trialWindow();
  return { ok: false, reason: phase, ...(phase === 'running' && window ? { until: new Date(window.endsAt).toISOString() } : {}) };
}

function save(trial: TrialConfig): void {
  // setConfig re-reads the file just before writing, so nothing written since is lost (K1).
  setConfig({ lessons: { ...getConfig().lessons, trial } });
}

export function addTrialProject(list: TrialList, dir: string): { ok: true; entry: TrialProject; kind: 'git' | 'path'; added: boolean } | TrialRefusal {
  const refused = frozen();
  if (refused) return refused;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, reason: 'missing_folder' };
  const identity = resolveProjectIdentity(dir);
  const entry: TrialProject = { identity, label: basename(dir.replace(/[\\/]+$/, '')) || dir };
  const trial = trialSetup();
  const added = !trial[list].some(p => p.identity === identity);
  if (added) save({ ...trial, [list]: [...trial[list], entry] });
  return { ok: true, entry, kind: identity.startsWith('git:') ? 'git' : 'path', added };
}

export function clearTrialLists(): { ok: true } | TrialRefusal {
  const refused = frozen();
  if (refused) return refused;
  save(empty());
  return { ok: true };
}

const sameLists = (a: TrialConfig, b: TrialConfig) => JSON.stringify([a.use, a.ignore]) === JSON.stringify([b.use, b.ignore]);

/** Start trial 2 with exactly the lists the user was shown, in one write (K1). */
export function startTrial(shown: TrialConfig, now = new Date()): { ok: true; startedAt: string; endsAt: string } | TrialRefusal {
  const refused = frozen();
  if (refused) return refused;
  if (!isLessonsSharingEnabled()) return { ok: false, reason: 'sharing_off' };
  if (!sameLists(shown, trialSetup())) return { ok: false, reason: 'lists_changed' };
  const startedAt = now.toISOString();
  save({ id: TRIAL_ID, consent_version: TRIAL_CONSENT_VERSION, started_at: startedAt, use: shown.use, ignore: shown.ignore });
  return { ok: true, startedAt, endsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString() };
}

/** `veto lessons off`: the trial entry goes with the records. */
export function clearTrialConfig(): void {
  setConfig({ lessons: { ...getConfig().lessons, trial: null } });
}
