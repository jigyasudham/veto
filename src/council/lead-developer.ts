// Lead Developer — code quality, security, no shortcuts
import type { AgentVote } from './types.js';

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

  if (blocks.length > 0) {
    return {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: [...blocks.slice(1).map(b => b.reason), ...concerns],
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  }

  if (concerns.length > 0) {
    return {
      verdict: 'warn',
      reason: `${concerns.length} code quality issue${concerns.length > 1 ? 's' : ''} detected.`,
      concerns,
      recommendation: 'Address quality concerns before shipping to production.',
    };
  }

  return { verdict: 'approve', reason: 'No security or quality violations detected.', concerns: [] };
}
