import { normalizeMarkdown, parseMarkdownMemory } from './markdown.js';
import type { MemoryParseResult } from './types.js';

// An index line points at a sibling entry: `- [Title](entry.md) — hook`.
const INDEX_LINE_RE = /^\s*[-*]\s+\[[^\]]+\]\((?![a-z]+:)[^)]+\.md\)/i;

/**
 * Claude Code memory: one Markdown entry per file with YAML frontmatter
 * (`name`, `description`, `type` or `metadata.type`), and a MEMORY.md index
 * whose lines link to those entries. Claude loads the index natively and every
 * line in it repeats an entry, so an index is skipped; a MEMORY.md written as
 * plain notes (no entry links) is harvested like any other entry.
 */
export function parseClaudeMemory(raw: string, fileName = ''): MemoryParseResult {
  const base = fileName.replace(/\.md$/i, '');
  if (base.toUpperCase() === 'MEMORY' && normalizeMarkdown(raw).split('\n').some(line => INDEX_LINE_RE.test(line))) {
    return { ok: true, skip: 'index' };
  }
  return parseMarkdownMemory(raw, base);
}
