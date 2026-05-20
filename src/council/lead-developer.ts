// Lead Developer — code quality, security, no shortcuts
import type { AgentVote } from './types.js';
import { extractDecision, pickSide, reframeVote } from './decision-extractor.js';

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /\bmd5\b/i,
    reason: 'MD5 is cryptographically broken since 2008. Rainbow tables crack it instantly.',
    recommendation: 'Use bcrypt (cost 12) for passwords. Use SHA-256 for checksums only.',
  },
  {
    pattern: /\bsha-?1\b/i,
    reason: 'SHA-1 collision attacks are practical since 2017. Deprecated for all security use.',
    recommendation: 'Use SHA-256 or SHA-3. For passwords use bcrypt/argon2.',
  },
  {
    pattern: /\b(des|3des|triple.?des)\b/i,
    reason: 'DES/3DES is broken. Brute-forceable in hours.',
    recommendation: 'Use AES-256-GCM for symmetric encryption.',
  },
  {
    pattern: /\brc4\b/i,
    reason: 'RC4 is broken — biased keystream, practical attacks exist.',
    recommendation: 'Use ChaCha20-Poly1305 or AES-256-GCM.',
  },
  {
    pattern: /\beval\s*\(/i,
    reason: 'eval() enables arbitrary code execution from user input.',
    recommendation: 'Remove eval(). Use JSON.parse() for data, redesign for logic.',
  },
  {
    pattern: /\bnew\s+Function\s*\(/i,
    reason: 'new Function() is eval() in disguise. Same arbitrary execution risk.',
    recommendation: 'Never construct functions from strings. Redesign the logic.',
  },
  {
    pattern: /hardcod.{0,20}(password|secret|key|token|credential)/i,
    reason: 'Hardcoded credentials ship to version control and get leaked.',
    recommendation: 'Move to environment variables. Use dotenv locally, vault in prod.',
  },
  {
    pattern: /(password|secret|api.?key|token).{0,20}hardcod/i,
    reason: 'Hardcoded credentials in source is a critical vulnerability.',
    recommendation: 'Use process.env.VAR_NAME. Never commit secrets.',
  },
  {
    pattern: /disable.{0,15}(ssl|tls|cert(?:ificate)?(?:.?verif)?)/i,
    reason: 'Disabling SSL/TLS validation exposes all traffic to MITM attacks.',
    recommendation: 'Fix the certificate properly. Never disable validation in production.',
  },
  {
    pattern: /cors.{0,15}['"]\s*\*\s*['"]/i,
    reason: 'CORS wildcard (*) allows any origin to read API responses.',
    recommendation: 'Specify exact allowed origins: ["https://yourdomain.com"].',
  },
  {
    pattern: /innerHTML\s*=\s*.*(req\b|input\b|param|user|body)/i,
    reason: 'Setting innerHTML from user data enables stored XSS attacks.',
    recommendation: 'Use textContent for text. Sanitize with DOMPurify if HTML is needed.',
  },
  {
    pattern: /no.{0,10}input.{0,10}(valid|sanitiz)/i,
    reason: 'Explicitly skipping input validation is the root cause of most injections.',
    recommendation: 'Validate all external input at the boundary with zod/joi schemas.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string }> = [
  { pattern: /\bjquery\b/i, concern: 'jQuery in 2025 adds 30KB for what native DOM provides for free.' },
  { pattern: /\bvar\s+[a-zA-Z_$]/i, concern: 'var has function-scope hoisting. Use const (default) or let.' },
  { pattern: /catch\s*\([^)]*\)\s*\{\s*(\/\/[^\n]*)?\s*\}/i, concern: 'Empty catch silently swallows errors.' },
  { pattern: /console\.(log|debug)\b/i, concern: 'console.log in production leaks internal state. Use structured logging.' },
  { pattern: /\/\/\s*(todo|fixme|hack|xxx)\b/i, concern: 'Unresolved TODO/FIXME — resolve before shipping.' },
  { pattern: /:\s*any\b/i, concern: 'TypeScript any disables type safety. Use unknown or a proper type.' },
  { pattern: /\b(xdescribe|xit|xtest|\.skip)\b/i, concern: 'Skipped tests hide regressions. Fix or delete them.' },
  { pattern: /Math\.random\(\)/i, concern: 'Math.random() is not cryptographically secure. Use crypto.randomBytes().' },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format code|update comment|add comment)\b/i;

// Topic expertise: when no bad patterns match, extract domain topics and give expert opinion
const TOPIC_INSIGHTS: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /agent|worker|executor|pipeline|orchestrat/i,
    concern: 'Agent architectures need clear contracts: every agent must have a defined input schema, output schema, and error behavior. Agents that silently return empty results on failure are impossible to debug.',
    recommendation: 'Define typed input/output interfaces for each agent. Return structured errors, never null. Log agent invocations with task ID for traceability.',
  },
  {
    pattern: /memory|session|persist|store|cache|knowledge/i,
    concern: 'Persistent memory stores grow unbounded without eviction policies. Old entries degrade search quality and waste storage.',
    recommendation: 'Add TTL or relevance-decay to knowledge entries. Implement max-entry limits per project. Provide a cleanup command for stale data.',
  },
  {
    pattern: /plugin|extensi|hook|custom.?agent/i,
    concern: 'Plugin systems are a common attack surface. Plugins with unchecked filesystem or network access can exfiltrate data or corrupt state.',
    recommendation: 'Sandbox plugins: restrict to a defined API, no direct DB access, no arbitrary filesystem reads. Validate plugin schema on load.',
  },
  {
    pattern: /llm|model|ai.?call|openai|anthropic|gemini|claude/i,
    concern: 'LLM integration introduces latency (2–30s), cost variability, and non-determinism. A failing LLM call must not crash the tool — it must degrade gracefully.',
    recommendation: 'Set explicit timeouts on every LLM call. Cache responses where determinism is acceptable. Return a structured fallback on failure, never an unhandled exception.',
  },
  {
    pattern: /webhook|http.?server|express|endpoint|route|port/i,
    concern: 'Adding HTTP transport changes the threat model from local-only to network-exposed. Authentication, rate limiting, and input validation are now mandatory.',
    recommendation: 'Require authentication on all HTTP endpoints from day one. Apply request body size limits. Log all requests with IP and timestamp.',
  },
  {
    pattern: /version|semver|bump|release|publish|npm/i,
    concern: 'Version bumps without updating all hardcoded version strings create drift between what the server reports and what is actually running.',
    recommendation: 'Single source of truth: read version from package.json at runtime. Search for hardcoded version strings before every release.',
  },
  {
    pattern: /test|spec|coverage|vitest|jest|assert/i,
    concern: 'Test suites that mock the database or external services can pass while production behavior fails. Regression gaps are most common at integration boundaries.',
    recommendation: 'Integration tests should hit real SQLite (use in-memory DB). Unit test pure logic only. Track coverage per agent to find untested paths.',
  },
  {
    pattern: /config|setting|environment|env.?var|dotenv/i,
    concern: 'Config loaded from environment without validation fails silently in production. Missing required variables cause runtime errors far from the source.',
    recommendation: 'Validate all required env vars at startup with explicit error messages. Use a schema (zod) for config validation. Fail fast, not late.',
  },
  {
    pattern: /phase|plan|roadmap|feature|improvement/i,
    concern: 'Feature planning without defined acceptance criteria leads to scope creep and unmeasurable completion. Each phase needs a clear "done" definition.',
    recommendation: 'For each planned feature, define: input, expected output, edge cases, and a test that proves it works. Write the test first if possible.',
  },
  {
    pattern: /concurrent|parallel|race|async|thread|mutex/i,
    concern: 'Parallel execution over a shared SQLite connection will cause write conflicts unless WAL mode and proper serialisation are in place.',
    recommendation: 'Verify WAL journal mode is enabled. Use transactions for multi-step writes. Test with concurrent load before shipping parallel agent features.',
  },
];

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no security or quality concerns.', concerns: [] };
  }

  const blocks: Array<{ reason: string; recommendation: string }> = [];
  const concerns: string[] = [];

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(task)) {
      blocks.push({ reason: rule.reason, recommendation: rule.recommendation });
    }
  }
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(task)) {
      concerns.push(rule.concern);
    }
  }

  let vote: AgentVote;

  if (blocks.length > 0) {
    vote = {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: [...blocks.slice(1).map(b => b.reason), ...concerns],
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  } else if (concerns.length > 0) {
    vote = {
      verdict: 'warn',
      reason: `${concerns.length} code quality issue${concerns.length > 1 ? 's' : ''} detected.`,
      concerns,
      recommendation: 'Address quality concerns before shipping to production.',
    };
  } else {
    // No bad patterns — apply topic-based expert analysis
    const matched = TOPIC_INSIGHTS.filter(t => t.pattern.test(task));
    if (matched.length > 0) {
      const top = matched.slice(0, 2);
      vote = {
        verdict: 'warn',
        reason: top[0].concern,
        concerns: top.slice(1).map(t => t.concern),
        recommendation: top.map(t => t.recommendation).join(' | '),
      };
    } else {
      vote = { verdict: 'approve', reason: 'No security or quality violations detected. Code quality standards appear satisfied.', concerns: [] };
    }
  }

  return applyDecisionStance(vote, task);
}

// Risk: traits that increase implementation burden / maintenance surface
const LEAD_DEV_RISK = /\b(http|express|rest.?api|api.?layer|bundl|embed|integrat\s+into|new\s+(server|layer|endpoint|transport))\b/i;

function applyDecisionStance(vote: AgentVote, task: string): AgentVote {
  const ctx = extractDecision(task);
  if (!ctx.isDecisionTask) return vote;
  const { optionA, optionB } = ctx;
  const side = pickSide(optionA, optionB, LEAD_DEV_RISK);
  const advice = side
    ? `"${side.avoided}" adds new infrastructure to maintain; "${side.preferred}" limits scope and keeps the codebase smaller — validate real demand before building.`
    : `Evaluate which option requires fewer new abstractions. Prefer the path with the smaller implementation surface until user demand justifies the cost.`;
  return reframeVote(vote, ctx, side?.preferred ?? null, advice);
}
