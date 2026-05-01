import type { AgentPlan } from '../types.js';

// ─── Auth-type detection ───────────────────────────────────────────────────

type AuthType = 'jwt' | 'oauth' | 'session' | 'rbac' | 'mfa' | 'general';

function detectAuthType(task: string): AuthType {
  const t = task.toLowerCase();
  if (/\bjwt\b|json\s*web\s*token|refresh\s*token/.test(t)) return 'jwt';
  if (/\boauth\b|oauth2|openid|pkce|authorization\s*code/.test(t)) return 'oauth';
  if (/\bsession\b|cookie\s*auth|server[\s-]?side\s*session/.test(t)) return 'session';
  if (/\brbac\b|role[\s-]?based|permission|access\s*control/.test(t)) return 'rbac';
  if (/\bmfa\b|multi[\s-]?factor|totp|authenticator|2fa/.test(t)) return 'mfa';
  return 'general';
}

// ─── Checklist builders ────────────────────────────────────────────────────

const JWT_CHECKLIST = [
  'Hash passwords with bcrypt (cost factor 12) before storing',
  'Sign JWTs with RS256 (asymmetric) or HS256 with ≥256-bit secret',
  'Set short access token expiry (15 minutes recommended)',
  'Implement refresh token rotation: issue a new refresh token on every use',
  'Store refresh tokens in the database and invalidate on logout',
  'Store access tokens in memory only; deliver via httpOnly Secure cookies where possible',
  'Never store JWTs in localStorage — XSS vulnerable',
  'Validate alg header server-side; reject "none" algorithm',
  'Verify iss, aud, exp, iat claims on every request',
  'Implement token revocation list or short-TTL approach for logout',
  'Apply rate limiting to /login, /token, and /refresh endpoints',
  'Lock account after 5 consecutive failed login attempts; require email unlock',
  'Log every successful and failed authentication attempt with IP and user-agent',
  'Enforce password complexity: 12+ chars, mixed case, numbers, symbols',
  'Provide a secure password reset flow: time-limited single-use token sent to verified email',
];

const OAUTH_CHECKLIST = [
  'Use PKCE (Proof Key for Code Exchange) for all public clients (SPAs, mobile apps)',
  'Generate and verify a random state parameter to prevent CSRF',
  'Store OAuth tokens server-side; never expose client_secret in frontend code',
  'Validate the redirect_uri exactly against a pre-registered allow-list',
  'Use the authorization_code flow; never implicit flow for new implementations',
  'Scope tokens to the minimum permissions required by the application',
  'Exchange the authorisation code for tokens server-side only',
  'Store access tokens in httpOnly cookies or a secure backend session',
  'Implement token refresh before expiry; handle refresh failures gracefully',
  'Validate the id_token signature and claims (iss, aud, exp, nonce)',
  'Bind the nonce in the id_token to the session nonce to prevent replay',
  "Revoke tokens on logout via the provider's revocation endpoint",
  'Log all token issuance, refresh, and revocation events',
  'Rotate client_secret periodically and after any suspected exposure',
  'Enable provider-side suspicious-login alerts and enforce MFA at the IdP level',
];

const SESSION_CHECKLIST = [
  'Set session cookies with Secure, httpOnly, and SameSite=Strict attributes',
  'Regenerate session ID on login to prevent session fixation',
  'Regenerate session ID on privilege elevation (e.g., sudo confirmation)',
  'Set absolute session timeout (e.g., 8 hours) and idle timeout (e.g., 30 minutes)',
  'Store session data server-side (Redis, DB); never in the cookie itself',
  'Sign or encrypt session data if stored client-side (use express-session + iron-session)',
  'Invalidate all sessions on password change',
  'Hash passwords with bcrypt (cost factor 12)',
  'Apply rate limiting to login endpoint',
  'Lock account after repeated failures; send email alert to account owner',
  'Log session creation, expiry, and logout events with IP and timestamp',
  'Implement CSRF protection for all state-changing requests (double-submit cookie or synchroniser token)',
  'Expire password reset tokens after 1 hour and invalidate after use',
  'Never transmit session IDs in URLs — use cookies only',
  'Run session store cleanup job to purge expired sessions',
];

const RBAC_CHECKLIST = [
  'Define roles as discrete, named sets of permissions (e.g., admin, editor, viewer)',
  'Assign roles to users, not permissions directly — avoid permission explosion',
  'Enforce authorisation checks at the service layer, not only the UI layer',
  'Use a middleware factory: requireRole("admin") applied to protected routes',
  'Store roles in the database; load at session start; never trust client-supplied role',
  'Implement resource-level ownership check in addition to role check (IDOR prevention)',
  'Principle of least privilege: default to no access; grant explicitly',
  'Audit all role assignments and revocations with actor, timestamp, and reason',
  'Provide an admin interface to view and modify role assignments',
  'Cache user permissions per request (not globally) to avoid stale privilege',
  'Test permission boundaries: verify low-privilege users cannot access high-privilege routes',
  'Implement deny-list for critical operations (e.g., delete user requires two-person approval)',
  'Document the permission matrix in a roles.md or OpenAPI security scheme',
  'Re-validate permissions on every sensitive operation, not only at login time',
];

const MFA_CHECKLIST = [
  'Implement TOTP (RFC 6238) using a well-audited library (otplib, speakeasy)',
  'Generate a unique 80-bit (base32-encoded) secret per user during enrolment',
  'Display QR code and allow manual key entry during setup; verify before saving',
  'Require MFA confirmation before saving the MFA secret (prevent lock-out attacks)',
  'Store MFA secret encrypted at rest; never log it',
  'Generate 8–10 single-use backup codes on enrolment; hash them before storing',
  'Apply a short time window (±30 seconds, 1 step) for TOTP validation',
  'Rate-limit TOTP attempts: 5 failures lock MFA for 15 minutes',
  'Allow account recovery via verified backup code + email confirmation',
  'Log every MFA event: enrolment, verification, failure, backup-code use',
  'Send email notification when MFA is disabled or backup codes are regenerated',
  'Enforce re-authentication before sensitive operations (delete account, change email)',
  'Support WebAuthn / passkeys as a stronger alternative to TOTP',
  'Periodically prompt users to verify their MFA device is still accessible',
];

const GENERAL_CHECKLIST = [
  'Hash all passwords with bcrypt (cost factor 12) or argon2id',
  'Never store plaintext passwords, even temporarily',
  'Use HTTPS everywhere; redirect HTTP to HTTPS; set HSTS header',
  'Implement account lockout after 5 failed attempts (exponential backoff)',
  'Rate-limit all authentication endpoints (login, register, reset)',
  'Use secure, random session IDs or JWTs with short expiry',
  'Regenerate session ID on every privilege change',
  'Protect against CSRF with SameSite cookies or CSRF token pattern',
  'Store tokens in httpOnly, Secure cookies, not localStorage',
  'Implement a secure password reset flow: single-use, time-limited, email-verified token',
  'Send email notifications on password change and suspicious login',
  'Log all auth events (login, logout, failure) with IP, timestamp, user-agent',
  'Enforce strong password policy or passphrase with minimum entropy',
  'Implement MFA as an option (or requirement for privileged accounts)',
  'Run dependency audit (npm audit) to catch auth library CVEs',
];

// ─── Pattern maps ──────────────────────────────────────────────────────────

const APPROACH_MAP: Record<AuthType, string> = {
  jwt: 'Implement a stateless JWT auth system with short-lived access tokens, rotating refresh tokens, and httpOnly cookie storage.',
  oauth: 'Implement OAuth 2.0 with PKCE for public clients, state parameter for CSRF prevention, and server-side token storage.',
  session: 'Implement secure server-side sessions with session fixation prevention, absolute/idle timeouts, and SameSite cookie protection.',
  rbac: 'Design a role-based access control system with least-privilege defaults, resource-level ownership checks, and audit logging.',
  mfa: 'Add TOTP-based multi-factor authentication with backup codes, rate limiting, and account recovery flow.',
  general: 'Implement a comprehensive authentication system following OWASP Authentication Cheat Sheet guidance.',
};

const STEPS_MAP: Record<AuthType, string[]> = {
  jwt: [
    'Set up user model with hashed password field (bcrypt)',
    'Implement /register endpoint with input validation and duplicate check',
    'Implement /login endpoint: verify password, issue access + refresh tokens',
    'Store refresh tokens in the database with userId, token hash, expiry, revoked flag',
    'Implement token verification middleware that validates access token on every protected route',
    'Implement /refresh endpoint: validate refresh token, rotate it, issue new access token',
    'Implement /logout endpoint: revoke refresh token in DB, clear cookies',
    'Add rate limiting middleware to /login and /refresh',
    'Add account lockout logic after repeated failures',
    'Write integration tests covering happy path, expired token, revoked token, lockout',
  ],
  oauth: [
    'Register application with OAuth provider and store client_id and client_secret in env vars',
    'Implement /auth/start: generate state + PKCE code_verifier, store in session, redirect to provider',
    'Implement /auth/callback: verify state, exchange code for tokens using PKCE verifier',
    'Store access and refresh tokens server-side; set a session cookie',
    'Implement token refresh middleware that silently refreshes before expiry',
    'Implement /auth/logout: revoke tokens at provider, destroy session',
    'Validate id_token claims: iss, aud, exp, nonce',
    'Map provider user profile to local user record (create or update)',
    'Write integration tests for callback, state mismatch, and token expiry scenarios',
  ],
  session: [
    'Configure session middleware with Secure, httpOnly, SameSite=Strict cookie settings',
    'Implement /register with bcrypt password hashing (cost 12)',
    'Implement /login: verify password, regenerate session ID, set session data',
    'Implement /logout: destroy session, clear session cookie',
    'Add CSRF middleware (csurf or synchroniser token pattern)',
    'Configure absolute and idle session timeouts in session store',
    'Add rate limiting to /login',
    'Implement account lockout and email alert on suspicious activity',
    'Write tests for session fixation prevention, timeout, and CSRF rejection',
  ],
  rbac: [
    'Define role enum and permission list; document in roles config file',
    'Add role field to user model with default value of least-privileged role',
    'Create requireRole(role) middleware that checks req.user.role',
    'Create requireOwnership(getResource) middleware for resource-level checks',
    'Apply role middleware to all protected routes',
    'Build admin endpoint to assign/revoke roles with audit logging',
    'Write tests for each role boundary: ensure lower roles cannot access higher-role routes',
  ],
  mfa: [
    'Add mfa_secret (encrypted) and mfa_enabled fields to user model',
    'Implement /mfa/setup: generate secret, return QR code URI to frontend',
    'Implement /mfa/verify-setup: validate TOTP code, save secret, generate backup codes',
    'Implement /mfa/challenge: post-password-check step, require TOTP code',
    'Add rate limiting and lockout to /mfa/challenge',
    'Implement /mfa/backup: accept backup code (hash-compare), mark used',
    'Implement /mfa/disable: require password + current TOTP, log the event',
    'Write tests for valid TOTP, expired TOTP, brute-force lockout, backup code use',
  ],
  general: [
    'Choose and implement appropriate token/session strategy',
    'Hash passwords with bcrypt (cost 12)',
    'Set up login, register, logout, password-reset endpoints',
    'Add rate limiting and account lockout',
    'Configure secure cookie settings',
    'Add audit logging for all auth events',
    'Write comprehensive auth integration tests',
  ],
};

const PITFALLS_MAP: Record<AuthType, string[]> = {
  jwt: [
    'Setting long access token expiry (hours/days) — defeats the purpose of short-lived tokens',
    'Not rotating refresh tokens on use — stolen token can be used indefinitely',
    'Accepting "alg":"none" — bypass all signature verification',
    'Storing JWTs in localStorage — exposed to XSS attacks',
  ],
  oauth: [
    'Omitting the state parameter — open to CSRF attacks on the OAuth flow',
    'Not using PKCE for public clients — authorization code interception',
    'Logging the OAuth access token or storing it client-side',
    'Not validating the redirect_uri strictly — open redirect attack',
  ],
  session: [
    'Not regenerating session ID on login — session fixation vulnerability',
    'Missing SameSite cookie attribute — CSRF risk',
    'Storing sensitive data in the cookie directly — tamper risk without signing/encryption',
    'No idle timeout — abandoned sessions persist indefinitely',
  ],
  rbac: [
    'Trusting client-supplied role value — privilege escalation',
    'Checking role only at the route level, not the data layer — IDOR still possible',
    'Overly broad roles — violates least-privilege principle',
    'Caching permissions globally across requests — stale privilege after role change',
  ],
  mfa: [
    'Allowing too large a time window for TOTP — makes brute force easier',
    'Not rate-limiting TOTP attempts — allows exhaustive code search',
    'Storing backup codes in plaintext — leaks allow full bypass',
    'Not revoking MFA secret on account recovery — prior device retains access',
  ],
  general: [
    'Using MD5 or SHA-1 for password hashing — trivially reversible',
    'Implementing custom cryptography — use established libraries only',
    'Sending password in plaintext over HTTP',
    'Not invalidating sessions on password change',
  ],
};

const PATTERNS_MAP: Record<AuthType, string[]> = {
  jwt: ['Stateless JWT with rotating refresh tokens', 'httpOnly cookie token delivery', 'Token revocation via database allowlist/denylist'],
  oauth: ['Authorization Code + PKCE flow', 'State + nonce CSRF prevention', 'Server-side token storage proxy'],
  session: ['Server-side session with Redis store', 'Double-submit CSRF cookie', 'Session fixation prevention via regenerate()'],
  rbac: ['Middleware-based role enforcement', 'Resource ownership predicate', 'Least-privilege default with explicit grants'],
  mfa: ['TOTP (RFC 6238) with backup codes', 'Step-up authentication for sensitive operations', 'Enrolment verification before commitment'],
  general: ['Defence in depth: multiple auth layers', 'Principle of least privilege', 'Fail-secure: deny by default'],
};

// ─── Public API ────────────────────────────────────────────────────────────

export function plan(task: string, context?: string): AgentPlan {
  const authType = detectAuthType(task);

  const checklistMap: Record<AuthType, string[]> = {
    jwt: JWT_CHECKLIST,
    oauth: OAUTH_CHECKLIST,
    session: SESSION_CHECKLIST,
    rbac: RBAC_CHECKLIST,
    mfa: MFA_CHECKLIST,
    general: GENERAL_CHECKLIST,
  };

  const tierMap: Record<AuthType, 1 | 2 | 3> = {
    jwt: 3, oauth: 3, session: 3, rbac: 3, mfa: 3, general: 3,
  };

  const durationMap: Record<AuthType, string> = {
    jwt: '4-6 hours',
    oauth: '6-10 hours',
    session: '3-5 hours',
    rbac: '4-6 hours',
    mfa: '6-8 hours',
    general: '2-4 hours',
  };

  return {
    agent: 'auth',
    task,
    tier: tierMap[authType],
    approach: APPROACH_MAP[authType],
    steps: STEPS_MAP[authType],
    checklist: checklistMap[authType],
    pitfalls: PITFALLS_MAP[authType],
    patterns: PATTERNS_MAP[authType],
    duration_estimate: context?.includes('complex') ? '8-12 hours' : durationMap[authType],
  };
}
