import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableLessonsSharing, getConfig, setConfig } from '../../src/memory/config.js';
import { resetDb } from '../../src/memory/local.js';

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
