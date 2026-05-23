// Trims context before model calls to avoid wasting tokens
// Thresholds from VETO_VISION_FINAL.md:
//   < 2k tokens  → passthrough
//   2k-8k tokens → compress (drop irrelevant sections)
//   > 8k tokens  → hard-compress (tail + file references only)

export type CompressionStrategy = 'passthrough' | 'compress' | 'hard-compress';

export type CompressionResult = {
  original_tokens: number;
  compressed_tokens: number;
  compression_ratio: number;
  content: string;
  strategy: CompressionStrategy;
};

// Rough 4-chars-per-token estimate — good enough for routing decisions
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractRelevantSections(context: string, relevantFiles: string[]): string {
  if (relevantFiles.length === 0) return context;

  const lines = context.split('\n');
  const kept: string[] = [];
  let inRelevant = false;

  for (const line of lines) {
    const isHeader = /^(---|===|##|#)/.test(line.trim());
    if (isHeader) {
      inRelevant = relevantFiles.some((f) => line.includes(f));
    }
    if (inRelevant || relevantFiles.some((f) => line.includes(f))) {
      kept.push(line);
    }
  }

  return kept.length > 0 ? kept.join('\n') : context;
}

function hardCompress(context: string, relevantFiles: string[]): string {
  const lines = context.split('\n');
  const fileRefs = relevantFiles.length > 0
    ? lines.filter((l) => relevantFiles.some((f) => l.includes(f)))
    : [];
  const tail = lines.slice(-50);
  const combined = [...new Set([...fileRefs, ...tail])];
  return combined.join('\n');
}

export function compressContext(context: string, relevantFiles: string[] = [], platform: string = 'claude'): CompressionResult {
  const original_tokens = estimateTokens(context);
  let strategy: CompressionStrategy;
  let content: string;

  const budgets: Record<string, { passthrough: number, compress: number }> = {
    gemini: { passthrough: 900000, compress: 950000 },
    claude: { passthrough: 180000, compress: 190000 },
    codex:  { passthrough: 100000, compress: 110000 }
  };

  const limits = budgets[platform] || budgets.claude;

  if (original_tokens < limits.passthrough) {
    strategy = 'passthrough';
    content = context;
  } else if (original_tokens < limits.compress) {
    strategy = 'compress';
    content = extractRelevantSections(context, relevantFiles);
  } else {
    strategy = 'hard-compress';
    content = hardCompress(context, relevantFiles);
  }

  const compressed_tokens = estimateTokens(content);
  const compression_ratio = original_tokens > 0
    ? Math.round((1 - compressed_tokens / original_tokens) * 100) / 100
    : 0;

  return { original_tokens, compressed_tokens, compression_ratio, content, strategy };
}
