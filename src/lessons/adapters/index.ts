import { parseClaudeMemory } from './claude.js';
import { parseCodexMemory } from './codex.js';
import { parseGeminiMemory } from './gemini.js';
import type { LessonSource, MemoryParseResult } from './types.js';

export type { LessonSource, MemoryFrontmatter, MemoryParseResult, MemorySection } from './types.js';
export { LESSON_SOURCES } from './types.js';

const PARSERS: Record<LessonSource, (raw: string, fileName: string) => MemoryParseResult> = {
  claude: parseClaudeMemory,
  codex: parseCodexMemory,
  gemini: parseGeminiMemory,
};

/** Parse one native-memory document using its host-specific adapter. */
export function parseNativeMemory(source: LessonSource, raw: string, fileName = ''): MemoryParseResult {
  return PARSERS[source](raw, fileName);
}
