// Skill: security-scan — OWASP Top 10 scan process with tool commands

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'security-scan',
    template: undefined,
    checklist: [
      // Dependency scanning
      '1. Run npm audit: npx npm audit --audit-level=high (fail CI if high/critical found)',
      '2. Run Snyk for deeper CVE analysis: npx snyk test --severity-threshold=high',
      '3. Check for outdated packages: npx npm-check-updates (review before upgrading)',
      '4. Verify lockfile integrity: npm ci (uses lockfile exactly; fails if lockfile is dirty)',

      // Secrets scanning
      '5. Scan for hardcoded secrets: npx gitleaks detect --source . --verbose',
      '6. Run trufflehog on git history: trufflehog git file://. --since-commit HEAD~20',
      '7. Verify .gitignore covers .env, *.key, *.pem, secrets.json, credentials.json',

      // Static analysis
      '8. Run ESLint security plugin: eslint --plugin security --rule "security/detect-eval-with-expression: error"',
      '9. Run Semgrep OWASP ruleset: semgrep --config=p/owasp-top-ten --error .',
      '10. Run CodeQL (GitHub Actions): use codeql-action/analyze with javascript/typescript queries',

      // A01 – Broken Access Control
      '11. A01 – Review every route handler: confirm auth middleware precedes data access',
      '12. A01 – Search for direct object references: grep -r "req.params.id" src/ — verify ownership check in each',

      // A02 – Cryptographic Failures
      '13. A02 – Search for weak hashes: grep -r "md5\\|sha1\\|DES\\|RC4" src/ (flag any match)',
      '14. A02 – Verify HTTPS enforcement: check for HSTS header and HTTP→HTTPS redirect in server config',

      // A03 – Injection
      '15. A03 – Search for SQL concatenation: grep -r "SELECT.*+" src/ — all DB calls should use parameterised queries',
      '16. A03 – Search for eval: grep -rn "eval(" src/ — no eval() in production code',

      // A05 – Misconfiguration
      '17. A05 – Run security headers check: curl -I https://your-domain.com | grep -E "Content-Security|X-Frame|Strict-Transport|X-Content"',
      '18. A05 – Verify no debug routes in production: grep -r "/debug\\|/__admin" src/routes/',

      // A07 – Auth failures
      '19. A07 – Confirm rate limiting on auth endpoints: grep -r "rateLimit" src/routes/auth',
      '20. A07 – Verify account lockout logic exists: grep -r "lockedUntil\\|failedAttempts" src/services/auth',

      // DAST
      '21. Run OWASP ZAP baseline scan: docker run -t owasp/zap2docker-stable zap-baseline.py -t https://staging.example.com',
      '22. Check Content-Security-Policy with observatory: npx observatory-cli your-domain.com --format report',

      // Final gate
      '23. Review all HIGH/CRITICAL findings; create tickets for each; do not ship with open criticals',
      '24. Add security scan steps to CI pipeline so every PR is checked automatically',
    ],
    patterns: [
      'Shift-left security: scan in CI on every PR, not only before release',
      'Defence in depth: layered scanning (dependency + static + dynamic)',
      'Fail-fast: non-zero CI exit code on any high/critical finding',
      'Security-as-code: Semgrep rules and ZAP configs version-controlled alongside application',
    ],
    gotchas: [
      'npm audit reports transitive dependency vulnerabilities — check if exploitable in your code path before panicking',
      'Semgrep false positives on test files — add --exclude "tests/" to production scans',
      'ZAP baseline scan covers only unauthenticated paths — run a full scan with an auth script for coverage',
      'Gitleaks detects secrets committed at any point in history, not just HEAD — clean git history with git-filter-repo if needed',
      'Snyk requires authentication for full CVE database access — set SNYK_TOKEN in CI secrets',
    ],
    resources: [
      'https://owasp.org/www-project-top-ten/',
      'https://owasp.org/www-project-zap/',
      'https://semgrep.dev/p/owasp-top-ten',
      'https://github.com/gitleaks/gitleaks',
      'https://snyk.io/docs/snyk-cli/',
      'https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html',
      'https://docs.npmjs.com/cli/v10/commands/npm-audit',
      'https://observatory.mozilla.org/',
    ],
  };
}
