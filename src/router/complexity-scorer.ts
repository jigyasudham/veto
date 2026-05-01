// Scores a task description 0-100 locally — zero tokens spent

export type ComplexityFactors = {
  word_count_score: number;
  keyword_score: number;
  depth_score: number;
  files_score: number;
  council_bonus: number;
};

export type ComplexityResult = {
  score: number;
  tier: 1 | 2 | 3;
  factors: ComplexityFactors;
  council_required: boolean;
};

// 5 pts each — strong signal of high complexity
const HIGH_KEYWORDS = [
  'architecture', 'security', 'authenticat', 'authorizat', 'migrat',
  'refactor', 'scalab', 'concurrent', 'distributed', 'oauth', 'jwt',
  'rbac', 'encryption', 'cryptograph', 'penetration', 'vulnerabilit',
  'infrastructure', 'compliance', 'performance',
];

// 2 pts each — moderate complexity signal
const MEDIUM_KEYWORDS = [
  'component', 'function', 'test', 'api', 'database', 'query', 'schema',
  'deploy', 'docker', 'implement', 'build', 'feature', 'module',
  'service', 'endpoint', 'integration', 'configuration',
];

// Council is always required for these topics
const COUNCIL_TRIGGERS = [
  'architecture', 'security', 'auth', 'migrat', 'vulnerabilit',
  'encryption', 'infrastructure', 'breaking change', 'drop table',
  'delete all', 'remove all',
];

export function scoreComplexity(
  task: string,
  filesAffected = 1,
  forceCouncil = false
): ComplexityResult {
  const lower = task.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  // Factor 1: word count → 0-20 pts (1 pt per 3 words, cap 20)
  const word_count_score = Math.min(20, Math.floor(words.length / 3));

  // Factor 2: technical keywords → 0-30 pts
  let keyword_score = 0;
  let council_required = forceCouncil;

  for (const word of words) {
    for (const kw of HIGH_KEYWORDS) {
      if (word.includes(kw)) { keyword_score += 5; break; }
    }
    for (const kw of MEDIUM_KEYWORDS) {
      if (word.includes(kw)) { keyword_score += 2; break; }
    }
  }
  for (const trigger of COUNCIL_TRIGGERS) {
    if (lower.includes(trigger)) { council_required = true; break; }
  }
  keyword_score = Math.min(30, keyword_score);

  // Factor 3: task depth → 0-20 pts (conjunctions, length, multi-step)
  let depth_score = 0;
  if (lower.includes(' and ') || lower.includes(' with ')) depth_score += 5;
  if (lower.includes(',') || lower.includes(' plus '))     depth_score += 5;
  if (words.length > 20) depth_score += 5;
  if (words.length > 40) depth_score += 5;
  depth_score = Math.min(20, depth_score);

  // Factor 4: files affected → 0-20 pts
  const files_score = Math.min(20, (filesAffected - 1) * 3);

  // Factor 5: council bonus — pushes score into Tier 3 territory
  const council_bonus = council_required ? 10 : 0;

  const raw = word_count_score + keyword_score + depth_score + files_score + council_bonus;
  // Council tasks always land in Tier 3 — floor at 71
  const score = Math.min(100, council_required ? Math.max(71, raw) : raw);
  const tier: 1 | 2 | 3 = score <= 30 ? 1 : score <= 70 ? 2 : 3;

  return {
    score,
    tier,
    factors: { word_count_score, keyword_score, depth_score, files_score, council_bonus },
    council_required,
  };
}
