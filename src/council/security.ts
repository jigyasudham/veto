// Security — threat modeling, attack surface analysis, auth weaknesses, CVE patterns
import type { AgentVote } from './types.js';

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /(no.{0,25}rate.?limit|(auth|login|password|signin|otp|2fa|token|reset).{0,50}no.{0,20}rate.?limit|no.{0,25}rate.?limit.{0,50}(auth|login|password|signin|otp|2fa))/i,
    reason: 'Auth endpoint without rate limiting is wide open to brute-force and credential stuffing.',
    recommendation: 'Rate limit: 5 attempts / 15 min / IP. Exponential backoff. Lock account after 10 failures.',
  },
  {
    pattern: /jwt.{0,35}(no|without|missing).{0,20}expir|token.{0,20}never.{0,15}expir/i,
    reason: 'JWTs without expiry are permanent access tokens — a stolen token never becomes invalid.',
    recommendation: 'Set JWT exp to 15 min. Issue refresh tokens in httpOnly, Secure, SameSite=Strict cookies.',
  },
  {
    pattern: /localStorage.{0,30}(token|jwt|session|auth|secret)|(token|jwt|session|auth|secret).{0,30}localStorage/i,
    reason: 'Tokens in localStorage are readable by any script — XSS vulnerability gives full account takeover.',
    recommendation: 'Store tokens only in httpOnly Secure SameSite=Strict cookies. Never localStorage.',
  },
  {
    pattern: /no.{0,20}csrf|skip.{0,20}csrf|disable.{0,20}csrf|without.{0,20}csrf/i,
    reason: 'Missing CSRF protection enables cross-site request forgery — attackers can act as authenticated users.',
    recommendation: 'Use CSRF tokens for form submissions. Set SameSite=Strict on session cookies as baseline.',
  },
  {
    pattern: /run.{0,20}(as\s+)?root|user\s+root.{0,20}(docker|container|image)/i,
    reason: 'Running containers as root means any exploit has full host access.',
    recommendation: 'Add `USER 1001` in Dockerfile. Use rootless containers. Drop all capabilities.',
  },
  {
    pattern: /admin.{0,35}(route|endpoint|panel|api).{0,35}(no|without|skip|missing).{0,20}auth/i,
    reason: 'Admin routes without authentication check expose privileged operations to any unauthenticated caller.',
    recommendation: 'Guard all admin routes with both authentication AND role/permission authorization check.',
  },
  {
    pattern: /\b(mass.?assign|accept.{0,20}(all|any).{0,20}(field|body|param|input))\b/i,
    reason: 'Mass assignment lets attackers inject internal fields (isAdmin: true) through the request body.',
    recommendation: 'Whitelist allowed fields explicitly. Never spread req.body into DB operations.',
  },
  {
    pattern: /\.\.\/|\.\.\\|path.{0,20}traversal|(file|path).{0,20}(user|input|param).{0,20}(read|open|access)/i,
    reason: 'Path traversal vulnerability — attacker can read arbitrary server files by manipulating path input.',
    recommendation: 'Use path.resolve() and verify result starts with your allowed base directory.',
  },
  {
    pattern: /deserializ.{0,30}(user|external|untrusted|input)/i,
    reason: 'Deserializing untrusted data enables remote code execution via gadget chains.',
    recommendation: 'Never deserialize untrusted data. Use JSON.parse() with schema validation (zod).',
  },
  {
    pattern: /xml.{0,30}(user|input|external).{0,30}(parse|process)/i,
    reason: 'Parsing user-supplied XML without XXE protection enables XML External Entity injection.',
    recommendation: 'Disable external entity processing in your XML parser. Prefer JSON over XML for APIs.',
  },
  {
    pattern: /\bshell\b.{0,30}(user|input|param)|exec\s*\(.{0,30}(req\.|input|param)/i,
    reason: 'Passing user input to shell commands enables OS command injection — full server compromise.',
    recommendation: 'Use execFile() with args as array. Never concatenate user input into shell commands.',
  },
  {
    pattern: /no.{0,20}(auth|authentication|authorization).{0,30}(internal|service.?to.?service|microservice)/i,
    reason: 'Service-to-service calls without auth allows any internal service to impersonate another.',
    recommendation: 'Use mutual TLS or service tokens for internal API calls. Never trust internal network alone.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /no.{0,25}(content.?security.?policy|\bcsp\b)/i,
    concern: 'Missing Content-Security-Policy header — no browser-level XSS mitigation.',
    recommendation: "Set CSP: default-src 'self'; script-src 'self'. Use helmet.js for Express.",
  },
  {
    pattern: /verbose.{0,20}error|stack.?trace.{0,25}(user|client|return|response|send)/i,
    concern: 'Verbose error messages expose file paths, library versions, and stack traces to attackers.',
    recommendation: 'Log full errors server-side only. Return generic messages to clients.',
  },
  {
    pattern: /no.{0,20}(audit|security).{0,15}log/i,
    concern: 'No security audit log — impossible to detect or investigate breaches after the fact.',
    recommendation: 'Log: auth events, admin actions, data exports, permission denials, with IP + user + timestamp.',
  },
  {
    pattern: /no.{0,20}(dependency|package|npm|pip).{0,20}(audit|scan|update)/i,
    concern: 'Unaudited dependencies may contain known CVEs actively exploited in the wild.',
    recommendation: 'Run npm audit / snyk in CI pipeline. Block builds with critical severity CVEs.',
  },
  {
    pattern: /no.{0,20}(payload|body|request).{0,20}(size|limit|max)/i,
    concern: 'No payload size limit — attackers can exhaust server memory with large request bodies.',
    recommendation: 'Set body size limit (1MB JSON, 10MB uploads). Return 413 on excess. Use streaming for large files.',
  },
  {
    pattern: /\bregex\b.{0,30}(user|input|param|untrusted)/i,
    concern: 'Complex regex on user input can cause ReDoS — catastrophic backtracking is a DoS vector.',
    recommendation: 'Test regex with ReDoS checker (vuln-regex-detector). Set match timeout for user input.',
  },
  {
    pattern: /server.?version|x-powered-by|expose.{0,20}(version|framework)/i,
    concern: 'Disclosing server/framework version in headers helps attackers target known CVEs.',
    recommendation: 'Remove X-Powered-By. Set Server: header to empty string. Use helmet.js.',
  },
  {
    pattern: /upload.{0,30}(any|all|every).{0,20}(type|extension|format|file)/i,
    concern: 'Accepting any file type enables upload of malicious executables or web shells.',
    recommendation: 'Whitelist allowed MIME types. Validate magic bytes (not extension). Scan with ClamAV.',
  },
  {
    pattern: /\bidor\b|direct.{0,20}object.{0,20}ref|user.?id.{0,20}(param|query|url|path)/i,
    concern: 'Potential IDOR — user can access other users\' resources by changing an ID in the request.',
    recommendation: 'Always verify ownership: resource.userId === req.user.id before returning/mutating.',
  },
  {
    pattern: /compare.{0,20}(secret|token|hash|hmac|signature|password).{0,20}===|===.{0,20}(secret|token|hmac)/i,
    concern: 'String === comparison of secrets is vulnerable to timing attacks.',
    recommendation: 'Use crypto.timingSafeEqual() for all secret and HMAC comparisons.',
  },
  {
    pattern: /no.{0,20}hsts|http.{0,20}(only|no.?https)/i,
    concern: 'Without HSTS, browsers may connect over HTTP — credentials can be intercepted.',
    recommendation: 'Set HSTS: max-age=31536000; includeSubDomains; preload. Redirect all HTTP to HTTPS.',
  },
  {
    pattern: /secret.{0,20}(env|environment|config).{0,20}(log|print|console|output)/i,
    concern: 'Logging secrets or config values leaks credentials to anyone with log access.',
    recommendation: 'Never log secrets. Redact sensitive fields in structured logs. Audit log pipelines.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no security concerns.', concerns: [] };
  }

  const blocks: Array<{ reason: string; recommendation: string }> = [];
  const concerns: string[] = [];
  const recommendations: string[] = [];

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(task)) {
      blocks.push({ reason: rule.reason, recommendation: rule.recommendation });
    }
  }
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(task)) {
      concerns.push(rule.concern);
      recommendations.push(rule.recommendation);
    }
  }

  if (blocks.length > 0) {
    return {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: blocks.slice(1).map(b => b.reason),
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  }

  if (concerns.length > 0) {
    return {
      verdict: 'warn',
      reason: `${concerns.length} security concern${concerns.length > 1 ? 's' : ''} — threat model flagged issues.`,
      concerns,
      recommendation: recommendations[0],
    };
  }

  return { verdict: 'approve', reason: 'No security threats identified in threat model.', concerns: [] };
}
