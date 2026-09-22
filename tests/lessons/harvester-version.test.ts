import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER_RESOLVER_VERSION, HARVESTER_VERSION } from '../../src/lessons/harvest.js';

// Harvesting now skips a file whose bytes and project are what they were last
// time. That is only safe while "what this file yields" is a pure function of
// those inputs — so when the logic deciding it changes, HARVESTER_VERSION must
// change too, or every user keeps results produced by the old rules until they
// happen to edit a memory file.
//
// A comment asking for that would be missed. This fails instead.
//
// WHEN THIS TEST FAILS: decide whether your change alters what a file yields.
//   It does     -> bump HARVESTER_VERSION in src/lessons/harvest.ts, then
//                  paste the printed hash into LOGIC_HASH below.
//   It does not -> paste the printed hash into LOGIC_HASH below and move on.
// (harvest.ts itself is not hashed here: it holds the constant, and its own
// comment carries the same instruction.)

const SRC = join(__dirname, '..', '..', 'src', 'lessons');

function logicHash(): string {
  const files = [
    join(SRC, 'classify.ts'),
    join(SRC, 'mask.ts'),
    ...readdirSync(join(SRC, 'adapters')).sort().map(name => join(SRC, 'adapters', name)),
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  return hash.digest('hex');
}

const LOGIC_HASH = 'e317b5f88c026d8e32f389796b66cf9959f647e46a35e368b746194b04a43468';

describe('what a memory file yields', () => {
  it('has not changed without HARVESTER_VERSION changing with it', () => {
    expect(HARVESTER_VERSION).toBeGreaterThan(0);
    expect(logicHash(), `Classification, masking or an adapter changed.\n\nIf that changes what a file yields, bump HARVESTER_VERSION (currently ${HARVESTER_VERSION}) in src/lessons/harvest.ts.\nEither way, set LOGIC_HASH in this test to:\n\n  ${logicHash()}\n`).toBe(LOGIC_HASH);
  });
});

// The same bargain for folders: a save reuses which project a pass traced a
// Claude memory folder to, which is only safe while the tracing rules stand
// still. sourceProject itself lives in harvest.ts, under the same comment.
//
// WHEN THIS TEST FAILS: decide whether your change alters which project a
// folder resolves to, or with what label or names.
//   It does     -> bump FOLDER_RESOLVER_VERSION in src/lessons/harvest.ts, then
//                  paste the printed hash into RESOLVER_HASH below.
//   It does not -> paste the printed hash into RESOLVER_HASH below and move on.

function resolverHash(): string {
  const files = [
    join(SRC, 'source-project.ts'),
    join(SRC, 'identity.ts'),
    join(SRC, '..', 'transcripts', 'claude-paths.ts'),
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  return hash.digest('hex');
}

const RESOLVER_HASH = '182f358456c2a9f7549acf9d45eb4b81ff5a63556b351721e3e48bfb26e2f72a';

describe('which project a memory folder belongs to', () => {
  it('has not changed without FOLDER_RESOLVER_VERSION changing with it', () => {
    expect(FOLDER_RESOLVER_VERSION).toBeGreaterThan(0);
    expect(resolverHash(), `Folder resolution, project identity or the slug rules changed.\n\nIf that changes which project a folder resolves to, bump FOLDER_RESOLVER_VERSION (currently ${FOLDER_RESOLVER_VERSION}) in src/lessons/harvest.ts.\nEither way, set RESOLVER_HASH in this test to:\n\n  ${resolverHash()}\n`).toBe(RESOLVER_HASH);
  });
});
