import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({ home: '', exec: vi.fn() }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('node:child_process', () => ({ exec: mocks.exec }));

let dir: string;
let cachePath: string;
let lockPath: string;
const hour = 3_600_000;
const now = Date.UTC(2026, 8, 26);
const load = async () => (await import('../../src/server/update-check.js')).versionUpdateInstruction;
const cache = () => JSON.parse(readFileSync(cachePath, 'utf8'));
const finish = (error: Error | null = null, stdout = '99.0.0\n') => mocks.exec.mock.calls.at(-1)![2](error, stdout);

beforeEach(() => {
  vi.resetModules();
  mocks.exec.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'veto-update-'));
  mocks.home = dir;
  mkdirSync(join(dir, '.veto'));
  cachePath = join(dir, '.veto', '.update-check.json');
  lockPath = join(dir, '.veto', '.update-check.lock');
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('background version check', () => {
  it('starts hidden with a missing cache and emits no parent output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const check = await load();
    expect(check()).toBeUndefined();
    expect(mocks.exec).toHaveBeenCalledWith('npm view @jigyasudham/veto version',
      { timeout: 8000, windowsHide: true }, expect.any(Function));
    expect(cache()).toEqual({ attemptedAt: now });
    finish();
    expect(cache()).toEqual({ latest: '99.0.0', checkedAt: now, attemptedAt: now });
    expect(existsSync(lockPath)).toBe(false);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('uses a fresh legacy cache without launching npm', async () => {
    writeFileSync(cachePath, JSON.stringify({ latest: '99.0.0', checkedAt: now - hour }));
    expect((await load())()).toContain('99.0.0');
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it.each(['failure', 'timeout', 'invalid response', 'throw'])('preserves a stale version and backs off after %s', async (mode) => {
    const previous = { latest: '99.0.0', checkedAt: now - 25 * hour };
    writeFileSync(cachePath, JSON.stringify(previous));
    if (mode === 'throw') mocks.exec.mockImplementation(() => { throw new Error('spawn failed'); });
    const check = await load();
    expect(check()).toContain('99.0.0');
    if (mode !== 'throw') finish(mode === 'invalid response' ? null : new Error(mode), 'not a version');
    expect(cache()).toEqual({ ...previous, attemptedAt: now });
    expect(existsSync(lockPath)).toBe(false);
    vi.resetModules(); // an independent startup must also respect the disk cooldown
    const restarted = await load();
    restarted();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + hour);
    restarted();
    expect(mocks.exec).toHaveBeenCalledTimes(2);
  });

  it('coordinates independent module instances while npm is pending', async () => {
    (await load())();
    vi.resetModules();
    const second = await load();
    second();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    finish();
    expect(second()).toContain('99.0.0');
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it.each(['null', '{broken', '{"latest":42,"checkedAt":"bad"}'])('recovers from malformed cache %s', async (value) => {
    writeFileSync(cachePath, value);
    expect((await load())()).toBeUndefined();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    finish();
  });

  it('does not launch when cache storage is unwritable', async () => {
    mkdirSync(cachePath); // a directory cannot be overwritten as a cache file
    expect((await load())()).toBeUndefined();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('recovers an abandoned lock but leaves a live owner alone', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, id: 'abandoned' }));
    utimesSync(lockPath, new Date(now - hour), new Date(now - hour));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    (await load())();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    finish(new Error('offline'));
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, id: 'live' }));
    utimesSync(lockPath, new Date(now - hour), new Date(now - hour));
    kill.mockReturnValue(true);
    vi.mocked(Date.now).mockReturnValue(now + hour);
    (await load())();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(true);
  });
});
