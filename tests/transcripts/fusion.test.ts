import { describe, it, expect } from 'vitest';
import { rrfWeight, fuseByRank } from '../../src/transcripts/search.js';

// The first held-out evaluation failed on exactly one shape: a target found by
// the semantic ranker alone (rank 10) and by BM25 not at all was DEMOTED by
// fusion to rank 28. The cause was arithmetic, not retrieval — RRF's k=60 at
// candidate depth 50 flattens the ranking until agreement beats quality.
//
// This is asserted on the arithmetic rather than through search because the
// failing shape is not reliably constructible in an integration test: with a
// bag-of-words embedding model, a document sharing a query's words is
// necessarily a semantic match too.

const OLD_K = 60;
const oldWeight = (rank0: number) => 1 / (OLD_K + rank0 + 1);

describe('RRF weighting', () => {
  it('lets a top single-ranker find beat two mid-list agreements', () => {
    const soleTop = rrfWeight(0);
    const bothMid = rrfWeight(24) + rrfWeight(24);
    expect(soleTop).toBeGreaterThan(bothMid);
  });

  it('is the exact property the previous constant violated', () => {
    // Documents the regression: k=60 inverted this comparison, which is how a
    // semantic-only discovery lost to keyword-adjacent noise.
    expect(oldWeight(0)).toBeLessThan(oldWeight(24) + oldWeight(24));
  });

  it('satisfies k < depth/2 - 2, the bound that makes the above hold', () => {
    // Solve 1/(k+1) > 2/(k+d/2) for d = 50 -> k < 23.
    const impliedK = 1 / rrfWeight(0) - 1;
    expect(impliedK).toBeLessThan(50 / 2 - 2);
  });

  it('keeps rank information rather than flattening it', () => {
    // k=60 compressed rank 1..50 into a 1.8x spread; ranks stopped mattering.
    expect(rrfWeight(0) / rrfWeight(49)).toBeGreaterThan(4);
    expect(oldWeight(0) / oldWeight(49)).toBeLessThan(2);
  });
});

describe('fuseByRank', () => {
  it('still rewards agreement — a doc both rankers like beats a single top find', () => {
    // Not a regression: agreement IS signal. A doc at rank 1 and 2 across the
    // two rankers should outrank a doc only one ranker saw at rank 1.
    const fused = fuseByRank([['agreed', 'x'], ['solo', 'agreed']]);
    expect(fused[0].id).toBe('agreed');
  });

  it('beats mid-list agreement with a single strong find', () => {
    const bm25 = [...Array.from({ length: 24 }, (_, i) => `lex-${i}`), 'agreed'];
    const semantic = ['target', ...Array.from({ length: 23 }, (_, i) => `sem-${i}`), 'agreed'];
    const fused = fuseByRank([bm25, semantic]);
    expect(fused.findIndex(f => f.id === 'target'))
      .toBeLessThan(fused.findIndex(f => f.id === 'agreed'));
  });

  it('cannot lift a single-ranker find above a better-ranked head from the other list', () => {
    // Documents a LIMIT, not a bug, and corrects an earlier misdiagnosis.
    // When no document appears in both lists, every item has exactly one
    // contribution, so k rescales without reordering: the constant is
    // irrelevant here. A target at semantic rank 10 sits below 9 better
    // semantic hits AND BM25's better-ranked head no matter what k is.
    //
    // Consequence: a target the semantic ranker itself only places 10th
    // cannot reach a fused top-10. That is a retrieval-quality problem, and
    // no fusion constant fixes it.
    const bm25 = Array.from({ length: 50 }, (_, i) => `lex-${i}`);
    const semantic = [...Array.from({ length: 9 }, (_, i) => `sem-${i}`), 'target'];

    const rankUnder = (k: number) => {
      const acc = new Map<string, number>();
      for (const list of [bm25, semantic]) {
        list.forEach((id, i) => acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1)));
      }
      return [...acc.entries()].sort((a, b) => b[1] - a[1]).findIndex(([id]) => id === 'target');
    };

    expect(rankUnder(10)).toBe(rankUnder(60));
    expect(fuseByRank([bm25, semantic]).findIndex(f => f.id === 'target')).toBe(rankUnder(10));
  });
});
