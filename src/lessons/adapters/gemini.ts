import { createHash } from 'node:crypto';
import { parseMarkdownMemory } from './markdown.js';
import type { MemoryParseResult, MemorySection } from './types.js';

// Gemini CLI's save_memory tool appends `- <fact>` lines under this heading in
// ~/.gemini/GEMINI.md; the rest of the file is the user's own instructions.
export const GEMINI_MEMORY_HEADING = 'Gemini Added Memories';

/**
 * One saved fact per section. Anchors hash the fact rather than count bullets,
 * so inserting a memory does not re-key every memory after it.
 */
function splitSavedMemories(section: MemorySection): MemorySection[] {
  const facts: string[] = [];
  const rest: string[] = [];
  for (const line of section.text.split('\n').slice(1)) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) facts.push(bullet[1].trim());
    else if (/^\s+\S/.test(line) && facts.length) facts[facts.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) rest.push(line);
  }
  const seen = new Set<string>();
  const out: MemorySection[] = [];
  for (const fact of facts) {
    const anchor = `${section.anchor}-${createHash('sha256').update(fact).digest('hex').slice(0, 8)}`;
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    out.push({ anchor, title: section.title, text: fact });
  }
  if (rest.length) out.push({ ...section, text: `${section.title}\n${rest.join('\n')}` });
  return out;
}

export function parseGeminiMemory(raw: string, fileName = ''): MemoryParseResult {
  const parsed = parseMarkdownMemory(raw, fileName || 'GEMINI.md');
  if (!parsed.ok || 'skip' in parsed) return parsed;
  return {
    ...parsed,
    sections: parsed.sections.flatMap(section =>
      section.title === GEMINI_MEMORY_HEADING ? splitSavedMemories(section) : [section]),
  };
}
