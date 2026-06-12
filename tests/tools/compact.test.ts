import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCompactToolList, findTools, isCompactMode, META_TOOL_DEFINITIONS, getToolByName } from '../../src/tools/compact.js';
import { TOOL_DEFINITIONS } from '../../src/tools/definitions.js';
import { callTool } from '../../src/server.js';
import { resetDb } from '../../src/memory/local.js';

beforeEach(() => resetDb());
afterEach(() => { delete process.env.VETO_COMPACT; });

function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return callTool({ params: { name, arguments: args } });
}
function body(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('compact tool list', () => {
  it('exposes the two meta-tools plus a small first-class set', () => {
    const list = getCompactToolList();
    const names = list.map(t => t.name);
    expect(names).toContain('veto_find_tools');
    expect(names).toContain('veto_call');
    expect(names).toContain('veto_status');
    expect(names).toContain('veto_session_save');
    expect(names).toContain('veto_council_debate');
    expect(list.length).toBeLessThanOrEqual(10);
  });

  it('is at least 5x smaller than the full surface', () => {
    const compactChars = JSON.stringify(getCompactToolList()).length;
    const fullChars = JSON.stringify(TOOL_DEFINITIONS).length;
    expect(compactChars).toBeLessThan(fullChars / 5);
  });

  it('every compact entry has a valid inputSchema', () => {
    for (const tool of getCompactToolList()) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

describe('isCompactMode', () => {
  it('defaults to false', () => {
    delete process.env.VETO_COMPACT;
    expect(isCompactMode()).toBe(false);
  });

  it('VETO_COMPACT=1 enables it', () => {
    process.env.VETO_COMPACT = '1';
    expect(isCompactMode()).toBe(true);
  });

  it('VETO_COMPACT=false disables it even if set', () => {
    process.env.VETO_COMPACT = 'false';
    expect(isCompactMode()).toBe(false);
  });
});

describe('findTools — catalog search', () => {
  it('finds the security scanner for "security scan"', () => {
    const names = findTools('security scan').map(t => t.name);
    expect(names[0]).toBe('veto_security_scan');
  });

  it('finds commit message generation', () => {
    const names = findTools('commit message').map(t => t.name);
    expect(names).toContain('veto_commit_message');
  });

  it('finds dead code detection', () => {
    const names = findTools('dead code').map(t => t.name);
    expect(names).toContain('veto_dead_code');
  });

  it('returns full schemas, not just names', () => {
    const [first] = findTools('clone duplicate code');
    expect(first.inputSchema).toBeDefined();
  });

  it('respects the limit parameter', () => {
    expect(findTools('review', 3).length).toBeLessThanOrEqual(3);
  });

  it('returns empty for a no-match query', () => {
    expect(findTools('zzzqqqxyz')).toEqual([]);
  });

  it('getToolByName resolves exact names', () => {
    expect(getToolByName('veto_health')?.name).toBe('veto_health');
    expect(getToolByName('veto_nope')).toBeUndefined();
  });
});

describe('meta-tool dispatch', () => {
  it('veto_find_tools returns matches with usage guidance', async () => {
    const b = body(await call('veto_find_tools', { query: 'secrets' }));
    expect(b.success).toBe(true);
    expect(b.matches).toBeGreaterThan(0);
    expect(b.tools[0].name).toContain('secret');
  });

  it('veto_find_tools errors without a query', async () => {
    const res = await call('veto_find_tools');
    expect(res.isError).toBe(true);
  });

  it('veto_call proxies to a real tool', async () => {
    const res = await call('veto_call', { tool: 'veto_health' });
    const b = body(res);
    expect(b.success).toBe(true);
    expect(b.status).toBe('healthy');
  });

  it('veto_call forwards args to the inner tool', async () => {
    const res = await call('veto_call', {
      tool: 'veto_route_task',
      args: { task: 'rename a variable' },
    });
    const b = body(res);
    expect(b.complexity).toBeDefined();
  });

  it('veto_call rejects unknown tools with discovery guidance', async () => {
    const res = await call('veto_call', { tool: 'veto_made_up' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('veto_find_tools');
  });

  it('veto_call refuses recursion', async () => {
    const res = await call('veto_call', { tool: 'veto_call', args: { tool: 'veto_health' } });
    expect(res.isError).toBe(true);
  });

  it('META_TOOL_DEFINITIONS are well-formed', () => {
    expect(META_TOOL_DEFINITIONS).toHaveLength(2);
    for (const def of META_TOOL_DEFINITIONS) {
      expect(def.inputSchema).toHaveProperty('properties');
    }
  });
});
