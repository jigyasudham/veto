// Tools must never present filler as a result. Before 3.7.0, with no LLM step,
// veto_diagram returned `"mermaid": "Documentation looks complete."`, the dead
// code and flag scanners could never match anything, and several tools dropped
// or mis-resolved their inputs. Each case here is one of those, fixed.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { callTool } from '../../src/server.js';
import { parseDeliverableResponse } from '../../src/agents/llm-runner.js';
import { handlerAgentResponse, type HandlerAgentRun } from '../../src/server/scan-core.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-honest-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.unstubAllGlobals(); });

async function tool(name: string, args: Record<string, unknown>) {
  const res: any = await callTool({ params: { name, arguments: args } });
  return { res, body: JSON.parse(res.content[0].text) };
}

let project: string;
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'veto-honest-project-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shop', main: 'src/index.ts', dependencies: { express: '^4.19.2' } }));
  writeFileSync(join(project, 'src', 'app.ts'), [
    "import express from 'express';",
    "import { formatPrice } from './money.js';",
    'const app = express();',
    "app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));",
    "app.post('/orders', (req, res) => res.json({ total: formatPrice(1) }));",
    "if (process.env.FEATURE_NEW_CHECKOUT === 'on') console.log('new');",
  ].join('\n'));
  writeFileSync(join(project, 'src', 'money.ts'), 'export function formatPrice(c: number) { return c; }\nexport function unusedLegacy() { return null; }\n');
  writeFileSync(join(project, 'src', 'index.ts'), 'export const version = 1;\n');
  const git = (c: string) => execSync(c, { cwd: project, stdio: 'pipe', windowsHide: true });
  git('git init -q');
  git('git -c user.name=t -c user.email=t@t add -A');
  git('git -c user.name=t -c user.email=t@t commit -qm init');
});

describe('the deliverable contract', () => {
  const d = { description: 'x', shape: { mermaid: '"..."', notes: '"..."' }, required: ['mermaid'] };
  it('accepts the wrapped or bare object and keeps only declared keys', () => {
    expect(parseDeliverableResponse({ agent: 'a', deliverable: { mermaid: 'flowchart TD', extra: 1 } }, d)).toEqual({ mermaid: 'flowchart TD' });
    expect(parseDeliverableResponse('{"mermaid": "graph LR"}', d)).toEqual({ mermaid: 'graph LR' });
  });
  it('rejects a missing or empty required field (AGENTS.md rule 5)', () => {
    expect(parseDeliverableResponse({ deliverable: { notes: 'hi' } }, d)).toBeNull();
    expect(parseDeliverableResponse({ deliverable: { mermaid: '   ' } }, d)).toBeNull();
    expect(parseDeliverableResponse('no json here', d)).toBeNull();
  });
});

describe('handlerAgentResponse', () => {
  const run = (over: Partial<HandlerAgentRun>): HandlerAgentRun => ({ result: { id: 'x', agent: 'reviewer', output: { confidence: 0, severity: 'info', recommendation: 'Documentation looks complete.', affected_files: [], line_refs: [] }, duration_ms: 0 }, text: 'Documentation looks complete.', deliverable: null, generated_by: 'none', ...over });
  it('nulls generated fields when no LLM ran, and says so', () => {
    const out = JSON.parse(handlerAgentResponse({ facts: 1, mermaid: 'Documentation looks complete.' }, run({}), { generated: ['mermaid'] }).content[0].text);
    expect(out).toMatchObject({ facts: 1, mermaid: null, generation: 'needs_llm', generated_by: 'none' });
  });
  it('turns a malformed Phase-2 answer into a visible error', () => {
    const res = handlerAgentResponse({}, run({ error: 'LLM response malformed: expected …' }), { generated: ['x'] });
    expect(res).toMatchObject({ isError: true });
  });
});

describe('generators without an LLM return facts and nulls, never filler', () => {
  it('veto_diagram', async () => {
    const { body } = await tool('veto_diagram', { project_dir: project });
    expect(body).toMatchObject({ mermaid: null, generation: 'needs_llm' });
    expect(body.llm_upgrade.prompt.schema).toContain('"mermaid"');
  });

  it("keeps a tool's own status field (the generation marker has its own key)", async () => {
    const { body } = await tool('veto_sre_advisor', { slo_target: 99.9, window_days: 30, downtime_minutes: 50 });
    expect(body.status).toBe('exhausted');
    expect(body.generation).toBe('needs_llm');
    expect(body.improvements).toBeNull();
  });

  it('veto_diagram with a valid agent_response returns the diagram; an invalid one is refused', async () => {
    const good = await tool('veto_diagram', { project_dir: project, agent_response: { deliverable: { mermaid: 'flowchart TD\n  A-->B' } } });
    expect(good.body).toMatchObject({ mermaid: 'flowchart TD\n  A-->B', generation: 'complete', generated_by: 'agent_response' });
    const bad = await tool('veto_diagram', { project_dir: project, agent_response: { deliverable: { mermaid: 'Documentation looks complete.' } } });
    expect(bad.body.mermaid).toBeNull();
    expect(bad.body.problem).toMatch(/not start with a Mermaid diagram keyword/);
    const malformed = await tool('veto_diagram', { project_dir: project, agent_response: { approach: 'a plan' } });
    expect(malformed.res.isError).toBe(true);
    expect(malformed.body.error).toMatch(/LLM response malformed/);
  });

  it('veto_doc_gen never returns a file that lost code', async () => {
    const file = join(project, 'src', 'money.ts');
    const lossy = await tool('veto_doc_gen', { file_path: file, agent_response: { deliverable: { annotated_content: '/** x */\nexport function formatPrice(c: number) { return c; }\n' } } });
    expect(lossy.body.annotated_content).toBeNull();
    expect(lossy.body.problem).toMatch(/dropped or changed 1 line/);
    const full = readFileSync(file, 'utf8').replace('export function formatPrice', '/** Formats a price. @param c cents @returns c */\nexport function formatPrice');
    const ok = await tool('veto_doc_gen', { file_path: file, agent_response: { deliverable: { annotated_content: full } } });
    expect(ok.body.annotated_content).toBe(full);
    expect(ok.body.documentation_gaps).toBeDefined();
  });

  it('veto_env_setup does not write a placeholder, nor replace an existing file', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'app.js'), 'const url = process.env.DATABASE_URL;\n');
    const first = await tool('veto_env_setup', { project_dir: dir, write_files: true });
    expect(first.body).toMatchObject({ env_example: null, written: false, env_vars_referenced: ['DATABASE_URL'] });
    expect(existsSync(join(dir, '.env.example'))).toBe(false);

    writeFileSync(join(dir, '.env.example'), 'MINE=1\n');
    const answer = { deliverable: { env_example: '# db\nDATABASE_URL=postgres://localhost/x', setup_steps: ['npm i'] } };
    const kept = await tool('veto_env_setup', { project_dir: dir, write_files: true, agent_response: answer });
    expect(kept.body.written).toBe(false);
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toBe('MINE=1\n');
    const replaced = await tool('veto_env_setup', { project_dir: dir, write_files: true, overwrite: true, agent_response: answer });
    expect(replaced.body.written).toBe(true);
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toContain('DATABASE_URL=');
  });
});

describe('scanners that could never match now find things', () => {
  it('veto_dead_code finds an export no other file uses, and treats the entry point as public API', async () => {
    const { body } = await tool('veto_dead_code', { project_dir: project });
    expect(body.unused_exports.map((u: { symbol: string }) => u.symbol)).toEqual(['unusedLegacy']);
    expect(body.public_api_exports).toBe(1);
    expect(body.assessment).toBeNull();
  });

  it('veto_flag_auditor finds the env flag with its location', async () => {
    const { body } = await tool('veto_flag_auditor', { project_dir: project });
    expect(body.flags).toEqual([{ name: 'FEATURE_NEW_CHECKOUT', sdk: 'env', locations: ['src/app.ts:6'] }]);
  });

  it('veto_openapi_gen finds routes by content, not file name', async () => {
    const { body } = await tool('veto_openapi_gen', { project_dir: project });
    expect(body.route_files).toEqual(['src/app.ts']);
    expect(body.routes_detected).toBe(2);
    expect(body.spec).toBeNull();
  });
});

describe('inputs resolved correctly', () => {
  it('veto_git_blame resolves file_path against project_dir', async () => {
    const { res, body } = await tool('veto_git_blame', { project_dir: project, file_path: 'src/app.ts' });
    expect(res.isError).toBeFalsy();
    expect(body.total_commits).toBe(1);
  });

  it('veto_project_map_update stores an object, and get reads it back', async () => {
    await tool('veto_project_map_update', { project_dir: project, structure: { src: ['app.ts'] } });
    const { body } = await tool('veto_project_map_get', { project_dir: project });
    expect(body.structure).toEqual({ src: ['app.ts'] });
  });

  it('veto_dep_advisor asks OSV about the version actually allowed, not the major', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', async (url: string, init?: { body: string }) => {
      if (url.endsWith('/querybatch')) {
        sent = JSON.parse(init!.body);
        return { ok: true, json: async () => ({ results: [{ vulns: [{ id: 'GHSA-qw6h-vgh9-j6wx' }] }] }) } as any;
      }
      // The detail lookup that querybatch's id-only answer needs.
      return { ok: true, json: async () => ({ summary: 'express vulnerable to XSS via response.redirect()', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'express' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.20.0' }] }] }] }) } as any;
    });
    const { body } = await tool('veto_dep_advisor', { project_dir: project });
    expect(sent.queries[0]).toEqual({ package: { name: 'express', ecosystem: 'npm' }, version: '4.19.2' });
    expect(body.vulns).toEqual([{ package: 'express', version: '4.19.2', vuln_id: 'GHSA-qw6h-vgh9-j6wx', severity: 'moderate', summary: 'express vulnerable to XSS via response.redirect()', fixed_in: ['4.20.0'] }]);
  });
});

describe('planning tools work from the request, not canned advice', () => {
  it('veto_task_parse splits the request into its own clauses, routed and ordered', async () => {
    const { body } = await tool('veto_task_parse', { description: 'Add pagination to GET /users, then write tests, then update the README' });
    expect(body.source).toBe('clause_split');
    expect(body.tasks).toEqual([
      { id: 'task-1', agent: 'api', task: 'Add pagination to GET /users', dependencies: [] },
      { id: 'task-2', agent: 'tester', task: 'write tests', dependencies: ['task-1'] },
      { id: 'task-3', agent: 'documentation', task: 'update the README', dependencies: ['task-2'] },
    ]);
  });

  it('veto_task_parse accepts an LLM split, but only with known agents and real dependencies', async () => {
    const { body } = await tool('veto_task_parse', {
      description: 'Add pagination, then write tests',
      agent_response: { deliverable: { tasks: [
        { id: 'a', agent: 'api', task: 'Add cursor pagination', dependencies: [] },
        { id: 'b', agent: 'wizard', task: 'Write tests for pagination', dependencies: ['a', 'zzz'] },
      ] } },
    });
    expect(body.source).toBe('llm');
    expect(body.tasks[1]).toEqual({ id: 'b', agent: 'tester', task: 'Write tests for pagination', dependencies: ['a'] });
  });

  it('veto_delegate does not pass the agent\'s canned paragraph off as the answer', async () => {
    const { body } = await tool('veto_delegate', { agent_id: 'reviewer', task: 'review src/app.ts' });
    expect(body.summary).toBeNull();
    expect(body.generation).toBe('needs_llm');
    const unknown = await tool('veto_delegate', { agent_id: 'wizard', task: 'x' });
    expect(unknown.res.isError).toBe(true);
  });

  it('veto_council_debate: a response with none of the seven is an error; a partial one says how much was real', async () => {
    const none = await callTool({ params: { name: 'veto_council_debate', arguments: { task: 'Add coupons', agent_responses: { foo: { verdict: 'approve', reason: 'x' } } } } }) as any;
    expect(none.isError).toBe(true);
    const partial = await callTool({ params: { name: 'veto_council_debate', arguments: { task: 'Add coupons', agent_responses: { lead_dev: { verdict: 'approve', reason: 'fine' }, security: { verdict: 'approve', reason: 'fine' } } } } }) as any;
    const text = partial.content[0].text as string;
    const payload = JSON.parse(text.slice(text.indexOf('{\n')));
    expect(payload.llm_backed).toBe(false);
    expect(payload.verdict_basis).toBe('2 of 7 votes from agent_responses; the missing 5 filled by keyword rules');
  });

  it('veto_benchmark declares no winner from keyword rules', async () => {
    const { body } = await tool('veto_benchmark', { task: 'cache user lookups', approach_a: 'in-memory LRU', approach_b: 'Redis' });
    expect(body.winner).toBeNull();
    expect(body.confidence).toBe('none');
  });

  it('veto_new_feature: keyword rules cannot block a feature, and a malformed council answer is an error', async () => {
    const bad = await tool('veto_new_feature', { description: 'Add coupons', agent_responses: { council: { nope: 1 } } });
    expect(bad.res.isError).toBe(true);
  });
});

describe('tools say what they cannot do', () => {
  it('veto_notify_ide refuses open_file instead of claiming it was sent', async () => {
    const { res, body } = await tool('veto_notify_ide', { action: 'open_file', path: 'x.ts' });
    expect(res.isError).toBe(true);
    expect(body.message).toMatch(/Nothing was sent/);
  });

  it('veto_workflow rejects a malformed step and names the valid agents', async () => {
    const { res, body } = await tool('veto_workflow', { steps: [{ tool: 'veto_secrets_scan' }] });
    expect(res.isError).toBe(true);
    expect(body.message).toMatch(/step 1: missing id, agent, task/);
    expect(body.agents).toContain('reviewer');
  });

  it('veto_pr_post puts findings in the review body (GitHub rejects inline comments without path/line)', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: 1, html_url: 'https://github.com/o/r/pull/1#r1', state: 'COMMENTED' }) } as any;
    });
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      const { body } = await tool('veto_pr_post', { pr_url: 'https://github.com/o/r/pull/1', findings: [{ severity: 'high', message: 'SQL injection', location: 'src/app.ts:9' }, { severity: 'low', message: 'nit' }] });
      expect(sent.comments).toBeUndefined();
      expect(sent.body).toContain('**[HIGH]** SQL injection — `src/app.ts:9`');
      expect(body.findings_posted).toBe(2);
    } finally { delete process.env.GITHUB_TOKEN; }
  });
});
