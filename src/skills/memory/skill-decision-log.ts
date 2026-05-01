// Skill: decision-log — guide to logging architectural and design decisions

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

const TEMPLATE = `
// ── Decision Log Entry ────────────────────────────────────────────────────
//
// Use this template for any decision that is:
//   - Non-obvious (a reasonable engineer could choose differently)
//   - Hard to reverse (schema changes, API contracts, auth architecture)
//   - Frequently re-discussed (keeps relitigating the same debate)
//   - A deliberate trade-off (performance vs correctness, simplicity vs flexibility)
//
{
  "id": "ADR-001",                        // Sequential ID for referencing
  "title": "Use JWT with rotating refresh tokens for authentication",
  "status": "accepted",                   // proposed | accepted | deprecated | superseded-by:ADR-xxx
  "date": "2026-05-01",
  "deciders": ["agent:auth", "human:alice"],

  "context": "We need an authentication mechanism for a stateless REST API that will be consumed by a mobile app and a web SPA. Session cookies are not ideal for the mobile client.",

  "decision": "Implement stateless JWTs for access (15-minute TTL) with rotating refresh tokens stored server-side in a database table.",

  "rationale": "JWTs allow stateless verification on every request without a DB lookup. Refresh token rotation limits the window of token theft. httpOnly cookies for refresh tokens prevent XSS access.",

  "alternatives": [
    {
      "option": "Server-side sessions with Redis",
      "pros": ["Instant revocation", "No JWT complexity"],
      "cons": ["Requires Redis infrastructure", "Not stateless — every request hits Redis", "Mobile clients struggle with cookie-based sessions"],
      "rejected_because": "Adds Redis dependency; poor fit for mobile client"
    },
    {
      "option": "Long-lived JWTs with no refresh",
      "pros": ["Simple implementation"],
      "cons": ["Cannot revoke without infrastructure", "Long-lived tokens are a large attack window"],
      "rejected_because": "Unacceptable security risk if token is stolen"
    }
  ],

  "consequences": {
    "positive": [
      "Stateless verification — no DB lookup per request",
      "Refresh token rotation limits theft window to 15 minutes",
      "Mobile and web clients use the same auth mechanism"
    ],
    "negative": [
      "Access tokens cannot be revoked before expiry (15-minute window)",
      "Requires refresh token table with periodic cleanup job",
      "More complex than simple sessions"
    ],
    "neutral": [
      "JWT library (jsonwebtoken) must be kept up to date for security patches"
    ]
  },

  "references": [
    "OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html",
    "RFC 6749 OAuth 2.0 Bearer Tokens",
    "Related implementation: src/services/auth.service.ts"
  ]
}
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'decision-log',
    template: TEMPLATE,
    checklist: [
      'Log the decision as soon as it is made — memory fades quickly and context is lost',
      'Assign a sequential ID (ADR-001, ADR-002) to enable referencing in code comments and PRs',
      'Write the context section first: describe the forces and constraints that made a choice necessary',
      'State the decision explicitly and unambiguously — one clear sentence of what was decided',
      'Document the rationale: why this option over the alternatives?',
      'List at least two alternatives that were genuinely considered, not just strawmen',
      'For each alternative, record pros, cons, and the specific reason it was rejected',
      'Document positive, negative, and neutral consequences of the chosen option',
      'Set the status field: proposed → accepted → deprecated or superseded-by:ADR-xxx',
      'Add file references so future engineers can find the implementation',
      'Reference the decision ID in relevant code comments: // See ADR-001',
      'Store the decision log in docs/decisions/ or as a session memory entry',
      'Update the status to "deprecated" or "superseded" when the decision changes — never delete',
      'Review the decision log when revisiting a design — check if the original constraints still apply',
    ],
    patterns: [
      'Architecture Decision Record (ADR) format: context → decision → rationale → alternatives → consequences',
      'Decision-in-context: link from code to the decision that explains the design choice',
      'Living document: update status when decisions change rather than deleting entries',
      'Lightweight ADR: one file per decision, stored in git alongside the code it describes',
    ],
    gotchas: [
      'Writing the decision without the rationale — future engineers will not know why, only what',
      'Only documenting the chosen option without listing alternatives — looks like no thought went into it',
      'Not updating stale decisions — a deprecated decision still marked "accepted" causes confusion',
      'Writing the ADR after the fact with the benefit of hindsight — capture the original thinking at decision time',
      'Logging trivial decisions — reserve the log for non-obvious choices; not every variable name needs an ADR',
    ],
    resources: [
      'https://adr.github.io/ (Architectural Decision Records overview)',
      'https://github.com/joelparkerhenderson/architecture-decision-record (templates and examples)',
      'https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions (original Michael Nygard post)',
      'https://www.thoughtworks.com/radar/techniques/lightweight-architecture-decision-records',
    ],
  };
}
