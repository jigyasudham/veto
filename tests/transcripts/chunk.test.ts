import { describe, it, expect } from 'vitest';
import {
  chunkText, CHUNKER_VERSION, WINDOW_CHARS, STRIDE_CHARS, MAX_WINDOWS_PER_EVENT,
} from '../../src/transcripts/chunk.js';

describe('chunkText — boundaries (C1: pinned, bump CHUNKER_VERSION to change)', () => {
  it('emits nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('emits exactly one chunk for text at or under the window', () => {
    const short = 'a'.repeat(WINDOW_CHARS - 1);
    expect(chunkText(short)).toEqual([{ index: 0, start: 0, end: short.length, text: short }]);

    const exact = 'b'.repeat(WINDOW_CHARS);
    const [only] = chunkText(exact);
    expect(chunkText(exact)).toHaveLength(1);
    expect(only.text).toBe(exact);
  });

  // The median event is ~205 chars, so this is the common path: chunking must
  // not multiply rows for events that were never diluted in the first place.
  it('does not split a median-sized event', () => {
    expect(chunkText('x'.repeat(205))).toHaveLength(1);
  });

  it('pins exact boundaries for a text just over the window', () => {
    const text = 'c'.repeat(WINDOW_CHARS + 1);
    expect(chunkText(text).map(({ index, start, end }) => ({ index, start, end }))).toEqual([
      { index: 0, start: 0, end: 240 },
      { index: 1, start: 120, end: 241 },
    ]);
  });

  it('pins exact boundaries for a multi-window text', () => {
    const text = 'd'.repeat(600);
    expect(chunkText(text).map(({ index, start, end }) => ({ index, start, end }))).toEqual([
      { index: 0, start: 0, end: 240 },
      { index: 1, start: 120, end: 360 },
      { index: 2, start: 240, end: 480 },
      { index: 3, start: 360, end: 600 },
    ]);
  });

  it('overlaps by exactly one stride so a sentence cannot fall between windows', () => {
    const chunks = chunkText('e'.repeat(1000));
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].start).toBe(chunks[i - 1].start + STRIDE_CHARS);
      expect(chunks[i].start).toBeLessThan(chunks[i - 1].end);
    }
  });

  it('covers the tail exactly once, without a zero-length window', () => {
    for (const len of [241, 359, 360, 361, 725, 1000]) {
      const chunks = chunkText('f'.repeat(len));
      expect(chunks.at(-1)!.end).toBe(len);
      for (const c of chunks) expect(c.end).toBeGreaterThan(c.start);
    }
  });

  it('slices are consistent with their own offsets', () => {
    const text = 'The quick brown fox. '.repeat(60);
    for (const c of chunkText(text)) expect(c.text).toBe(text.slice(c.start, c.end));
  });
});

describe('chunkText — guards', () => {
  it('caps windows per event and drops the tail (C2: a guard, not a knob)', () => {
    const huge = 'g'.repeat(STRIDE_CHARS * (MAX_WINDOWS_PER_EVENT + 50));
    const chunks = chunkText(huge);
    expect(chunks).toHaveLength(MAX_WINDOWS_PER_EVENT);
    expect(chunks.at(-1)!.end).toBeLessThan(huge.length);
  });

  it('never splits a surrogate pair', () => {
    // Astral chars only: every boundary lands mid-pair unless it is adjusted.
    const text = '\u{1F600}'.repeat(400);
    for (const c of chunkText(text)) {
      expect(c.text).toBe(text.slice(c.start, c.end));
      // A lone surrogate would survive slicing but break normalization.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.text)).toBe(false);
    }
  });

  it('declares a version, so stored vectors can be invalidated', () => {
    expect(CHUNKER_VERSION).toBeGreaterThanOrEqual(1);
  });
});
