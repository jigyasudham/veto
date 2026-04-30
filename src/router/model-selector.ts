// Assigns Tier 1/2/3 and specific model recommendations
// Some agents are permanently locked to a tier regardless of complexity score

export type AgentType =
  // Tier 3 locked — stakes too high
  | 'lead-developer' | 'system-architect' | 'security-scanner'
  | 'devil-advocate' | 'decision-engine' | 'risk-assessor'
  // Tier 2 locked — balanced complexity
  | 'coder' | 'tester' | 'reviewer' | 'database' | 'documentation'
  // Tier 1 locked — simple/structured operations
  | 'file-manager' | 'git-agent' | 'search-agent' | 'secrets' | 'reporter'
  // Dynamic — complexity score decides
  | 'dynamic';

export type Tier = 1 | 2 | 3;

export type ModelRecommendation = {
  tier: Tier;
  models: { claude: string; gemini: string; codex: string };
  reason: string;
  agent_locked: boolean;
};

const TIER3_LOCKED = new Set<AgentType>([
  'lead-developer', 'system-architect', 'security-scanner',
  'devil-advocate', 'decision-engine', 'risk-assessor',
]);

const TIER2_LOCKED = new Set<AgentType>([
  'coder', 'tester', 'reviewer', 'database', 'documentation',
]);

const TIER1_LOCKED = new Set<AgentType>([
  'file-manager', 'git-agent', 'search-agent', 'secrets', 'reporter',
]);

const TIER_MODELS: Record<Tier, { claude: string; gemini: string; codex: string }> = {
  1: { claude: 'claude-haiku-4-5', gemini: 'gemini-2.0-flash', codex: 'gpt-4o-mini' },
  2: { claude: 'claude-sonnet-4-6', gemini: 'gemini-2.0-pro', codex: 'gpt-4o' },
  3: { claude: 'claude-sonnet-4-6', gemini: 'gemini-2.0-advanced', codex: 'gpt-4o' },
};

export function selectModel(
  complexityScore: number,
  agentType: AgentType = 'dynamic'
): ModelRecommendation {
  if (TIER3_LOCKED.has(agentType)) {
    return {
      tier: 3,
      models: TIER_MODELS[3],
      reason: `${agentType} is always Tier 3 — stakes too high for cheaper models`,
      agent_locked: true,
    };
  }

  if (TIER2_LOCKED.has(agentType)) {
    return {
      tier: 2,
      models: TIER_MODELS[2],
      reason: `${agentType} is always Tier 2 — balanced complexity`,
      agent_locked: true,
    };
  }

  if (TIER1_LOCKED.has(agentType)) {
    return {
      tier: 1,
      models: TIER_MODELS[1],
      reason: `${agentType} is always Tier 1 — simple structured operations`,
      agent_locked: true,
    };
  }

  const tier: Tier = complexityScore <= 30 ? 1 : complexityScore <= 70 ? 2 : 3;
  const reason =
    tier === 1
      ? `Score ${complexityScore}/100 — simple task, use fastest/cheapest model`
      : tier === 2
        ? `Score ${complexityScore}/100 — mid-range task, use balanced model`
        : `Score ${complexityScore}/100 — complex task, use best available model`;

  return { tier, models: TIER_MODELS[tier], reason, agent_locked: false };
}
