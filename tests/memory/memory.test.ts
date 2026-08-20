import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportMemoryMarkdown } from '../../src/memory/sync.js';
import {
  saveSession,
  restoreSession,
  listSessions,
  storeKnowledge,
  searchKnowledge,
  deleteKnowledge,
  updateProjectMap,
  getProjectMap,
  resetDb,
} from '../../src/memory/local.js';

beforeEach(() => {
  resetDb();
});

describe('sessions', () => {
  it('saveSession returns a session_id and saved_at', () => {
    const result = saveSession({ platform: 'claude', summary: 'test session' });
    expect(typeof result.session_id).toBe('string');
    expect(result.session_id.length).toBeGreaterThan(0);
    expect(typeof result.saved_at).toBe('string');
  });

  it('context_warning is false when token count is low', () => {
    const result = saveSession({ platform: 'claude', token_count: 1000 });
    expect(result.context_warning).toBe(false);
    expect(result.continuation_prompt).toBeNull();
  });

  it('context_warning is true when token count exceeds 80% of context window', () => {
    const result = saveSession({ platform: 'claude', token_count: 170_000 });
    expect(result.context_warning).toBe(true);
    expect(result.usage_pct).toBeGreaterThanOrEqual(80);
    expect(result.continuation_prompt).toContain(result.session_id);
  });

  it('restoreSession finds a saved session', () => {
    const saved = saveSession({ platform: 'gemini', summary: 'my session' });
    const restored = restoreSession(saved.session_id);
    expect(restored.found).toBe(true);
    expect(restored.session?.summary).toBe('my session');
    expect(restored.session?.platform).toBe('gemini');
  });

  it('restoreSession returns found:false for unknown id', () => {
    const result = restoreSession('non-existent-id');
    expect(result.found).toBe(false);
    expect(result.session).toBeUndefined();
  });

  it('restoreSession updates active_client when provided', () => {
    const saved = saveSession({ platform: 'claude' });
    const restored = restoreSession(saved.session_id, 'gemini');
    expect(restored.session?.active_client).toBe('gemini');
  });

  it('listSessions returns recently saved sessions', () => {
    saveSession({ platform: 'claude' });
    saveSession({ platform: 'gemini' });
    const sessions = listSessions(10);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('knowledge base', () => {
  it('storeKnowledge returns a uuid string', () => {
    const id = storeKnowledge({ title: 'test', content: 'content here' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('searchKnowledge finds stored entries by query', () => {
    storeKnowledge({ title: 'JWT auth fix', content: 'use RS256 algorithm' });
    const results = searchKnowledge({ query: 'RS256' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('RS256');
  });

  it('searchKnowledge returns empty when query does not match', () => {
    storeKnowledge({ title: 'something', content: 'unrelated stuff' });
    const results = searchKnowledge({ query: 'completelydifferentxyz' });
    expect(results.length).toBe(0);
  });

  it('searchKnowledge filters by type', () => {
    storeKnowledge({ title: 'a pattern', content: 'x', type: 'pattern' });
    storeKnowledge({ title: 'a solution', content: 'y', type: 'solution' });
    const patterns = searchKnowledge({ type: 'pattern' });
    expect(patterns.every(r => r.type === 'pattern')).toBe(true);
  });

  it('searchKnowledge filters by project_dir', () => {
    storeKnowledge({ title: 'proj entry', content: 'abc', project_dir: '/my/project' });
    storeKnowledge({ title: 'other entry', content: 'def', project_dir: '/other/project' });
    const results = searchKnowledge({ project_dir: '/my/project' });
    expect(results.every(r => r.project_dir === '/my/project')).toBe(true);
  });

  it('deleteKnowledge removes the entry and returns true', () => {
    const id = storeKnowledge({ title: 'to delete', content: 'bye' });
    const deleted = deleteKnowledge(id);
    expect(deleted).toBe(true);
    const results = searchKnowledge({ query: 'bye' });
    expect(results.length).toBe(0);
  });

  it('deleteKnowledge returns false for unknown id', () => {
    const result = deleteKnowledge('fake-id-xyz');
    expect(result).toBe(false);
  });
});

describe('project map', () => {
  it('updateProjectMap stores and getProjectMap retrieves it', () => {
    updateProjectMap({
      project_dir: '/test/project',
      structure: { src: ['index.ts'] },
      tech_stack: ['TypeScript', 'Node.js'],
    });
    const map = getProjectMap('/test/project');
    expect(map).not.toBeNull();
    expect(map!.project_dir).toBe('/test/project');
    expect(map!.tech_stack).toContain('TypeScript');
  });

  it('getProjectMap returns falsy for unknown directory', () => {
    const result = getProjectMap('/nonexistent/dir');
    expect(result).toBeFalsy();
  });

  it('updateProjectMap updates existing entry', () => {
    updateProjectMap({ project_dir: '/proj', structure: { v: 1 } });
    updateProjectMap({ project_dir: '/proj', structure: { v: 2 }, tech_stack: ['React'] });
    const map = getProjectMap('/proj');
    expect(map!.tech_stack).toContain('React');
  });
});

describe('markdown export', () => {
  it('exportMemoryMarkdown succeeds with a project_dir filter', () => {
    storeKnowledge({ title: 'scoped entry', content: 'scoped content', project_dir: '/my/project' });
    storeKnowledge({ title: 'other entry', content: 'other content', project_dir: '/other/project' });
    const outPath = join(tmpdir(), `veto-md-export-${Date.now()}.md`);
    const result = exportMemoryMarkdown('/my/project', outPath);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.sections.knowledge_base).toBe(1);
    const md = readFileSync(outPath, 'utf-8');
    expect(md).toContain('scoped entry');
    expect(md).not.toContain('other entry');
    rmSync(outPath, { force: true });
  });

  it('exportMemoryMarkdown succeeds without a project_dir filter', () => {
    storeKnowledge({ title: 'global entry', content: 'global content' });
    const outPath = join(tmpdir(), `veto-md-export-all-${Date.now()}.md`);
    const result = exportMemoryMarkdown(undefined, outPath);
    expect(result.success).toBe(true);
    expect(result.sections.knowledge_base).toBeGreaterThanOrEqual(1);
    rmSync(outPath, { force: true });
  });
});
