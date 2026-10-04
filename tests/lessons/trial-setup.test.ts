import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, getConfig, isLessonsSharingEnabled, setConfig } from '../../src/memory/config.js';
import { resetDb } from '../../src/memory/local.js';
import { addTrialProject, clearTrialLists, startTrial, trialPhase, trialSetup } from '../../src/lessons/trial-setup.js';
import { TRIAL_DAYS } from '../../src/lessons/trial.js';

let home: string;
beforeEach(() => {
  resetDb();
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'veto-trial-setup-')));
  process.env.VETO_CONFIG_PATH = join(home, 'config.json');
});
afterEach(() => {
  delete process.env.VETO_CONFIG_PATH;
  rmSync(home, { recursive: true, force: true });
});

const sample = { id: 2, consent_version: 1, started_at: null, use: [], ignore: [{ identity: 'git:abc', label: 'repo' }] };

describe('the trial entry in the config', () => {
  it('is absent by default', () => {
    expect(getConfig().lessons.trial).toBeNull();
  });

  it('survives turning sharing on again', () => {
    setConfig({ lessons: { ...getConfig().lessons, trial: sample } });
    enableLessonsSharing();
    expect(getConfig().lessons.trial).toEqual(sample);
  });

  it('ignores a damaged entry instead of throwing', () => {
    writeFileSync(process.env.VETO_CONFIG_PATH!, JSON.stringify({ lessons: { trial: { id: 'two', use: 'x' } } }));
    expect(getConfig().lessons.trial).toBeNull();
    writeFileSync(process.env.VETO_CONFIG_PATH!, JSON.stringify({ lessons: { trial: { id: 2, use: [{ identity: 1 }, { identity: 'git:a', label: 'a' }] } } }));
    expect(getConfig().lessons.trial).toEqual({ id: 2, consent_version: 0, started_at: null, use: [{ identity: 'git:a', label: 'a' }], ignore: [] });
  });
});

describe('setting up the trial', () => {
  let folder: string;
  beforeEach(() => {
    folder = join(home, 'code', 'beta');
    mkdirSync(folder, { recursive: true });
    enableLessonsSharing();
  });

  it('adds a folder by identity, says what kind, and does not add it twice', () => {
    const first = addTrialProject('ignore', folder);
    expect(first).toMatchObject({ ok: true, kind: 'path', added: true, entry: { label: 'beta' } });
    expect(first.ok && first.entry.identity.startsWith('path:')).toBe(true);
    expect(addTrialProject('ignore', folder)).toMatchObject({ ok: true, added: false });
    expect(trialSetup().ignore).toHaveLength(1);
  });

  it('refuses a folder that does not exist, and stores nothing', () => {
    expect(addTrialProject('use', join(home, 'nope'))).toEqual({ ok: false, reason: 'missing_folder' });
    expect(getConfig().lessons.trial).toBeNull();
  });

  it('starts only with the lists that were shown, in one write', () => {
    addTrialProject('ignore', folder);
    const shown = trialSetup();
    addTrialProject('use', folder); // changed after showing
    expect(startTrial(shown)).toEqual({ ok: false, reason: 'lists_changed' });
    expect(trialPhase()).toBe('setup');
    const r = startTrial(trialSetup(), new Date('2026-10-05T00:00:00.000Z'));
    expect(r).toMatchObject({ ok: true, startedAt: '2026-10-05T00:00:00.000Z' });
    expect(r.ok && Date.parse(r.endsAt) - Date.parse(r.startedAt)).toBe(TRIAL_DAYS * 24 * 60 * 60 * 1000);
    expect(getConfig().lessons.trial).toMatchObject({ id: 2, consent_version: 1, started_at: '2026-10-05T00:00:00.000Z' });
  });

  it('freezes the lists once the trial runs, and says until when', () => {
    startTrial(trialSetup());
    const refused = addTrialProject('ignore', folder);
    expect(refused).toMatchObject({ ok: false, reason: 'running' });
    expect(!refused.ok && refused.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(clearTrialLists()).toMatchObject({ ok: false, reason: 'running' });
    expect(startTrial(trialSetup())).toMatchObject({ ok: false, reason: 'running' });
  });

  it('needs sharing on to start', () => {
    setConfig({ lessons: { ...getConfig().lessons, enabled: false } });
    expect(startTrial(trialSetup())).toEqual({ ok: false, reason: 'sharing_off' });
  });

  it('cannot be started again once finished', () => {
    startTrial(trialSetup(), new Date(Date.now() - (TRIAL_DAYS + 1) * 24 * 60 * 60 * 1000));
    expect(trialPhase()).toBe('finished');
    expect(startTrial(trialSetup())).toEqual({ ok: false, reason: 'finished' });
  });

  it('veto lessons off clears the trial entry with the records (K4)', async () => {
    startTrial(trialSetup());
    const { turnLessonsOff } = await import('../../src/lessons/manage.js');
    turnLessonsOff();
    expect(getConfig().lessons.trial).toBeNull();
    expect(trialPhase()).toBe('setup');
    expect(isLessonsSharingEnabled()).toBe(false);
  });
});
