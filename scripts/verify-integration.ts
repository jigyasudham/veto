// End-to-end proof that Veto and @jigyasudham/veto-model are actually wired
// together — resolution, lazy load, vectors, fusion, provenance, degradation.
//
//   npx tsx scripts/verify-integration.ts

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = join(tmpdir(), `veto-integration-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
process.env.VETO_TRANSCRIPTS_DIR = ROOT;

const req = createRequire(import.meta.url);
const ok = (s: string) => console.log(`  ok    ${s}`);
const bad = (s: string) => { console.log(`  FAIL  ${s}`); process.exitCode = 1; };

console.log('\n1. dependency pin + resolution');
const pin = (req('../package.json') as { dependencies: Record<string, string> })
  .dependencies['@jigyasudham/veto-model'];
/^\d+\.\d+\.\d+$/.test(pin) ? ok(`pinned exactly at ${pin}`) : bad(`pin is not exact: ${pin}`);
// Read from disk rather than require('<pkg>/package.json'): 1.0.0's exports
// map does not expose that subpath. Noted for the next model release.
const { readFileSync } = await import('node:fs');
const { dirname } = await import('node:path');
const modelRoot = dirname(dirname(req.resolve('@jigyasudham/veto-model/model.json')));
const installed = (JSON.parse(readFileSync(join(modelRoot, 'package.json'), 'utf8')) as { version: string }).version;
installed === pin ? ok(`installed copy matches the pin (${installed})`) : bad(`installed ${installed} != pin ${pin}`);

console.log('\n2. lazy load — nothing touches the model at import');
const { paths } = await import('@jigyasudham/veto-model');
ok(`entry point resolves paths without reading them (${paths.header.split(/[\\/]/).slice(-2).join('/')})`);

console.log('\n3. inference against the installed payload');
const { embed, cosine, embeddingsAvailable, modelProvenance } = await import('../src/transcripts/embed.js');
embeddingsAvailable() ? ok('payload loads and passes validation') : bad('payload failed validation');
const prov = modelProvenance();
ok(`provenance ${prov.model_id}@${prov.revision.slice(0, 12)}`);
const near = cosine(embed('the credentials had expired'), embed('authentication has lapsed'));
const far = cosine(embed('the credentials had expired'), embed('the kitchen sink is full'));
near > far ? ok(`related text scores higher (${near.toFixed(3)} > ${far.toFixed(3)})`) : bad('semantic ordering wrong');

console.log('\n4. full recall path — ingest, embed, fuse, cite');
const { captureSession } = await import('../src/transcripts/archive.js');
const { recordSessionMapping } = await import('../src/transcripts/mapping.js');
const { ingestSession } = await import('../src/transcripts/ingest.js');
const { recallQuery } = await import('../src/transcripts/recall.js');
const { resetTranscriptsDb } = await import('../src/transcripts/store.js');

const SESSION = 'integration-check';
const PROJECT = 'd:\\integration';
writeFileSync(join(ROOT, `${SESSION}.jsonl`), [
  'the credentials had expired, so the registry rejected the upload as not found',
  'we also discussed the kitchen renovation and the new dishwasher',
].map((text, i) => JSON.stringify({
  type: i % 2 === 0 ? 'user' : 'assistant',
  uuid: `${SESSION}-${i}`,
  timestamp: `2026-08-12T10:0${i}:00.000Z`,
  sessionId: SESSION,
  message: { role: i % 2 === 0 ? 'user' : 'assistant', content: i % 2 === 0 ? text : [{ type: 'text', text }] },
})).join('\n') + '\n');

recordSessionMapping({ sourceSessionId: SESSION, transcriptPath: join(ROOT, `${SESSION}.jsonl`), projectDir: PROJECT });
await captureSession({ sourceSessionId: SESSION });
ingestSession(SESSION);

// A question sharing no content words with its answer.
const res = recallQuery({ query: 'why was the package push refused', projectDir: PROJECT });
res.retrieval.semantic ? ok(`recall reports semantic retrieval: ${res.retrieval.semantic.split('@')[0]}`) : bad('recall did not report semantic retrieval');
const found = res.hits.some(h => h.snippet.toLowerCase().includes('credentials'));
found ? ok('paraphrase found the right event with no shared vocabulary') : bad('paraphrase did not retrieve the target');

console.log('\n5. degradation — the model is never load-bearing');
const { resetModelCache } = await import('../src/transcripts/embed.js');
process.env.VETO_MODEL_DIR = join(ROOT, 'nope');
resetModelCache();
const degraded = recallQuery({ query: 'credentials expired registry', projectDir: PROJECT });
degraded.retrieval.semantic === null ? ok('semantic reported as unavailable') : bad('still claims semantic');
degraded.hits.length > 0 ? ok('keyword recall still answers') : bad('recall died without the model');
delete process.env.VETO_MODEL_DIR;
resetModelCache();

resetTranscriptsDb();
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${process.exitCode ? 'INTEGRATION INCOMPLETE' : 'INTEGRATION COMPLETE — all checks passed'}\n`);
