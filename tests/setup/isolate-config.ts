// Every test gets a config file and a Codex home of its own unless it names one.
//
// Without VETO_CONFIG_PATH, getConfig() reads ~/.veto/config.json, so a test
// that saves a session behaves differently on a machine whose owner has turned
// sharing on: the save harvests that person's real memory files and writes
// first_harvest_at into their real config. Without CODEX_HOME, the shadow trial
// reads the real ~/.codex/sessions. Tests that set their own paths keep them; a
// test that deletes one in afterEach gets this one back before the next.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'veto-test-config-'));
const isolated = join(dir, 'config.json');
const codexHome = join(dir, 'codex');
mkdirSync(codexHome);

const isolate = (): void => {
  process.env.VETO_CONFIG_PATH ??= isolated;
  process.env.CODEX_HOME ??= codexHome;
};
isolate();
beforeEach(isolate);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
