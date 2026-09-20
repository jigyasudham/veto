import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARVESTER_VERSION } from '../../src/lessons/harvest.js';

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
