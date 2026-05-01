import type { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity } from '../types.js';

export interface SecretsFinding {
  type: string;
  value: string;   // first 4 chars + ****
  line: number;
  severity: FindingSeverity;
  fix: string;
}

// ─── Plan ──────────────────────────────────────────────────────────────────

export function plan(task: string, _context?: string): AgentPlan {
  return {
    agent: 'secrets',
    task,
    tier: 1,
    approach:
      'Systematically detect, rotate, and vault all credentials. ' +
      'Apply defence-in-depth: scan source, enforce pre-commit hooks, ' +
      'use a secrets manager, and never let secrets reach version control.',
    steps: [
      'Run static scan (this agent) across the entire codebase including .env files',
      'Identify all credential types: API keys, DB connection strings, private keys, tokens',
      'Rotate any exposed credentials immediately — assume they are compromised',
      'Move all secrets to a secrets manager (AWS Secrets Manager, Vault, Doppler)',
      'Replace hardcoded values with environment-variable references',
      'Add .env* to .gitignore; add .env.example with placeholder values',
      'Install a pre-commit hook (git-secrets, gitleaks) to block future commits',
      'Configure CI/CD secret scanning (GitHub secret scanning, Trufflehog action)',
      'Set minimum secret rotation period in policy (90 days for API keys, 30 for DB)',
      'Document which services own which secrets in a secrets inventory',
    ],
    checklist: [
      'No secrets committed to the repository (scan with gitleaks/trufflehog)',
      '.env files listed in .gitignore at the repo root',
      '.env.example present with only placeholder values, no real secrets',
      'All API keys loaded from process.env at runtime, not import-time constants',
      'AWS credentials use IAM roles / instance profiles, not access key + secret pairs',
      'Private keys stored in a hardware security module or secrets manager',
      'JWT_SECRET is at least 256 bits of random entropy, not a dictionary word',
      'Database connection strings contain no credentials (use socket auth or Secrets Manager)',
      'GitHub tokens scoped to minimal required permissions and set to expire',
      'Secret scanning enabled in GitHub repository settings',
      'Pre-commit hook configured to block secrets (git-secrets or gitleaks)',
      'CI pipeline fails if any secret pattern is detected in changed files',
      'Secrets rotated after any team-member departure or suspected exposure',
      'Audit log maintained of who accessed each secret and when',
    ],
    pitfalls: [
      'Committing .env files accidentally when .gitignore is misconfigured',
      'Hardcoding secrets in Dockerfile ARG/ENV layers visible in image history',
      'Logging full request headers which include Authorization bearer tokens',
      'Storing secrets in client-side code bundled into the browser',
      'Using short or guessable JWT secrets ("secret", "mysecret", "1234")',
      'Checking in AWS credentials profile files (~/.aws/credentials) via CI runners',
      'Embedding secrets in CI/CD YAML files instead of using encrypted variables',
    ],
    patterns: [
      'Twelve-Factor App: config via environment variables',
      'Secrets manager pattern: centralised vault with short-lived leases',
      'Secret rotation pattern: automated rotation with zero-downtime swap',
      'Pre-commit hook pattern: block secrets before they enter git history',
    ],
    duration_estimate: '2-4 hours for full secrets audit and remediation',
  };
}

// ─── Scan patterns ─────────────────────────────────────────────────────────

interface ScanPattern {
  type: string;
  regex: RegExp;
  severity: FindingSeverity;
  fix: string;
}

const PATTERNS: ScanPattern[] = [
  {
    type: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/,
    severity: 'critical',
    fix: 'Immediately revoke this AWS access key in the IAM console. Use IAM roles or instance profiles instead.',
  },
  {
    type: 'AWS Secret Access Key',
    regex: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+]{40}['"]?/i,
    severity: 'critical',
    fix: 'Rotate the AWS secret access key immediately. Store credentials in AWS Secrets Manager or via instance role.',
  },
  {
    type: 'GitHub Token (ghp_)',
    regex: /ghp_[a-zA-Z0-9]{36}/,
    severity: 'critical',
    fix: 'Revoke this GitHub personal access token immediately. Use short-lived tokens with minimal scopes.',
  },
  {
    type: 'GitHub Token (env var)',
    regex: /github_token\s*=\s*['"][a-zA-Z0-9_]{20,}['"]/i,
    severity: 'high',
    fix: 'Move the GitHub token to a CI/CD secret variable. Never hardcode tokens.',
  },
  {
    type: 'RSA Private Key',
    regex: /-----BEGIN RSA PRIVATE KEY-----/,
    severity: 'critical',
    fix: 'Remove the private key from source. Store in a secrets manager or HSM. Rotate the key pair immediately.',
  },
  {
    type: 'EC Private Key',
    regex: /-----BEGIN EC PRIVATE KEY-----/,
    severity: 'critical',
    fix: 'Remove the private key from source. Store in a secrets manager or HSM. Rotate the key pair immediately.',
  },
  {
    type: 'OpenSSH Private Key',
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----/,
    severity: 'critical',
    fix: 'Remove the private key from source. Store in a secrets manager or HSM. Rotate the key pair immediately.',
  },
  {
    type: 'API Key (generic)',
    regex: /(?:api_key|apikey|api-key)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i,
    severity: 'high',
    fix: 'Move the API key to an environment variable. Load via process.env.API_KEY at runtime.',
  },
  {
    type: 'JWT Secret',
    regex: /jwt_secret\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: 'high',
    fix: 'Move JWT_SECRET to an environment variable. Use at least 256 bits of random entropy.',
  },
  {
    type: 'Hardcoded Password',
    regex: /password\s*[:=]\s*['"][^'"]{4,}['"]/i,
    severity: 'high',
    fix: 'Remove hardcoded password. Store in environment variable and load at runtime.',
  },
  {
    type: 'MongoDB Connection String',
    regex: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/,
    severity: 'critical',
    fix: 'Rotate MongoDB credentials immediately. Use environment variable MONGODB_URI with no credentials in source.',
  },
  {
    type: 'PostgreSQL Connection String',
    regex: /postgres(?:ql)?:\/\/[^:]+:[^@]+@/,
    severity: 'critical',
    fix: 'Rotate PostgreSQL credentials immediately. Use DATABASE_URL environment variable.',
  },
  {
    type: 'MySQL Connection String',
    regex: /mysql:\/\/[^:]+:[^@]+@/,
    severity: 'critical',
    fix: 'Rotate MySQL credentials immediately. Use DATABASE_URL environment variable.',
  },
  {
    type: 'Slack Token',
    regex: /xox[baprs]-[0-9A-Za-z\-]{10,}/,
    severity: 'high',
    fix: 'Revoke this Slack token immediately. Store in a secrets manager.',
  },
  {
    type: 'Generic High-Entropy Secret',
    regex: /(?:secret|token|key|passwd)\s*[:=]\s*['"][A-Za-z0-9+/=_\-]{32,}['"]/i,
    severity: 'medium',
    fix: 'Review this value. If it is a secret, move it to an environment variable or secrets manager.',
  },
];

// ─── Helper: mask value ────────────────────────────────────────────────────

function maskValue(raw: string): string {
  const match = raw.match(/['"]([^'"]+)['"]/);
  const secret = match ? match[1] : raw.replace(/.*[:=]\s*/, '');
  return secret.length >= 4 ? `${secret.slice(0, 4)}****` : '****';
}

// ─── Public API ────────────────────────────────────────────────────────────

export function scan(text: string): SecretsFinding[] {
  const findings: SecretsFinding[] = [];
  const lines = text.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const pattern of PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        findings.push({
          type: pattern.type,
          value: maskValue(match[0]),
          line: lineIndex + 1,
          severity: pattern.severity,
          fix: pattern.fix,
        });
        break; // one finding per pattern per line
      }
    }
  }

  return findings;
}

export function analyze(code: string, context?: string): AgentAnalysis {
  const secretFindings = scan(code);

  const findings: AgentFinding[] = secretFindings.map(sf => ({
    severity: sf.severity,
    category: 'Credential Exposure',
    description: `${sf.type} detected at line ${sf.line} (value: ${sf.value})`,
    fix: sf.fix,
    location: `line ${sf.line}`,
    cwe: 'CWE-798',
    owasp: 'A02:2021',
  }));

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
      ? `No credentials or secrets detected in ${subject}. Score: ${score}/100.`
      : `Found ${findings.length} credential(s) in ${subject}: ${critical} critical, ${high} high, ${medium} medium. Score: ${score}/100 — ${verdict.replace(/_/g, ' ')}.`;

  return {
    agent: 'secrets',
    subject,
    findings,
    score,
    verdict,
    summary,
    critical_count: critical,
    high_count: high,
  };
}
