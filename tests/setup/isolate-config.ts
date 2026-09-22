// Every test gets a config file of its own unless it names one.
//
// Without VETO_CONFIG_PATH, getConfig() reads ~/.veto/config.json, so a test
// that saves a session behaves differently on a machine whose owner has turned
// sharing on: the save harvests that person's real memory files and writes
// first_harvest_at into their real config. Tests that set their own path keep
// it; a test that deletes it in afterEach gets this one back before the next.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'veto-test-config-'));
const isolated = join(dir, 'config.json');

process.env.VETO_CONFIG_PATH ??= isolated;
beforeEach(() => { process.env.VETO_CONFIG_PATH ??= isolated; });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
