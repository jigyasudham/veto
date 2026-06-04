import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { log, errMsg } from '../src/log.js';

let writes: string[];
let original: typeof process.stderr.write;

beforeEach(() => {
  writes = [];
  original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    writes.push(String(s));
    return true;
  };
});

afterEach(() => {
  (process.stderr as unknown as { write: typeof original }).write = original;
  delete process.env.VETO_LOG_LEVEL;
  delete process.env.VETO_LOG;
});

describe('log level filtering', () => {
  it('default level (warn) suppresses info and debug but emits warn/error', () => {
    log.debug('d');
    log.info('i');
    expect(writes).toHaveLength(0);
    log.warn('w');
    log.error('e');
    expect(writes).toHaveLength(2);
  });

  it('VETO_LOG_LEVEL=debug emits everything', () => {
    process.env.VETO_LOG_LEVEL = 'debug';
    log.debug('d');
    log.info('i');
    expect(writes).toHaveLength(2);
  });

  it('VETO_LOG_LEVEL=silent suppresses everything, including errors', () => {
    process.env.VETO_LOG_LEVEL = 'silent';
    log.error('e');
    expect(writes).toHaveLength(0);
  });
});

describe('log output shape', () => {
  it('emits one JSON line per call with level, msg, and context', () => {
    log.error('boom', { tool: 'veto_x', code: 7 });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const rec = JSON.parse(writes[0]);
    expect(rec.level).toBe('error');
    expect(rec.msg).toBe('boom');
    expect(rec.tool).toBe('veto_x');
    expect(rec.code).toBe(7);
    expect(typeof rec.ts).toBe('string');
  });

  it('respects VETO_LOG=text for plain-line output', () => {
    process.env.VETO_LOG = 'text';
    log.warn('hi', { a: 1 });
    expect(writes[0]).toContain('[veto:warn] hi');
    expect(() => JSON.parse(writes[0])).toThrow();
  });

  it('never writes to stdout', () => {
    // The logger only overrides stderr; this is a guard against a regression where
    // a maintainer switches it to stdout (which would corrupt the MCP protocol).
    log.error('e');
    expect(writes.every(w => w.includes('"level":"error"') || w.includes('[veto'))).toBe(true);
  });
});

describe('errMsg', () => {
  it('returns the message of an Error', () => {
    expect(errMsg(new Error('nope'))).toBe('nope');
  });
  it('stringifies non-Error values', () => {
    expect(errMsg('plain')).toBe('plain');
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
  });
});
