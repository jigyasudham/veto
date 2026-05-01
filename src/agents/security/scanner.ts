import type { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'security-scanner',
    task,
    tier: 2,
    approach:
      'Apply OWASP Top 10 methodology: enumerate attack surface, check each category ' +
      'systematically, prioritise critical and high findings, produce actionable remediation.',
    steps: [
      'Identify all entry points: HTTP endpoints, file uploads, WebSocket, CLI args',
      'Map authentication and authorisation boundaries',
      'A01 – Broken Access Control: ownership checks, privilege escalation paths',
      'A02 – Cryptographic Failures: cipher strength, data-in-transit, data-at-rest',
      'A03 – Injection: SQL, NoSQL, OS command, LDAP, template injection',
      'A04 – Insecure Design: missing input validation, business logic flaws',
      'A05 – Security Misconfiguration: debug flags, default creds, verbose errors',
      'A06 – Vulnerable Components: dependency CVEs, outdated libraries',
      'A07 – Authentication Failures: rate limiting, session management, token strength',
      'A08 – Software Integrity: deserialization, supply-chain, CI integrity checks',
      'A09 – Logging Failures: audit trail completeness, sensitive data in logs',
      'A10 – SSRF: user-supplied URLs in outbound calls',
      'Aggregate findings, calculate score, produce verdict and remediation plan',
    ],
    checklist: [
      'All HTTP routes require authentication where data is user-specific',
      'Object-level authorisation verifies ownership before returning or mutating records',
      'No MD5 or SHA-1 used for password hashing or data integrity',
      'TLS enforced on all external connections; HSTS header present',
      'SQL queries use parameterised statements or ORM; no string concatenation',
      'eval() and new Function() constructors are absent from production code',
      'Input validated with schema library (zod/joi) at every API boundary',
      'Error responses do not leak stack traces or internal file paths',
      'Debug/development flags disabled in production builds',
      'Default credentials and example secrets removed from all config files',
      'Auth endpoints protected by rate limiting and account-lockout logic',
      'Session tokens stored in httpOnly, Secure, SameSite=Strict cookies',
      'Deserialisation of untrusted data avoided or performed with strict schema',
      'Audit log written for every sensitive operation (login, delete, privilege change)',
      'Passwords and secrets never appear in log output',
      'Outbound HTTP requests validate/whitelist target URLs; no raw user-supplied URLs',
      'npm audit / yarn audit run in CI with zero high/critical failure threshold',
      'Security headers set: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy',
    ],
    pitfalls: [
      'Trusting client-supplied IDs without server-side ownership validation (IDOR)',
      'Comparing password hashes with == instead of a constant-time function',
      'Sending res.json(err) in Express error handlers — leaks internal details',
      'Forgetting to validate JWT claims server-side; client-side role inflation',
      'Server-Side Template Injection when user input is interpolated into templates',
      'Prototype pollution through lodash merge on untrusted objects',
      'CORS wildcard (*) combined with credentials:true',
      'Logging req.body at DEBUG level — captures passwords in plaintext',
    ],
    patterns: [
      'Parameterised queries / prepared statements for all DB access',
      'Repository pattern isolates data access and makes auth injection consistent',
      'Middleware chain: authenticate → authorise → validate → handle',
      'Allow-list validation (reject unknown fields) via zod strict() mode',
      'Centralised error handler strips internal details before response',
      'Structured logging with automatic redaction of secret fields',
    ],
    duration_estimate: context?.includes('large') ? '4-6 hours' : '1-2 hours',
  };
}

// ─── Pattern definitions ───────────────────────────────────────────────────

interface CheckPattern {
  regex: RegExp;
  severity: FindingSeverity;
  category: string;
  description: string;
  fix: string;
  cwe?: string;
  owasp: string;
}

const CHECKS: CheckPattern[] = [
  // A01 – Broken Access Control
  {
    regex: /req\.params\.(id|userId|user_id)\b/,
    severity: 'high',
    category: 'A01 Broken Access Control',
    description: 'req.params.id used — verify ownership check exists to prevent IDOR.',
    fix: 'Assert req.user.id === record.userId before returning or mutating the resource.',
    cwe: 'CWE-639',
    owasp: 'A01:2021',
  },
  {
    regex: /role\s*=\s*req\.body\.role|req\.body\[['"]role['"]\]/,
    severity: 'critical',
    category: 'A01 Broken Access Control',
    description: 'Role assigned directly from request body — allows privilege escalation.',
    fix: 'Never accept role from client input. Derive roles server-side from the session.',
    cwe: 'CWE-269',
    owasp: 'A01:2021',
  },

  // A02 – Cryptographic Failures
  {
    regex: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i,
    severity: 'high',
    category: 'A02 Cryptographic Failures',
    description: 'Weak cryptographic hash (MD5/SHA-1) detected.',
    fix: 'Replace with SHA-256 or SHA-512 for hashing; use bcrypt/argon2 for passwords.',
    cwe: 'CWE-327',
    owasp: 'A02:2021',
  },
  {
    regex: /createCipher\s*\(\s*['"](?:des|rc4)['"]\s*\)/i,
    severity: 'high',
    category: 'A02 Cryptographic Failures',
    description: 'Broken symmetric cipher (DES/RC4) detected.',
    fix: 'Replace with AES-256-GCM.',
    cwe: 'CWE-327',
    owasp: 'A02:2021',
  },
  {
    regex: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    severity: 'medium',
    category: 'A02 Cryptographic Failures',
    description: 'Plain HTTP URL detected — data transmitted without encryption.',
    fix: 'Use HTTPS for all external URLs. Enforce HSTS in production.',
    cwe: 'CWE-319',
    owasp: 'A02:2021',
  },

  // A03 – Injection
  {
    regex: /['"`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*\+\s*(?:req\.|params\.|body\.|query\.)\w+/i,
    severity: 'critical',
    category: 'A03 Injection',
    description: 'String concatenation inside SQL query — SQL injection risk.',
    fix: 'Use parameterised queries: db.query("SELECT ... WHERE id = $1", [id])',
    cwe: 'CWE-89',
    owasp: 'A03:2021',
  },
  {
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    severity: 'critical',
    category: 'A03 Injection',
    description: 'eval() or new Function() detected — JavaScript injection vector.',
    fix: 'Remove eval(). Use JSON.parse() for data or a dedicated expression parser.',
    cwe: 'CWE-95',
    owasp: 'A03:2021',
  },
  {
    regex: /(?:exec|execSync|spawn)\s*\(\s*`[^`]*\$\{(?:req|params|body|query)\./,
    severity: 'critical',
    category: 'A03 Injection',
    description: 'User input interpolated into shell command — OS command injection.',
    fix: 'Use execFile() with a fixed command and an array of sanitised arguments.',
    cwe: 'CWE-78',
    owasp: 'A03:2021',
  },

  // A04 – Insecure Design
  {
    regex: /req\.body\.\w+\s*(?:&&|\|\||,|\))[^;]{0,120}(?:\.save\s*\(|\.create\s*\(|\.insert\s*\()/,
    severity: 'medium',
    category: 'A04 Insecure Design',
    description: 'Request body values passed to persistence layer without visible validation.',
    fix: 'Validate and sanitise all inputs with zod or joi before saving.',
    cwe: 'CWE-20',
    owasp: 'A04:2021',
  },

  // A05 – Security Misconfiguration
  {
    regex: /debug\s*[:=]\s*true/i,
    severity: 'medium',
    category: 'A05 Security Misconfiguration',
    description: 'Debug mode flag set to true in source.',
    fix: 'Guard debug features with NODE_ENV checks; never enable in production.',
    cwe: 'CWE-16',
    owasp: 'A05:2021',
  },
  {
    regex: /password\s*[:=]\s*['"](?:admin|root|password|123456|secret|test|demo)['"]/i,
    severity: 'critical',
    category: 'A05 Security Misconfiguration',
    description: 'Default or trivial credential detected in source.',
    fix: 'Remove default credentials. Store only bcrypt hashes; move to env vars.',
    cwe: 'CWE-1392',
    owasp: 'A05:2021',
  },
  {
    regex: /res\s*\.\s*(?:json|send)\s*\(\s*(?:err|error)\s*\)/,
    severity: 'medium',
    category: 'A05 Security Misconfiguration',
    description: 'Raw error object sent in HTTP response — may expose internals.',
    fix: 'Use a centralised error handler that maps errors to safe user-facing messages.',
    cwe: 'CWE-209',
    owasp: 'A05:2021',
  },

  // A06 – Vulnerable Components
  {
    regex: /require\s*\(\s*['"]node-serialize['"]\s*\)|from\s+['"]node-serialize['"]/,
    severity: 'critical',
    category: 'A06 Vulnerable Components',
    description: 'node-serialize has a known Remote Code Execution vulnerability.',
    fix: 'Remove node-serialize. Use JSON.parse() for safe deserialisation.',
    cwe: 'CWE-502',
    owasp: 'A06:2021',
  },
  {
    regex: /require\s*\(\s*['"]request['"]\s*\)|from\s+['"]request['"]/,
    severity: 'low',
    category: 'A06 Vulnerable Components',
    description: 'The "request" package is deprecated and unmaintained.',
    fix: 'Replace with native fetch() (Node 18+), axios, or got.',
    owasp: 'A06:2021',
  },

  // A07 – Authentication Failures
  {
    regex: /localStorage\s*\.\s*setItem\s*\(\s*['"][^'"]*(?:token|jwt|auth)[^'"]*['"]/i,
    severity: 'high',
    category: 'A07 Authentication Failures',
    description: 'Auth token stored in localStorage — vulnerable to XSS theft.',
    fix: 'Store tokens in httpOnly, Secure, SameSite=Strict cookies.',
    cwe: 'CWE-922',
    owasp: 'A07:2021',
  },
  {
    regex: /router\s*\.\s*post\s*\(\s*['"]\/(?:login|signin|auth)['"]/i,
    severity: 'high',
    category: 'A07 Authentication Failures',
    description: 'Auth endpoint found — verify rate limiting is applied.',
    fix: 'Apply express-rate-limit to all auth routes to prevent brute-force attacks.',
    cwe: 'CWE-307',
    owasp: 'A07:2021',
  },

  // A08 – Software Integrity
  {
    regex: /JSON\.parse\s*\(\s*(?:req\.|body\.|params\.|query\.)\w+/,
    severity: 'medium',
    category: 'A08 Software Integrity',
    description: 'JSON.parse on user-supplied data without visible try/catch or schema validation.',
    fix: 'Wrap JSON.parse in try/catch and validate the result structure with zod.',
    cwe: 'CWE-502',
    owasp: 'A08:2021',
  },

  // A09 – Logging Failures
  {
    regex: /console\s*\.\s*log\s*\([^)]*(?:password|passwd|secret|token|apikey|api_key)[^)]*\)/i,
    severity: 'high',
    category: 'A09 Logging Failures',
    description: 'Sensitive value (password/secret/token) may be written to logs.',
    fix: 'Never log sensitive fields. Redact before passing to the logger.',
    cwe: 'CWE-532',
    owasp: 'A09:2021',
  },

  // A10 – SSRF
  {
    regex: /(?:fetch|axios\.get|axios\.post|http\.get)\s*\(\s*(?:req\.|body\.|params\.|query\.)\w+/,
    severity: 'critical',
    category: 'A10 SSRF',
    description: 'User-supplied value passed directly to HTTP client — SSRF risk.',
    fix: 'Validate the URL against a strict allow-list of permitted domains. Reject internal IP ranges.',
    cwe: 'CWE-918',
    owasp: 'A10:2021',
  },
];

// ─── Public API ────────────────────────────────────────────────────────────

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];

  for (const check of CHECKS) {
    if (check.regex.test(code)) {
      const finding: AgentFinding = {
        severity: check.severity,
        category: check.category,
        description: check.description,
        fix: check.fix,
        owasp: check.owasp,
      };
      if (check.cwe) finding.cwe = check.cwe;
      findings.push(finding);
    }
  }

  const critical = findings.filter(f => f.severity === 'critical').length;
  const high = findings.filter(f => f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  const low = findings.filter(f => f.severity === 'low').length;

  const raw = 100 - (critical * 25 + high * 10 + medium * 5 + low * 2);
  const score = Math.max(0, raw);

  const verdict: AgentAnalysis['verdict'] =
    score >= 90 ? 'approved'
    : score >= 70 ? 'approved_with_warnings'
    : score >= 50 ? 'needs_revision'
    : 'rejected';

  const subject = context ?? 'provided code';

  const summary =
    findings.length === 0
      ? `No OWASP Top 10 violations detected in ${subject}. Score: ${score}/100.`
      : `Found ${findings.length} issue(s) in ${subject}: ${critical} critical, ${high} high, ${medium} medium, ${low} low. Score: ${score}/100 — ${verdict.replace(/_/g, ' ')}.`;

  return {
    agent: 'security-scanner',
    subject,
    findings,
    score,
    verdict,
    summary,
    critical_count: critical,
    high_count: high,
  };
}
