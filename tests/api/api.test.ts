// `veto api` against a fixture machine: two projects, each with an archived
// chat, a Veto database, and capture turned on. Proves what council 7bb1073f
// required: a passive snapshot changes no file, search and expand stay inside
// the named project, text comes back masked, a different database is refused,
// and every response matches the published contract.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'transcripts', 'fixtures');
const ROOT = mkdtempSync(join(tmpdir(), 'veto-api-'));
process.env.VETO_TEST_DB = join(ROOT, 'veto', 'veto.db');
process.env.VETO_CONFIG_PATH = join(ROOT, 'veto', 'config.json');
process.env.VETO_TRANSCRIPTS_DIR = join(ROOT, 'veto', 'transcripts');
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.GEMINI_DIR = join(ROOT, 'gemini');
mkdirSync(join(ROOT, 'veto'), { recursive: true });

const PROJECT_A = 'D:\\Api Codex';
const PROJECT_B = 'd:\\api gemini';
const CODEX_SESSION = 'abababab-1111-2222-3333-444444444444';
const GEMINI_SESSION = 'cdcdcdcd-1111-2222-3333-444444444444';
const FAKE_KEY = 'AKIA' + '1234567890ABCDEF';

const local = await import('../../src/memory/local.js');
const store = await import('../../src/transcripts/store.js');
const { enableCapture, disableCapture } = await import('../../src/transcripts/config.js');
const { captureOnSave } = await import('../../src/transcripts/on-save.js');
const { handleApi } = await import('../../src/api/index.js');
const contract = await import('../../src/api/contract.js');

{
  const day = join(ROOT, 'codex', 'sessions', '2026', '05', '07');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-05-07T22-03-04-${CODEX_SESSION}.jsonl`),
    readFileSync(join(FIXTURES, 'codex-sample.jsonl'), 'utf8')
      .replace(/"id":"CODEXA"/, `"id":"${CODEX_SESSION}"`)
      .replace(/D:\\\\Job automation/g, PROJECT_A.replace(/\\/g, '\\\\')));
  const gdir = join(ROOT, 'gemini', 'tmp', 'api-gemini');
  mkdirSync(join(gdir, 'chats'), { recursive: true });
  writeFileSync(join(gdir, '.project_root'), PROJECT_B);
  writeFileSync(join(gdir, 'chats', 'session-2026-05-03T13-49-cdcdcdcd.jsonl'),
    readFileSync(join(FIXTURES, 'gemini-sample.jsonl'), 'utf8').replace(/5dc752e2-f64c-4f68-929e-d0cca523724b/g, GEMINI_SESSION));

  local.saveSession({ platform: 'codex', summary: 'api fixture', project_dir: PROJECT_A });
  enableCapture();
  await captureOnSave({ projectDir: PROJECT_A, vetoSessionId: 'v-a', platform: 'codex' });
  await captureOnSave({ projectDir: PROJECT_B, vetoSessionId: 'v-b', platform: 'gemini' });
}

// Each call may switch this process to read-only connections; start every test on fresh ones.
function closeAll(): void { local.resetDb(); store.resetTranscriptsDb(); }
beforeEach(closeAll);
afterAll(() => {
  closeAll();
  rmSync(ROOT, { recursive: true, force: true });
  for (const k of ['VETO_CONFIG_PATH', 'VETO_TRANSCRIPTS_DIR', 'CODEX_HOME', 'GEMINI_DIR']) delete process.env[k];
});

const call = (argv: string[], stdin?: unknown) =>
  handleApi(stdin === undefined ? argv : [...argv, '--stdin'], { version: '9.9.9', stdinText: async () => JSON.stringify(stdin) });

function valid(env: Awaited<ReturnType<typeof call>>, data?: { parse: (x: unknown) => unknown }) {
  contract.envelopeSchema.parse(env);
  if (data && env.state === 'ok') data.parse(env.data);
  if (env.state !== 'ok') expect(env.message, `state ${env.state} needs a message`).toBeTruthy();
  return env as typeof env & { data: any };
}

/** Every file under the fixture's Veto folder, with a hash of its content. */
function fingerprint(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(join(ROOT, 'veto'));
  return out;
}

describe('veto api version', () => {
  it('answers without touching a database', async () => {
    const env = valid(await call(['version']), contract.versionDataSchema);
    expect(env.state).toBe('ok');
    expect(env.data.commands).toEqual(['version', 'snapshot', 'recall search', 'recall expand', 'diagnostics']);
    expect(env.data.cli_path).toMatch(/cli\.js$/);
  });

  it('names what it does not know, and a malformed request', async () => {
    expect((await call(['frobnicate'])).state).toBe('unknown_command');
    expect((await call(['snapshot', '--nope=1'])).state).toBe('invalid_request');
    expect((await handleApi(['snapshot', '--stdin'], { version: 'x', stdinText: async () => '{not json' })).state).toBe('invalid_request');
    expect((await call(['snapshot', '--project=D:\\x'], { project: 'D:\\x' })).state).toBe('invalid_request');
  });
});

describe('veto api snapshot', () => {
  it('reports the cards\' state for one project', async () => {
    const env = valid(await call(['snapshot'], { project: PROJECT_A }), contract.snapshotDataSchema);
    expect(env.state).toBe('ok');
    expect(env.data.database).toMatchObject({ state: 'ok', newer_than_backend: false });
    expect(env.data.transcripts).toMatchObject({
      state: 'ok', capture: 'enabled', recall_permitted: true, archives_in_project: 1, archives_all_projects: 2, by_source_in_project: { codex: 1 },
    });
    expect(env.data.lessons).toMatchObject({ state: 'ok', sharing: 'off', scope: 'all_projects' });
    expect(env.data.trial.state).toBe('unavailable');
  });

  it('changes no file: not the databases, their WAL, the config or the archives', async () => {
    closeAll();
    const before = fingerprint();
    await call(['snapshot'], { project: PROJECT_A });
    closeAll();
    const after = fingerprint();
    for (const [path, hash] of before) expect(after.get(path), path).toBe(hash);
    // A read-only reader of a WAL database may leave empty -wal/-shm sidecars; nothing else may appear.
    const added = [...after.keys()].filter(p => !before.has(p));
    expect(added.filter(p => !/-(wal|shm)$/.test(p))).toEqual([]);
    for (const p of added) expect(statSync(p).size === 0 || /-shm$/.test(p), p).toBe(true);
  });

  it('refuses to answer from a different database than the one named', async () => {
    const env = valid(await call(['snapshot'], { project: PROJECT_A, db: join(ROOT, 'elsewhere.db') }));
    expect(env.state).toBe('db_mismatch');
    expect(env.data).toBeUndefined();
    expect((await call(['snapshot'], { project: PROJECT_A, db: process.env.VETO_TEST_DB })).state).toBe('ok');
  });

  it('never returns a path from the user\'s configuration', async () => {
    const text = JSON.stringify(await call(['snapshot'], { project: PROJECT_A }));
    expect(text).not.toContain(ROOT.replace(/\\/g, '\\\\'));
  });
});

describe('veto api recall', () => {
  it('requires a project, so a search never widens to every project', async () => {
    expect((await call(['recall', 'search'], { query: 'deploy' })).state).toBe('invalid_request');
  });

  it('searches only the named project', async () => {
    const env = valid(await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key' }), contract.recallSearchDataSchema);
    expect(env.state).toBe('ok');
    expect(env.data.hits.length).toBeGreaterThan(0);
    expect(env.data.hits.every((h: any) => h.source_session_id === CODEX_SESSION && h.source === 'codex')).toBe(true);
    // The Gemini chat says this too, but it belongs to the other project.
    const b = valid(await call(['recall', 'search'], { project: PROJECT_B, query: 'deploy.ts key' }), contract.recallSearchDataSchema);
    expect(b.data.hits.every((h: any) => h.source_session_id === GEMINI_SESSION)).toBe(true);
  });

  it('filters by source, and says when nothing matched', async () => {
    const env = valid(await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key', source: 'gemini' }));
    expect(env.state).toBe('no_match');
    expect(env.data.hits).toEqual([]);
  });

  it('keeps pasted secrets out of snippets and expanded text', async () => {
    const env = valid(await call(['recall', 'search'], { project: PROJECT_A, query: FAKE_KEY }));
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY.slice(4));
    const hit = valid(await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key' })).data.hits[0];
    const expanded = valid(await call(['recall', 'expand'], { project: PROJECT_A, event_id: hit.event_id }), contract.recallExpandDataSchema);
    expect(expanded.state).toBe('ok');
    expect(expanded.data.source_session_id).toBe(CODEX_SESSION);
    expect(expanded.data.text).not.toContain(FAKE_KEY);
  });

  it('will not open another project\'s event, and says so exactly as for a missing one', async () => {
    const hit = valid(await call(['recall', 'search'], { project: PROJECT_B, query: 'deploy.ts key' })).data.hits[0];
    const crossed = valid(await call(['recall', 'expand'], { project: PROJECT_A, event_id: hit.event_id }));
    const missing = valid(await call(['recall', 'expand'], { project: PROJECT_A, event_id: 'no-such-event' }));
    expect(crossed.state).toBe('not_found');
    expect({ ...crossed, generated_at: '' }).toEqual({ ...missing, generated_at: '' });
  });

  it('lists the matching chats\' segments, and expands one only inside its own project', async () => {
    const found = valid(await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key' })).data;
    const seg = found.segments.find((s: any) => s.user_messages > 0);
    expect(seg).toBeDefined();
    const expanded = valid(await call(['recall', 'expand'], { project: PROJECT_A, archive_id: seg.archive_id, segment_index: seg.index }), contract.recallExpandDataSchema);
    expect(expanded.state).toBe('ok');
    expect(expanded.data.text.length).toBeGreaterThan(0);
    expect((await call(['recall', 'expand'], { project: PROJECT_B, archive_id: seg.archive_id, segment_index: seg.index })).state).toBe('not_found');
  });

  it('still searches archives kept after capture is turned off, and labels them', async () => {
    disableCapture();
    try {
      const env = valid(await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key' }));
      expect(env.state).toBe('ok');
      expect(env.data.capture).toBe('disabled');
      expect((await call(['snapshot'], { project: PROJECT_A })).data).toMatchObject({ transcripts: { capture: 'disabled', recall_permitted: true } });
    } finally {
      enableCapture();
    }
  });

  it('says nothing is archived for a project with no chats', async () => {
    const env = valid(await call(['recall', 'search'], { project: 'D:\\Nothing Here', query: 'x' }));
    expect(env.state).toBe('no_archive');
    expect(env.next_action).toBeTruthy();
  });
});

describe('veto api diagnostics', () => {
  it('runs no slow check unless asked, and says what it did not check', async () => {
    const env = valid(await call(['diagnostics'], {}), contract.diagnosticsDataSchema);
    expect(env.state).toBe('ok');
    expect(env.data.checked).toEqual({ host_cli: false, probe: false });
    expect(env.data.authentication).toBe('not_checked');
    expect(env.data.database.state).toBe('ok');
    expect(env.data.hosts.every((h: any) => h.probe === null)).toBe(true);
  });

  it('rejects a check it does not know', async () => {
    expect((await call(['diagnostics'], { checks: ['network'] })).state).toBe('invalid_request');
  });
});

/**
 * A response with everything that changes run to run replaced: ids by stable
 * ones in order of appearance, times, durations and machine paths.
 */
function stable(env: unknown): unknown {
  const ids = new Map<string, string>();
  let text = JSON.stringify(env);
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => {
    if (m === CODEX_SESSION || m === GEMINI_SESSION) return m;
    if (!ids.has(m)) ids.set(m, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(m)!;
  });
  const o = JSON.parse(text);
  o.generated_at = '2026-09-27T00:00:00.000Z';
  o.backend_version = '3.8.0';
  if (o.data?.backend_version) o.data.backend_version = '3.8.0';
  if (o.data?.cli_path) o.data.cli_path = '/usr/local/lib/node_modules/@jigyasudham/veto/dist/cli.js';
  if (o.data?.node_version) o.data.node_version = 'v24.0.0';
  if (typeof o.data?.elapsed_ms === 'number') o.data.elapsed_ms = 42;
  if (o.data?.transcripts?.last_archived_at) o.data.transcripts.last_archived_at = '2026-09-26T12:00:00.000Z';
  // The key folds case on Windows only; scores are float sums that can differ in the last digits between Node versions.
  if (o.data?.project?.key) o.data.project.key = String(o.data.project.key).toLowerCase();
  for (const h of o.data?.hits ?? []) h.score = Math.round(h.score * 1000) / 1000;
  return o;
}

describe('contract examples (contracts/api-v1/examples)', () => {
  const dir = join(__dirname, '..', '..', 'contracts', 'api-v1', 'examples');
  const update = process.env.UPDATE_CONTRACTS === '1';

  it('match what this Veto returns for the fixture machine', async () => {
    const found = (await call(['recall', 'search'], { project: PROJECT_A, query: 'deploy.ts key', limit: 2 })) as any;
    const examples: Record<string, unknown> = {
      'version.ok': await call(['version']),
      'snapshot.ok': await call(['snapshot'], { project: PROJECT_A }),
      'recall-search.ok': found,
      'recall-search.no_archive': await call(['recall', 'search'], { project: 'D:\\Nothing Here', query: 'x' }),
      'recall-expand.ok': await call(['recall', 'expand'], { project: PROJECT_A, event_id: found.data.hits[0].event_id }),
      'recall-expand.not_found': await call(['recall', 'expand'], { project: PROJECT_A, event_id: 'no-such-event' }),
      'snapshot.db_mismatch': await call(['snapshot'], { project: PROJECT_A, db: join(ROOT, 'elsewhere.db') }),
      'invalid_request': await call(['recall', 'search'], { query: 'x' }),
    };
    if (update) mkdirSync(dir, { recursive: true });
    for (const [name, env] of Object.entries(examples)) {
      const text = JSON.stringify(stable(env), null, 2) + '\n';
      const path = join(dir, `${name}.json`);
      if (update) writeFileSync(path, text);
      expect(existsSync(path), `${name}: run with UPDATE_CONTRACTS=1`).toBe(true);
      expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), `${name}: run with UPDATE_CONTRACTS=1`).toBe(text);
    }
  });

  it('each example is a valid envelope with valid data', () => {
    const dataSchema: Record<string, { parse: (x: unknown) => unknown }> = {
      version: contract.versionDataSchema, snapshot: contract.snapshotDataSchema,
      'recall-search': contract.recallSearchDataSchema, 'recall-expand': contract.recallExpandDataSchema,
    };
    for (const name of readdirSync(dir)) {
      const env = contract.envelopeSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      const schema = dataSchema[name.split('.')[0]];
      if (env.state === 'ok' && schema) schema.parse(env.data);
    }
  });
});

describe('published contract', () => {
  it('the committed JSON Schemas are exactly what the zod contract generates', async () => {
    const { contractJsonSchemas } = await import('../../src/api/json-schema.js');
    const dir = join(__dirname, '..', '..', 'contracts', 'api-v1');
    for (const [name, text] of Object.entries(contractJsonSchemas())) {
      const path = join(dir, `${name}.schema.json`);
      if (process.env.UPDATE_CONTRACTS === '1') writeFileSync(path, text);
      expect(existsSync(path), `${name}: run UPDATE_CONTRACTS=1 npx vitest run tests/api`).toBe(true);
      expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), `${name}: run UPDATE_CONTRACTS=1 npx vitest run tests/api`).toBe(text);
    }
  });
});
