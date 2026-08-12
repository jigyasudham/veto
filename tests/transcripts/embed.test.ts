import { describe, it, expect } from 'vitest';

// The model ships as a separate npm package, so these tests run against the
// RESOLVED dependency (condition A4) — never a repo copy, so the published
// artifact cannot drift from what CI blessed. Before that package is
// published, point VETO_MODEL_DIR at a local build to run them.
const { embed, cosine, tokenizeForEmbedding, embeddingsAvailable, modelProvenance } =
  await import('../../src/transcripts/embed.js');

const available = embeddingsAvailable();
const withModel = available ? describe : describe.skip;

if (!available) {
  // Loud but non-fatal: a missing model must never fail the suite for someone
  // who has not installed it, but it must not look like a pass either.
  console.warn('[embed.test] model package not resolvable — golden vectors SKIPPED. ' +
    'Set VETO_MODEL_DIR to a built package root to run them.');
}

type Golden = {
  model_revision: string;
  vectors: { text: string; token_ids: number[]; expected: number[] }[];
};

const { createRequire } = await import('node:module');
const { readFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');

// Resolved at collection time, so it must not throw when the package is
// absent: vitest still evaluates a skipped describe's body.
function loadGolden(): Golden | null {
  try {
    const dir = process.env.VETO_MODEL_DIR
      ? join(process.env.VETO_MODEL_DIR, 'model')
      : dirname(createRequire(import.meta.url).resolve('@jigyasudham/veto-model/model.json'));
    return JSON.parse(readFileSync(join(dir, 'golden.json'), 'utf8')) as Golden;
  } catch {
    return null;
  }
}

withModel('embed — golden vectors', () => {
  const golden = loadGolden()!;

  it('ships golden vectors for the pinned revision', () => {
    expect(golden.vectors.length).toBeGreaterThan(0);
    expect(modelProvenance().revision).toBe(golden.model_revision);
  });

  // Tokenization is where a hand-port silently diverges, so it is asserted
  // separately from the arithmetic: an id mismatch localizes the bug to the
  // normalizer/pre-tokenizer/WordPiece chain rather than to pooling.
  it('reproduces upstream token ids exactly', () => {
    for (const g of golden.vectors) {
      expect(tokenizeForEmbedding(g.text), `ids for ${JSON.stringify(g.text)}`).toEqual(g.token_ids);
    }
  });

  it('reproduces golden vectors within the 1e-3 gate', () => {
    let worst = 0;
    for (const g of golden.vectors) {
      const got = embed(g.text);
      expect(got.length).toBe(g.expected.length);
      for (let i = 0; i < got.length; i++) {
        worst = Math.max(worst, Math.abs(got[i]! - g.expected[i]!));
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });
});

withModel('embed — contract', () => {
  it('returns a zero vector for text with no tokens', () => {
    const v = embed('');
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('returns unit-length vectors for real text', () => {
    const v = embed('the npm publish failed');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  // `strip_accents: null` follows `lowercase`, so accents ARE stripped. If a
  // future payload flips that, this is the test that catches it.
  it('strips accents and folds case', () => {
    expect(tokenizeForEmbedding('café')).toEqual(tokenizeForEmbedding('cafe'));
    expect(tokenizeForEmbedding('Hello')).toEqual(tokenizeForEmbedding('hello'));
    expect(cosine(embed('café'), embed('cafe'))).toBeCloseTo(1, 6);
  });

  it('isolates punctuation instead of dropping it', () => {
    expect(tokenizeForEmbedding('a,b').length).toBe(3);
  });

  it('ranks a paraphrase above an unrelated sentence', () => {
    const q = embed('the credentials expired so the upload was rejected');
    const near = embed('authentication had lapsed and the publish was refused');
    const far = embed('the kitchen sink is full of dishes');
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });
});
