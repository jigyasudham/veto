import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const real = resolve(join(homedir(), '.veto', 'config.json'));

describe('test config isolation', () => {
  it('never points a test at the real config', () => {
    expect(process.env.VETO_CONFIG_PATH).toBeTruthy();
    expect(resolve(process.env.VETO_CONFIG_PATH!)).not.toBe(real);
  });

  it('survives a test that deletes the path', () => {
    delete process.env.VETO_CONFIG_PATH;
  });

  it('is restored for the next test', () => {
    expect(process.env.VETO_CONFIG_PATH).toBeTruthy();
    expect(resolve(process.env.VETO_CONFIG_PATH!)).not.toBe(real);
  });
});
