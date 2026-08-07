import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/transcripts/tokenize.js';

describe('tokenize — basics', () => {
  it('lowercases and splits on non-identifier chars', () => {
    expect(tokenize('Hello, World!', false)).toEqual(['hello', 'world']);
  });

  it('keeps identifiers, paths, versions, and error codes intact as whole tokens', () => {
    expect(tokenize('E404', false)).toEqual(['e404']);
    expect(tokenize('npm@10.2.3', false)).toEqual(['npm@10.2.3']);
    expect(tokenize('src/transcripts/search.ts', false)).toEqual(['src/transcripts/search.ts']);
  });

  it('does not stem: publishing and published stay distinct', () => {
    expect(tokenize('publishing', false)).toEqual(['publishing']);
    expect(tokenize('published', false)).toEqual(['published']);
  });
});

describe('tokenize — sub-token expansion', () => {
  it('splits camelCase into sub-tokens plus the whole', () => {
    expect(tokenize('normalizeProjectDir')).toEqual(
      ['normalizeprojectdir', 'normalize', 'project', 'dir'],
    );
  });

  it('splits paths into path segments plus the whole', () => {
    expect(tokenize('src/transcripts/search.ts')).toEqual(
      ['src/transcripts/search.ts', 'src', 'transcripts', 'search', 'ts'],
    );
  });

  it('emits no duplicate of a token that has no compound structure', () => {
    expect(tokenize('publish')).toEqual(['publish']);
    expect(tokenize('e404')).toEqual(['e404']);
  });

  it('is off when the flag is false', () => {
    expect(tokenize('normalizeProjectDir', false)).toEqual(['normalizeprojectdir']);
  });
});

describe('tokenize — blob rejection', () => {
  it('drops tokens longer than 64 chars', () => {
    expect(tokenize('a'.repeat(65), false)).toEqual([]);
  });

  it('drops long pure-hex runs (masked-secret residue)', () => {
    expect(tokenize('deadbeef'.repeat(8), false)).toEqual([]);
    // …but short hex-ish identifiers survive
    expect(tokenize('deadbeef', false)).toEqual(['deadbeef']);
  });

  it('drops base64-looking data but keeps long camelCase identifiers', () => {
    expect(tokenize('QWxhZGRpbjpvcGVuIHNlc2FtZQ12345+/==', false)).toEqual([]);
    expect(tokenize('VeryLongCamelCaseIdentifierNameThatKeepsGoing', false)).toEqual(
      ['verylongcamelcaseidentifiernamethatkeepsgoing'],
    );
  });

  it('drops pure punctuation runs', () => {
    expect(tokenize('--- ... ///', false)).toEqual([]);
  });
});

describe('tokenize — index/query symmetry (the property FTS5 broke)', () => {
  // For any text: every token the indexer emits, when fed back as a QUERY,
  // must tokenize to tokens that are all present in the indexed token set —
  // i.e. searching for anything the index contains always matches.
  const samples = [
    'we hit an npm E404 error on publish',
    'normalizeProjectDir(src/memory/local.ts) failed with ENOENT',
    'run `veto transcripts enable` then check %LOCALAPPDATA%\\veto',
    'REDACTED[sha256:1a2b3c4d] leaked into tests/transcripts/mask.test.ts',
    'mixed:  paths\\like\\windows and unix/like/paths and versions v2.9.0',
    'Unicode überstraße Ω tokens gemischt with ASCII',
    'gh pr create --base main --head release/2.9.0 --title chore(release)',
  ];

  it('holds for every sample, with and without sub-tokens', () => {
    for (const subtokens of [true, false]) {
      for (const text of samples) {
        const indexed = new Set(tokenize(text, subtokens));
        for (const tok of indexed) {
          for (const q of tokenize(tok, subtokens)) {
            expect(indexed, `query token "${q}" from "${tok}" in: ${text}`).toContain(q);
          }
        }
      }
    }
  });

  it('holds for pseudo-random identifier soup', () => {
    // Deterministic PRNG (mulberry32) — reproducible without a fuzz dep.
    let s = 0xC0FFEE;
    const rnd = () => {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pieces = ['foo', 'Bar', 'BAZ', 'e404', '2.9.0', 'src', 'ts', 'npm', 'x'];
    const glue = ['', '_', '-', '.', '/', '@', '+', ' ', ', ', '::'];
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rnd() * 8);
      let text = '';
      for (let j = 0; j < n; j++) {
        text += pieces[Math.floor(rnd() * pieces.length)] + glue[Math.floor(rnd() * glue.length)];
      }
      const indexed = new Set(tokenize(text));
      for (const tok of indexed) {
        for (const q of tokenize(tok)) {
          expect(indexed, `query token "${q}" from "${tok}" in: ${text}`).toContain(q);
        }
      }
    }
  });
});
