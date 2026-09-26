import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it, expect } from 'vitest';
import { workerHandlers } from '../../src/server/handlers/workers.js';
import { getDb, getScanDiagnostics } from '../../src/memory/local.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-workers-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const call = async (name: string, args: Record<string, unknown>) => {
  const res: any = await workerHandlers[name]({ request: {}, args } as any);
  return { res, body: JSON.parse(res.content[0].text) };
};

const KEY = 'sk_live_' + '51Hx8KjLmNoPqRsTuVwXyZ0123456789abcdef';

describe('worker handler registry', () => {
  it('registers the expected worker tools', () => {
    expect(Object.keys(workerHandlers).sort()).toEqual([
      'veto_a11y_advisor', 'veto_api_contract', 'veto_code_review', 'veto_explain',
      'veto_lint_rules', 'veto_merge_conflict', 'veto_playwright', 'veto_sdd_agent',
      'veto_secrets_scan', 'veto_security_scan', 'veto_semantic_search', 'veto_summarize',
      'veto_test_gaps', 'veto_translate', 'veto_type_coverage',
    ].sort());
  });

  it('each handler delegates to the agentic worker loop (fallback envelope without Sampling)', async () => {
    const { body } = await call('veto_code_review', { task: 'review x' });
    expect(body.mode).toBe('agentic_fallback');
    expect(body.llm_upgrade.prompt.agent).toBe('reviewer');
  });

  it('veto_explain picks coder when a file_path is supplied, else debugger — and reads the file', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'a.ts'), 'export const answer = 42;\n');
    const withFile = await call('veto_explain', { file_path: join(dir, 'a.ts') });
    const withoutFile = await call('veto_explain', { text: 'TypeError: x is undefined' });
    expect(withFile.body.llm_upgrade.prompt.agent).toBe('coder');
    expect(withFile.body.llm_upgrade.prompt.output_prompt).toContain('export const answer = 42;');
    expect(withoutFile.body.llm_upgrade.prompt.agent).toBe('debugger');
    expect(withoutFile.body.llm_upgrade.prompt.output_prompt).toContain('TypeError: x is undefined');
  });
});

describe('inputs reach the agent (they were silently dropped before 3.7.0)', () => {
  it('veto_secrets_scan scans the text it is given, with a deterministic pass first', async () => {
    const { body } = await call('veto_secrets_scan', { text: `const key = "${KEY}";` });
    expect(body.deterministic_findings.findings.length).toBeGreaterThan(0);
    expect(body.llm_upgrade.prompt.output_prompt).toContain(KEY);
    expect(body.generation).toBe('deterministic_only');
  });

  it('veto_translate carries the text and target languages, and asks for translations', async () => {
    const { body } = await call('veto_translate', { text: 'Order placed, {name}!', target_langs: ['fr', 'de'] });
    expect(body.facts.target_langs).toEqual(['fr', 'de']);
    expect(body.llm_upgrade.prompt.output_prompt).toContain('Order placed, {name}!');
    expect(body.llm_upgrade.prompt.output_prompt).toMatch(/target_langs: \["fr","de"\]/);
    expect(body.llm_upgrade.prompt.schema).toContain('"translations"');
  });

  it('veto_translate refuses to run with nothing to translate', async () => {
    const { res } = await call('veto_translate', { text: 'hi' });
    expect(res.isError).toBe(true);
  });

  it('a file argument that does not exist is an error, not an empty analysis', async () => {
    const { res, body } = await call('veto_a11y_advisor', { file_path: join(makeRoot(), 'nope.html') });
    expect(res.isError).toBe(true);
    expect(body.message).toMatch(/file_path not found/);
  });

  it('veto_semantic_search returns ranked matches as facts before any LLM', async () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'money.ts'), 'export function formatPrice(cents: number) {\n  return "$" + cents / 100;\n}\n');
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const unrelated = 1;\n');
    const { body } = await call('veto_semantic_search', { query: 'where are prices formatted', project_dir: dir });
    expect(body.facts.hits[0]).toMatchObject({ file: 'src/money.ts', line: 1 });
    expect(body.llm_upgrade.prompt.output_prompt).toContain('src/money.ts:1');
  });

  it('veto_merge_conflict reports a file with no conflict markers instead of "resolving" it', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'clean.ts'), 'const a = 1;\n');
    const { res, body } = await call('veto_merge_conflict', { file_path: join(dir, 'clean.ts') });
    expect(res.isError).toBe(true);
    expect(body.message).toMatch(/No conflict markers/);
  });

  it('veto_merge_conflict locates each conflict block', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'c.ts'), 'a\n<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> feature\nb\n');
    const { body } = await call('veto_merge_conflict', { file_path: join(dir, 'c.ts') });
    expect(body.facts).toEqual({ conflicts: 1, hunks: [{ start_line: 2, end_line: 6 }] });
    expect(body.llm_upgrade.prompt.schema).toContain('"resolved_content"');
  });

  it('veto_type_coverage counts any-usage deterministically', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }');
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.ts'), 'export function login(u: any) { return (u as any).name; }\n// @ts-ignore\nconst x = 1;\n');
    const { body } = await call('veto_type_coverage', { project_dir: dir });
    expect(body.facts.total).toBe(2);
    expect(body.facts.by_kind).toEqual({ 'as any': 1, 'ts-ignore': 1 });
    expect(body.facts.tsconfig).toEqual({ found: true, strict: true, noImplicitAny: null });
    expect(body.facts.sensitive.length).toBe(2);
  });

  it('scanners store findings for the editor when given a file_path (the description always said so)', async () => {
    const dir = makeRoot();
    const file = join(dir, 'leak.ts');
    writeFileSync(file, `export const key = "${KEY}";\n`);
    getDb().exec('DELETE FROM scan_diagnostics');
    await call('veto_secrets_scan', { file_path: file });
    expect(getScanDiagnostics(file).length).toBeGreaterThan(0);
  });
});
