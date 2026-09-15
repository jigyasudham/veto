import { parseMarkdownMemory } from './markdown.js';
import type { MemoryParseResult } from './types.js';

/**
 * Codex CLI: the user's global instructions, ~/.codex/AGENTS.md or its
 * AGENTS.override.md replacement. Plain Markdown, often without headings.
 */
export function parseCodexMemory(raw: string, fileName = ''): MemoryParseResult {
  return parseMarkdownMemory(raw, fileName || 'AGENTS.md');
}
