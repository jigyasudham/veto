import { describe, it, expect, beforeEach } from 'vitest';
import { addConstraint, listConstraints, setConstraintActive, checkDiffAgainstConstraints } from '../../src/memory/decisions.js';
import { resetDb } from '../../src/memory/local.js';
import { callTool } from '../../src/server.js';

beforeEach(() => resetDb());

const MONGO_DIFF = [
  'diff --git a/src/db.ts b/src/db.ts',
  '--- a/src/db.ts',
  '+++ b/src/db.ts',
  '@@ -1,3 +1,4 @@',
  " import { config } from './config';",
  "+import mongoose from 'mongoose';",
  "-const legacy = require('mongodb');",
  '+const db = await connect();',
].join('\n');

describe('constraint CRUD', () => {
  it('add + list round-trip', () => {
    const c = addConstraint({ rule: 'We use Postgres', forbidden_patterns: ['mongoose', 'mongodb'], why: 'decided 2026-05', severity: 'block' });
    expect(c.id).toBeTruthy();
    const all = listConstraints();
    expect(all).toHaveLength(1);
    expect(all[0].rule).toBe('We use Postgres');
    expect(all[0].forbidden_patterns).toEqual(['mongoose', 'mongodb']);
    expect(all[0].active).toBe(true);
  });

  it('project-scoped constraints only apply to their project; global apply everywhere', () => {
    addConstraint({ rule: 'project A rule', forbidden_patterns: ['x'], project_dir: 'D:\\ProjectA' });
    addConstraint({ rule: 'global rule', forbidden_patterns: ['y'] });
    const forA = listConstraints('d:/projecta/');
    expect(forA.map(c => c.rule).sort()).toEqual(['global rule', 'project A rule']);
    const forB = listConstraints('D:/ProjectB');
    expect(forB.map(c => c.rule)).toEqual(['global rule']);
  });

  it('disable removes a constraint from active lists and checks', () => {
    const c = addConstraint({ rule: 'no mongo', forbidden_patterns: ['mongoose'] });
    expect(setConstraintActive(c.id, false)).toBe(true);
    expect(listConstraints()).toHaveLength(0);
    expect(listConstraints(undefined, true)).toHaveLength(1);
    expect(checkDiffAgainstConstraints(MONGO_DIFF)).toEqual([]);
  });
});

describe('checkDiffAgainstConstraints', () => {
  it('flags added lines that match a forbidden pattern', () => {
    addConstraint({ rule: 'We use Postgres', forbidden_patterns: ['mongoose', 'mongodb'] });
    const violations = checkDiffAgainstConstraints(MONGO_DIFF);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/db.ts');
    expect(violations[0].matched_pattern).toBe('mongoose');
    expect(violations[0].severity).toBe('block');
  });

  it('removed and context lines never trigger (mongodb only appears on a removed line)', () => {
    addConstraint({ rule: 'no mongodb driver', forbidden_patterns: ['mongodb'] });
    expect(checkDiffAgainstConstraints(MONGO_DIFF)).toEqual([]);
  });

  it('file_scope limits where a constraint fires', () => {
    addConstraint({ rule: 'no mongoose in src', forbidden_patterns: ['mongoose'], file_scope: 'lib/**' });
    expect(checkDiffAgainstConstraints(MONGO_DIFF)).toEqual([]);
    addConstraint({ rule: 'scoped to src', forbidden_patterns: ['mongoose'], file_scope: 'src/**/*.ts' });
    expect(checkDiffAgainstConstraints(MONGO_DIFF)).toHaveLength(1);
  });

  it('patterns are case-insensitive regexes', () => {
    addConstraint({ rule: 'no var declarations', forbidden_patterns: ['^\\s*var\\s'] });
    const diff = 'diff --git a/a.js b/a.js\n+++ b/a.js\n+var x = 1;\n+const ok = 2;';
    const violations = checkDiffAgainstConstraints(diff);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe('var x = 1;');
  });

  it('an invalid regex degrades to substring matching instead of throwing', () => {
    addConstraint({ rule: 'broken regex still works', forbidden_patterns: ['lodash(('] });
    const diff = 'diff --git a/a.js b/a.js\n+++ b/a.js\n+import x from "lodash((";';
    expect(checkDiffAgainstConstraints(diff)).toHaveLength(1);
  });

  it('warn severity is carried through', () => {
    addConstraint({ rule: 'prefer dayjs', forbidden_patterns: ['moment'], severity: 'warn' });
    const diff = 'diff --git a/a.js b/a.js\n+++ b/a.js\n+import moment from "moment";';
    const v = checkDiffAgainstConstraints(diff);
    expect(v[0].severity).toBe('warn');
  });

  it('no constraints or empty diff → no violations', () => {
    expect(checkDiffAgainstConstraints(MONGO_DIFF)).toEqual([]);
    addConstraint({ rule: 'x', forbidden_patterns: ['x'] });
    expect(checkDiffAgainstConstraints('')).toEqual([]);
  });
});

describe('veto_decisions handler', () => {
  function call(args: Record<string, unknown>): Promise<any> {
    return callTool({ params: { name: 'veto_decisions', arguments: args } });
  }
  function body(res: any): any {
    return JSON.parse(res.content[0].text);
  }

  it('add requires rule and patterns', async () => {
    const res = await call({ action: 'add', rule: 'no patterns given' });
    expect(res.isError).toBe(true);
  });

  it('add → check round-trip fails a violating diff', async () => {
    await call({ action: 'add', rule: 'We use Postgres', forbidden_patterns: ['mongoose'] });
    const b = body(await call({ action: 'check', diff: MONGO_DIFF }));
    expect(b.verdict).toBe('fail');
    expect(b.violations_found).toBe(1);
  });

  it('check passes a clean diff', async () => {
    await call({ action: 'add', rule: 'We use Postgres', forbidden_patterns: ['mongoose'] });
    const clean = 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+import { Pool } from "pg";';
    const b = body(await call({ action: 'check', diff: clean }));
    expect(b.verdict).toBe('pass');
  });

  it('disable → check passes the previously violating diff', async () => {
    const added = body(await call({ action: 'add', rule: 'no mongo', forbidden_patterns: ['mongoose'] }));
    await call({ action: 'disable', id: added.constraint.id });
    const b = body(await call({ action: 'check', diff: MONGO_DIFF }));
    expect(b.verdict).toBe('pass');
  });

  it('unknown action errors', async () => {
    const res = await call({ action: 'destroy' });
    expect(res.isError).toBe(true);
  });
});

describe('diff review integration', () => {
  it('veto_diff_review surfaces decision drift even in the agentic-loop phase', async () => {
    await callTool({ params: { name: 'veto_decisions', arguments: { action: 'add', rule: 'We use Postgres', forbidden_patterns: ['mongoose'] } } });
    const res = await callTool({ params: { name: 'veto_diff_review', arguments: { diff: MONGO_DIFF } } });
    const b = JSON.parse(res.content[0].text);
    expect(b.decision_drift).toBeDefined();
    expect(b.decision_drift.violations_found).toBe(1);
    expect(b.decision_drift.violations[0].rule).toBe('We use Postgres');
  });
});
