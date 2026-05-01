// Skill: pattern-detect — find repeated patterns and anti-patterns in a codebase

export interface SkillInput { task: string; context?: string; options?: Record<string, unknown>; }
export interface SkillOutput { skill: string; checklist: string[]; patterns: string[]; gotchas: string[]; resources: string[]; }

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'pattern-detect',
    checklist: [
      'Call veto_patterns_list to load all stored coding patterns before scanning',
      'Scan the 5 most recently modified files for structural patterns (not style — structure)',
      'Look for: repeated try/catch shapes, recurring if/else chains, duplicated utility logic',
      'Look for anti-patterns: N+1 loops, empty catch blocks, hardcoded magic strings/numbers',
      'Compare found patterns against stored patterns — update confidence via veto_pattern_store',
      'New patterns not yet stored: add via veto_pattern_store with a category.name key format',
      'Anti-patterns found: flag them via veto_memory_store (type="pattern", title="Anti-pattern: X")',
      'After scanning: call veto_agent_plan with agent="pattern-learner" for deeper style analysis',
    ],
    patterns: [
      'Structure over style: detect structural patterns (how code is organised) not style (how it is formatted)',
      'Frequency threshold: a pattern seen in 3+ files is established; seen in 1–2 files is tentative',
      'Anti-pattern distinction: store anti-patterns separately with "Anti-pattern:" title prefix',
      'Confidence accumulation: every confirmed observation of a pattern increments its confidence score',
    ],
    gotchas: [
      'Detecting style instead of structure — style is enforced by a linter; pattern detection adds no value there',
      'Flagging intentional deviations as anti-patterns — some files deliberately break the pattern (e.g. test fixtures)',
      'Not updating stored patterns when the codebase evolves — stale patterns mislead future agents',
      'Storing too-specific patterns ("function X uses this exact shape") vs. too-generic ("uses functions")',
    ],
    resources: [
      'veto_patterns_list — list all stored patterns with confidence scores',
      'veto_pattern_store — add or update a pattern',
      'veto_memory_store (type="pattern") — store anti-patterns and architectural patterns',
      'veto_agent_plan with agent="pattern-learner" — deeper coding style analysis',
    ],
  };
}
