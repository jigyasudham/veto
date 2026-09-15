export const LESSON_SOURCES = ['claude', 'codex', 'gemini'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export type MemorySection = {
  anchor: string;
  /** Heading, or the entry's frontmatter description/name for body text. */
  title: string;
  /** Title and body as one note; this is what gets masked and stored. */
  text: string;
};

export type MemoryFrontmatter = {
  name?: string;
  description?: string;
  /** Claude memory type: user | feedback | project | reference. */
  type?: string;
};

export type MemoryParseResult =
  | { ok: true; frontmatter: MemoryFrontmatter; sections: MemorySection[] }
  // A document that is well-formed but carries nothing to harvest: an empty
  // file, a MEMORY.md index, or a guide Veto itself wrote.
  | { ok: true; skip: 'empty' | 'index' | 'veto-authored' }
  // Format drift: the adapter no longer recognises the host's shape.
  | { ok: false; reason: string };
