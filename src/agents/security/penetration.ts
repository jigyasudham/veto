import type { AgentPlan } from '../types.js';

// ─── System-type detection ─────────────────────────────────────────────────

type SystemType = 'web-api' | 'web-frontend' | 'auth-system' | 'file-upload' | 'generic';

function detectSystemType(task: string): SystemType {
  const t = task.toLowerCase();
  if (/\bfile\s*upload\b|multipart|multer|form[\s-]?data|attachment/.test(t)) return 'file-upload';
  if (/\bauth(?:entication)?\b|login|signin|password|oauth|session|jwt|mfa/.test(t)) return 'auth-system';
  if (/\bapi\b|rest(?:ful)?|graphql|endpoint|route|swagger/.test(t)) return 'web-api';
  if (/\bfrontend\b|react|vue|angular|spa|browser|html|dom/.test(t)) return 'web-frontend';
  return 'generic';
}

// ─── Data maps ────────────────────────────────────────────────────────────

const APPROACH: Record<SystemType, string> = {
  'web-api':
    'Map all API endpoints, enumerate authentication requirements, then systematically test auth bypass, ' +
    'IDOR, injection, SSRF, rate limiting, header security, and CORS misconfiguration.',
  'web-frontend':
    'Enumerate all user-controlled input surfaces and event handlers, then test for XSS, CSRF, ' +
    'clickjacking, open redirect, content injection, and client-side storage misuse.',
  'auth-system':
    'Attack the authentication surface: attempt brute force, account enumeration via timing/response ' +
    'differences, session fixation, token prediction, MFA bypass, and password reset flaws.',
  'file-upload':
    'Test file type validation bypass, path traversal via filename, execution of uploaded content, ' +
    'storage disclosure, and denial of service via large or malformed files.',
  generic:
    'Apply a full-scope penetration test methodology: reconnaissance, threat modelling, vulnerability ' +
    'scanning, exploitation, and post-exploitation reporting.',
};

const STEPS: Record<SystemType, string[]> = {
  'web-api': [
    'Reconnaissance: enumerate endpoints via OpenAPI spec, JS bundles, and forced browsing',
    'Authentication bypass: test unauthenticated access to every endpoint',
    'Broken Object Level Authorisation (BOLA/IDOR): replace IDs with other users\' IDs',
    'Broken Function Level Authorisation: access admin/privileged endpoints as low-privilege user',
    'SQL injection: test string/integer parameters with single quotes and UNION payloads',
    'NoSQL injection: inject {"$gt": ""} into JSON body parameters',
    'Command injection: test parameters used in file paths or shell commands',
    'Mass assignment: send undocumented fields (role, isAdmin) in POST/PUT body',
    'SSRF: submit internal URLs (http://169.254.169.254, http://localhost) to URL-accepting parameters',
    'Rate limiting: send 100+ requests/second to auth and sensitive endpoints',
    'Security headers: verify CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy',
    'CORS: check for wildcard origin or reflection of Origin header with credentials',
    'Verbose errors: trigger 500 errors and check for stack traces in the response body',
    'JWT attacks: test alg:none, weak secrets (brute force HS256), RS/HS confusion',
  ],
  'web-frontend': [
    'Reflected XSS: inject <script>alert(1)</script> into every URL parameter and form field',
    'Stored XSS: submit XSS payloads in persistent fields (username, bio, comments)',
    'DOM-based XSS: review JavaScript for innerHTML, document.write, eval with user data',
    'CSRF: submit state-changing requests without CSRF token from a cross-origin page',
    'Clickjacking: embed the page in an iframe; check for X-Frame-Options or CSP frame-ancestors',
    'Open redirect: test redirect parameters with https://evil.com as the value',
    'Client-side template injection: inject {{7*7}} into Angular/Handlebars templates',
    'HTML injection: inject <img src=x onerror=alert(1)> into reflected fields',
    'localStorage secret exposure: check stored tokens via browser devtools',
    'postMessage attacks: look for unvalidated message event listeners',
    'Content-Security-Policy bypass: look for unsafe-inline, unsafe-eval, or overly broad sources',
    'Sensitive data in URL: check query strings for tokens, passwords, or PII',
    'Third-party script integrity: verify Subresource Integrity (SRI) on CDN scripts',
  ],
  'auth-system': [
    'Username enumeration: compare response time/body for valid vs invalid usernames',
    'Password brute force: attempt 10,000 common passwords; verify rate limiting and lockout',
    'Account lockout bypass: vary IP (X-Forwarded-For), vary username case, distribute attempts',
    'Session fixation: set a known session ID before login; check if it is preserved post-auth',
    'Concurrent session attack: log in twice; verify previous session is invalidated if not intended',
    'Session token prediction: collect 100 session tokens and test for sequential or low-entropy patterns',
    'Token reuse after logout: capture a JWT/session token; log out; replay the token',
    'Password reset poisoning: manipulate Host header or forward headers to poison reset link',
    'MFA bypass: attempt to skip MFA step by directly calling authenticated endpoints',
    'OAuth state forgery: replay a used authorisation code or tamper with the state parameter',
    'JWT algorithm confusion: change RS256 to HS256 and sign with the public key',
    'Privilege escalation via JWT claims: modify role claim in an unsigned/weak-signature token',
    'Remember-me token hijacking: extract persistent cookie value and replay from a new session',
    'Account takeover via email change: change email without re-authentication or verification',
  ],
  'file-upload': [
    'MIME type bypass: upload a PHP/JSP/ASP file with image/jpeg content type',
    'Extension bypass: test double extension (shell.php.jpg), null byte (shell.php%00.jpg)',
    'Magic bytes bypass: prepend valid image magic bytes to a server-side script',
    'Path traversal via filename: submit ../../../etc/passwd as the filename',
    'Zip slip: upload a zip archive with ../ entries that extract outside the target directory',
    'Stored XSS via SVG: upload an SVG file containing <script> or onload handler',
    'XXE via XML upload: upload an XML/XLSX/DOCX with an external entity reference',
    'RCE via server-side script execution: upload a script to a web-accessible directory',
    'Storage disclosure: guess or enumerate upload paths to access other users\' files',
    'Denial of service via upload: send a very large file, a zip bomb, or a decompression bomb',
    'SSRF via image processing: supply a URL-based image src pointing to internal services',
    'Metadata exfiltration: upload an image with EXIF data and verify the server strips it',
  ],
  generic: [
    'Reconnaissance: passive (WHOIS, DNS, Shodan) and active (port scan, banner grab)',
    'Threat modelling: identify assets, entry points, trust boundaries, and threat actors',
    'Vulnerability scanning: run automated scanner (Nessus, OpenVAS, ZAP, Burp Suite)',
    'Authentication testing: brute force, bypass, session management flaws',
    'Injection testing: SQL, NoSQL, OS command, LDAP, template, XML injection',
    'Broken access control testing: IDOR, privilege escalation, path traversal',
    'Cryptographic testing: weak ciphers, certificate validation, key exposure',
    'Insecure direct object references: enumerate and swap resource IDs',
    'Security misconfiguration: default credentials, verbose errors, open admin interfaces',
    'Sensitive data exposure: HTTP traffic, logs, error messages, client-side storage',
    'API security: undocumented endpoints, mass assignment, improper rate limiting',
    'Network-level: open ports, unnecessary services, firewall bypass, DNS zone transfer',
    'Post-exploitation: lateral movement, persistence, data exfiltration paths',
    'Reporting: CVSS scoring, business impact assessment, remediation priority ranking',
  ],
};

const CHECKLIST: Record<SystemType, string[]> = {
  'web-api': [
    'All endpoints require valid authentication token',
    'IDOR test: swapping another user\'s ID returns 403, not the resource',
    'Admin endpoints return 403 to non-admin authenticated users',
    'SQL injection payloads in all parameters return no data or 400, not 500',
    'eval() and shell execution with user input are absent',
    'Internal URLs submitted to URL parameters are blocked',
    'Auth endpoints respond with 429 after 10 rapid requests',
    'CORS: only listed domains can send credentialed requests',
    'Security headers present on all API responses',
    'Error responses contain a generic message, not stack traces',
    'JWT alg:none and HS/RS confusion attacks are rejected',
    'Mass assignment: undocumented fields are ignored, not persisted',
    'GraphQL introspection disabled in production',
    'Verbose error messages disabled; internal paths not exposed',
  ],
  'web-frontend': [
    'All user input is HTML-escaped before insertion into the DOM',
    'Content-Security-Policy header present and does not contain unsafe-inline',
    'X-Frame-Options: DENY or CSP frame-ancestors \'none\' present',
    'All state-changing requests require a CSRF token or SameSite=Strict cookie',
    'Redirect parameters validate against an allow-list of trusted destinations',
    'No sensitive data (tokens, PII) stored in localStorage or sessionStorage',
    'postMessage listeners validate event origin before processing',
    'SRI hashes present on all CDN-loaded scripts and stylesheets',
    'No Angular/Handlebars/Mustache template injection vectors',
    'Referrer-Policy header limits cross-origin referrer information',
  ],
  'auth-system': [
    'Username enumeration: identical response for valid and invalid usernames',
    'Rate limiting enforced: 10 attempts per IP per 15 minutes on login',
    'Account lockout after 5 failures; lockout is resolvable via email',
    'Session ID changes on login (fixation prevention)',
    'Old session invalidated after password change',
    'JWT tokens are rejected after logout (revocation list or short TTL)',
    'Password reset links expire after 1 hour and are single-use',
    'MFA cannot be skipped by directly calling authenticated endpoints',
    'Session tokens are at least 128 bits of entropy',
    'HTTPS enforced; HSTS header with includeSubDomains present',
    'OAuth state parameter required and validated on callback',
    'JWT alg is explicitly set server-side; alg:none is rejected',
  ],
  'file-upload': [
    'Accepted MIME types validated server-side against an allow-list',
    'File extension validated against an allow-list (not a deny-list)',
    'Magic bytes checked for image uploads using a file type library',
    'Uploaded files stored outside the web root or in a dedicated blob store',
    'Filenames sanitised: path components stripped, UUID used as stored name',
    'File size limit enforced server-side (not only client-side)',
    'Uploaded files served with Content-Disposition: attachment to prevent execution',
    'SVG uploads sanitised or served from a separate origin',
    'Zip archives unpacked with path traversal protection',
    'EXIF metadata stripped from images before storage',
    'Anti-virus or malware scanning integrated into the upload pipeline',
    'Upload directory not publicly accessible via direct URL',
  ],
  generic: [
    'Attack surface fully enumerated and documented',
    'All high/critical severity findings remediated before go-live',
    'Automated scanner (Burp/ZAP) run with active scanning enabled',
    'Manual testing performed for logic flaws not detectable by scanners',
    'Authentication and session management tested end-to-end',
    'All injection categories tested across every input parameter',
    'Network exposure reviewed: only required ports open externally',
    'Security misconfiguration check: no default credentials, no test pages in production',
    'Finding report includes CVSS score and business impact for each issue',
    'Remediation verification: re-test each finding after fix is deployed',
    'Executive summary and technical report produced',
    'Penetration test signed off by security lead before production release',
  ],
};

const PITFALLS: Record<SystemType, string[]> = {
  'web-api': [
    'Testing only the happy path — attackers focus on error paths and edge cases',
    'Stopping at authentication bypass without testing authorisation (IDOR)',
    'Not testing GraphQL or WebSocket endpoints alongside REST',
    'Missing business logic flaws that automated scanners cannot detect',
  ],
  'web-frontend': [
    'Only testing XSS in visible input fields — DOM-based XSS lives in JavaScript',
    'Assuming a CSP header prevents all XSS — test for bypasses (unsafe-inline, JSONP endpoints)',
    'Not testing in multiple browsers — DOM behaviour differs',
    'Overlooking postMessage and custom event handlers as injection points',
  ],
  'auth-system': [
    'Testing only the login page — password reset, OAuth callback, and MFA endpoints are also in scope',
    'Not testing for timing side-channels in username validation',
    'Assuming short-lived JWTs are safe — test for claims manipulation',
    'Not verifying lockout bypass via header manipulation (X-Forwarded-For)',
  ],
  'file-upload': [
    'Relying solely on the Content-Type header — trivially spoofed by attackers',
    'Only testing common extensions — test double extensions, Unicode normalisation tricks',
    'Not testing what happens when the virus scanner is bypassed by a partial/corrupt file',
    'Forgetting to test the download/serve path for path traversal',
  ],
  generic: [
    'Automated scanning without manual follow-up — scanners have high false-negative rates for logic flaws',
    'Testing in a staging environment that differs significantly from production',
    'Not scoping the test clearly — risk of legal exposure if boundaries are unclear',
    'Producing findings without risk-ranked remediation guidance',
  ],
};

const PATTERNS: Record<SystemType, string[]> = {
  'web-api': ['OWASP API Security Top 10', 'BOLA/IDOR testing matrix', 'Burp Suite active scan + manual auth testing'],
  'web-frontend': ['OWASP Testing Guide — Client-Side Testing', 'CSP evaluation methodology', 'Browser-based XSS polyglot testing'],
  'auth-system': ['OWASP Authentication Cheat Sheet verification', 'Session token entropy analysis', 'Timing attack measurement with wrk/hey'],
  'file-upload': ['OWASP File Upload Cheat Sheet', 'Magic-byte bypass library (file-type npm)', 'Zip slip detection via extraction simulation'],
  generic: ['OWASP Testing Guide v4', 'PTES (Penetration Testing Execution Standard)', 'CVSSv3.1 severity scoring'],
};

// ─── Public API ────────────────────────────────────────────────────────────

export function plan(task: string, context?: string): AgentPlan {
  const systemType = detectSystemType(task);

  const tierMap: Record<SystemType, 1 | 2 | 3> = {
    'web-api': 3,
    'web-frontend': 2,
    'auth-system': 3,
    'file-upload': 2,
    generic: 3,
  };

  const durationMap: Record<SystemType, string> = {
    'web-api': '1-2 days',
    'web-frontend': '4-8 hours',
    'auth-system': '1-2 days',
    'file-upload': '4-6 hours',
    generic: '3-5 days',
  };

  return {
    agent: 'penetration',
    task,
    tier: tierMap[systemType],
    approach: APPROACH[systemType],
    steps: STEPS[systemType],
    checklist: CHECKLIST[systemType],
    pitfalls: PITFALLS[systemType],
    patterns: PATTERNS[systemType],
    duration_estimate: context?.includes('full-scope') ? '5-10 days' : durationMap[systemType],
  };
}
