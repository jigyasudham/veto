import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHostClient, hostClient, classifyHost, detectHostPlatform, resetHostClient,
} from '../../src/host.js';

beforeEach(() => resetHostClient());

describe('classifyHost', () => {
  // Substrings, not an exact table: these strings belong to other projects and
  // can be renamed without notice.
  it('recognizes the observed name forms for each host', () => {
    for (const n of ['claude-code', 'claude-ai', 'Claude Code', 'claude']) expect(classifyHost(n)).toBe('claude');
    for (const n of ['codex', 'codex-cli', 'codex_rmcp_client', 'Codex CLI']) expect(classifyHost(n)).toBe('codex');
    for (const n of ['gemini-cli', 'gemini', 'Gemini CLI']) expect(classifyHost(n)).toBe('gemini');
  });

  // An unknown client must not be forced into a guess — callers fall back to the
  // declared platform, which is strictly better than capturing the wrong CLI.
  it('returns null for a client it does not recognize', () => {
    for (const n of ['cursor', 'windsurf', 'zed', 'some-new-ide', '']) expect(classifyHost(n)).toBeNull();
    expect(classifyHost(null)).toBeNull();
    expect(classifyHost(undefined)).toBeNull();
  });
});

describe('recordHostClient', () => {
  it('keeps the raw reported identity so an unknown host stays diagnosable', () => {
    recordHostClient({ name: 'brand-new-ide', version: '9.9.9' });
    expect(hostClient()).toEqual({ name: 'brand-new-ide', version: '9.9.9', title: undefined });
    expect(detectHostPlatform()).toBeNull();   // unrecognized, but not invisible
  });

  it('ignores malformed handshake payloads without throwing', () => {
    for (const bad of [null, undefined, 'claude-code', 42, {}, { name: '' }, { name: 123 }]) {
      expect(() => recordHostClient(bad)).not.toThrow();
    }
    expect(hostClient()).toBeNull();
  });

  it('falls back to title when the name does not identify the host', () => {
    recordHostClient({ name: 'mcp-client', title: 'Gemini CLI' });
    expect(detectHostPlatform()).toBe('gemini');
  });
});

describe('detectHostPlatform', () => {
  it('is null before any handshake', () => {
    expect(detectHostPlatform()).toBeNull();
  });

  it('reads the handshake lazily off the server and caches it', () => {
    let calls = 0;
    const server = { getClientVersion: () => { calls++; return { name: 'codex-cli', version: '0.130.0' }; } };
    expect(detectHostPlatform(server)).toBe('codex');
    expect(detectHostPlatform(server)).toBe('codex');
    expect(calls).toBe(1);   // cached: identity cannot change within a connection
  });

  it('survives a server that throws or lacks the accessor', () => {
    expect(detectHostPlatform({ getClientVersion: () => { throw new Error('not initialized'); } })).toBeNull();
    expect(detectHostPlatform({})).toBeNull();
    expect(detectHostPlatform(undefined)).toBeNull();
  });
});
