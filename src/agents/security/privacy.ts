import type { AgentPlan, AgentAnalysis, AgentFinding, FindingSeverity } from '../types.js';

// ─── Data-type detection ───────────────────────────────────────────────────

type PrivacyScenario =
  | 'registration'
  | 'analytics'
  | 'export'
  | 'deletion'
  | 'third-party'
  | 'general';

function detectScenario(task: string): PrivacyScenario {
  const t = task.toLowerCase();
  if (/\bregist(?:er|ration)\b|sign[\s-]?up|create\s+account/.test(t)) return 'registration';
  if (/\banalytics\b|tracking|telemetry|metrics|pageview/.test(t)) return 'analytics';
  if (/\bexport\b|download\s+data|portability|data\s+request/.test(t)) return 'export';
  if (/\bdelet(?:e|ion)\b|right\s+to\s+erasure|forget|purge|wipe/.test(t)) return 'deletion';
  if (/\bthird[\s-]?party\b|integration|external\s+service|vendor|processor/.test(t)) return 'third-party';
  return 'general';
}

// ─── Approach map ──────────────────────────────────────────────────────────

const APPROACH: Record<PrivacyScenario, string> = {
  registration:
    'Collect only the minimum data required for registration. Obtain informed, granular consent before processing. Apply retention limits from day one.',
  analytics:
    'Implement privacy-by-default analytics: anonymise IPs, honour Do-Not-Track, provide opt-out, and avoid cross-site tracking.',
  export:
    'Implement the right to data portability: deliver all user data in a machine-readable format within the required time window.',
  deletion:
    'Implement the right to erasure: permanently delete or anonymise all user data, including backups and third-party processor copies, within 30 days.',
  'third-party':
    'Ensure all third-party data processors have a signed Data Processing Agreement (DPA) and adequate safeguards for data transfers.',
  general:
    'Apply GDPR/CCPA privacy principles: lawfulness, fairness, transparency, purpose limitation, data minimisation, accuracy, storage limits, integrity, and accountability.',
};

// ─── Steps map ────────────────────────────────────────────────────────────

const STEPS: Record<PrivacyScenario, string[]> = {
  registration: [
    'Define the legal basis for processing each data field (consent, contract, legitimate interest)',
    'Present a clear, plain-language consent form with separate opt-ins per purpose',
    'Collect only fields strictly necessary for the service (data minimisation)',
    'Set retention period per data category in the data inventory',
    'Implement double opt-in for marketing communications',
    'Store consent record with timestamp, version, and IP',
    'Link to privacy policy and cookie policy at registration',
    'Provide account settings to update or withdraw consent',
    'Trigger automated data deletion or anonymisation at retention expiry',
  ],
  analytics: [
    'Audit all analytics scripts for third-party data sharing',
    'Implement consent management platform (CMP) with granular cookie categories',
    'Block analytics scripts until consent is granted',
    'Anonymise IP addresses before sending to analytics provider (e.g., GA anonymizeIp)',
    'Set analytics data retention to minimum required (e.g., 14 months max)',
    'Honour Do-Not-Track (DNT) header in custom analytics code',
    'Provide a clear opt-out mechanism accessible from every page',
    'Avoid fingerprinting techniques (canvas, audio, font enumeration)',
    'Test that analytics is inactive until consent is recorded',
  ],
  export: [
    'Identify all data stores that contain user-specific data',
    'Build an aggregation service that joins all user data from each store',
    'Output data in a machine-readable format: JSON or CSV minimum',
    'Respond to export requests within 30 days (GDPR) or 45 days (CCPA)',
    "Verify the requesting user's identity before delivering the export",
    'Deliver export via secure, time-limited download link (not email attachment)',
    'Log export requests with timestamp and requester identity',
    'Include a data dictionary explaining each exported field',
  ],
  deletion: [
    'Map all tables and data stores that hold user data (data map)',
    'Implement cascade delete from user ID across all related tables',
    'Replace user identifiers in analytics/log records with anonymous placeholder',
    'Submit deletion requests to all third-party processors within 7 days',
    'Schedule purge of backups containing user data within the backup retention period',
    'Verify user identity before processing deletion request',
    'Send confirmation email once deletion is complete',
    'Log deletion requests and completion timestamps for regulatory records',
    'Test that no user data remains accessible after deletion via API or DB query',
  ],
  'third-party': [
    'Maintain an inventory of all third-party data processors and sub-processors',
    'Obtain a signed Data Processing Agreement (DPA) from each processor',
    'Verify that processors maintain adequate safeguards (SOC 2, ISO 27001, or SCCs for EU transfers)',
    'Implement Standard Contractual Clauses (SCCs) for transfers outside the EEA',
    'Minimise data shared with third parties to what they strictly require',
    'Review processor sub-processor lists annually',
    'Include processor list in the privacy policy',
    'Implement contractual audit rights and breach notification obligations',
    'Test that data deleted from primary store is also deleted from processors',
  ],
  general: [
    'Conduct a Data Protection Impact Assessment (DPIA) for high-risk processing',
    'Appoint a Data Protection Officer (DPO) if required by scale or data type',
    'Publish a clear, up-to-date privacy policy',
    'Implement consent management for all non-essential processing',
    'Maintain a Record of Processing Activities (RoPA)',
    'Define and enforce data retention periods per category',
    'Implement all data subject rights: access, rectification, erasure, portability, objection',
    'Establish a breach notification procedure (72-hour GDPR window)',
    'Conduct annual privacy training for all staff who handle personal data',
  ],
};

// ─── Checklist map ────────────────────────────────────────────────────────

const CHECKLIST: Record<PrivacyScenario, string[]> = {
  registration: [
    'Consent is explicit, granular, and obtained before processing starts',
    'Consent record stored with timestamp, version, and IP address',
    'Only fields necessary for the stated purpose are collected',
    'Privacy policy linked at registration with plain-language summary',
    'Marketing opt-in is a separate, unchecked checkbox',
    'Double opt-in implemented for email marketing',
    'Retention period defined and enforced for each data category',
    'Automated deletion or anonymisation triggered at retention expiry',
    'Users can view and withdraw consent from their account settings',
    'Data breach notification procedure documented and tested',
    'DPIA conducted if processing sensitive categories of data',
    'Sub-processors listed in privacy policy',
  ],
  analytics: [
    'Consent management platform (CMP) implemented and tested',
    'Analytics scripts blocked until explicit consent is granted',
    'IP addresses anonymised before transmission to analytics provider',
    'Analytics data retention set to 14 months maximum',
    'Do-Not-Track (DNT) header honoured in custom scripts',
    'Clear opt-out link present on every page',
    'No cross-site tracking (third-party cookies) without separate consent',
    'Analytics vendor DPA signed and stored',
    'Cookie audit performed; no undisclosed cookies present',
    'Privacy policy updated to list analytics cookies and their purpose',
    'Users can withdraw analytics consent and data is not collected retroactively',
    'Fingerprinting techniques absent from the codebase',
  ],
  export: [
    'All user data stores identified and included in export',
    'Export generated within 30 days of verified request',
    'Identity verification required before export delivery',
    'Export delivered via secure, time-limited download link',
    'Export format is machine-readable (JSON/CSV)',
    'Data dictionary included explaining each field',
    'Export request and delivery logged with timestamp',
    'Export excludes data about third parties embedded in user records',
    'Large exports split into manageable archive files',
    'Automated end-to-end test confirms export completeness',
    'Privacy policy describes the export right and the request process',
    'Requests acknowledged within 72 hours even if processing takes longer',
  ],
  deletion: [
    'All data stores with user data identified in the data map',
    'Cascade delete implemented across all related tables',
    'Analytics and log records anonymised (not deleted) to preserve aggregate stats',
    'Third-party processors notified within 7 days',
    'Backup purge scheduled within backup retention window',
    'Identity verification required before deletion is processed',
    'Confirmation email sent to user on completion',
    'Deletion request and completion timestamp logged',
    'Automated test verifies no user data accessible after deletion',
    'Right to erasure exceptions documented (legal hold, fraud prevention)',
    'Privacy policy explains erasure right and any applicable exceptions',
    'Requests processed within 30-day GDPR statutory window',
  ],
  'third-party': [
    'Data processor inventory maintained and kept current',
    'Signed DPA on file for every processor',
    'SCCs in place for transfers outside the EEA',
    'Sub-processor list published in privacy policy',
    'Data minimisation applied to third-party data shares',
    'Processors audited annually (questionnaire or certification review)',
    'Breach notification clause in every DPA (72-hour escalation)',
    'Audit rights clause in every DPA',
    'Processors instructed to delete data on contract termination',
    'Third-party scripts reviewed for unexpected data collection',
    'Privacy policy updated when new processors are added',
    'DPIA updated when new high-risk processors are engaged',
  ],
  general: [
    'Data Protection Impact Assessment (DPIA) completed for high-risk processing',
    'Record of Processing Activities (RoPA) maintained and current',
    'Privacy policy published, accurate, and written in plain language',
    'Consent mechanism implemented for all non-essential processing',
    'All six data subject rights implemented: access, rectification, erasure, restriction, portability, objection',
    'Breach notification procedure tested (72-hour GDPR window)',
    'Data retention periods defined and automated enforcement in place',
    'Staff privacy training conducted annually',
    'DPO appointed if required; contact details published',
    'Privacy-by-design documented in system architecture decisions',
    'Cookie banner compliant: no pre-ticked boxes, easy to reject',
    'CCPA opt-out of sale link present if applicable',
    "Children's data (under 16) not collected without parental consent",
    'Sensitive data categories (health, biometric, etc.) identified and protected with additional safeguards',
  ],
};

// ─── Pitfall and pattern maps ─────────────────────────────────────────────

const PITFALLS: Record<PrivacyScenario, string[]> = {
  registration: [
    'Pre-ticking marketing consent checkboxes — invalid consent under GDPR',
    'Bundling consent with terms of service — consent must be freely given and separate',
    'Collecting date of birth without age verification logic',
    'Not storing the consent record — cannot prove lawfulness later',
  ],
  analytics: [
    'Loading Google Analytics before consent — sets cookies and sends data illegally',
    'Using analytics data for purposes not disclosed in the privacy policy',
    'Treating analytics as "legitimate interest" without a balancing test',
    'Not removing analytics data when a user opts out retrospectively',
  ],
  export: [
    'Sending export to the wrong email address — data breach',
    "Including other users' data in the export (e.g., shared records)",
    'Generating the export synchronously — times out for large accounts',
    'Omitting data held in third-party processors from the export',
  ],
  deletion: [
    'Deleting user record but leaving orphaned rows in related tables',
    'Not deleting from search indexes and caches',
    'Forgetting to notify third-party processors',
    'Treating deletion and anonymisation as equivalent without considering the re-identification risk',
  ],
  'third-party': [
    'Assuming cloud providers (AWS, GCP) are automatically GDPR-compliant — SCCs still required for US data transfers',
    'Not reviewing sub-processor lists — processors may engage additional parties',
    'Sharing more user data than the processor needs',
    'Failing to update the privacy policy when onboarding new processors',
  ],
  general: [
    'Treating GDPR as a one-time compliance project rather than an ongoing process',
    'Using legitimate interest as a catch-all basis without a documented balancing test',
    'Ignoring CCPA if users are based in California but company is not US-registered',
    'Not having a documented response procedure for data subject requests',
  ],
};

const PATTERNS: Record<PrivacyScenario, string[]> = {
  registration: ['Consent-first data collection', 'Data minimisation at source', 'Retention-period-as-code'],
  analytics: ['Consent-gated script loading', 'Privacy-preserving analytics (server-side aggregation)', 'Opt-out-first design'],
  export: ['Async export job with secure delivery', 'Data aggregation service pattern', 'Identity verification before sensitive operations'],
  deletion: ['Cascade delete with audit trail', 'Anonymisation as delete alternative for analytics', 'Third-party propagation queue'],
  'third-party': ['Processor register with DPA tracking', 'Data minimisation at integration boundary', 'Contractual breach escalation chain'],
  general: ['Privacy by design and by default', 'Data subject rights as first-class API endpoints', 'DPIA for high-risk processing decisions'],
};

// ─── Public API ────────────────────────────────────────────────────────────

export function plan(task: string, context?: string): AgentPlan {
  const scenario = detectScenario(task);

  const tierMap: Record<PrivacyScenario, 1 | 2 | 3> = {
    registration: 2,
    analytics: 2,
    export: 2,
    deletion: 2,
    'third-party': 3,
    general: 1,
  };

  const durationMap: Record<PrivacyScenario, string> = {
    registration: '3-5 hours',
    analytics: '2-4 hours',
    export: '4-6 hours',
    deletion: '4-8 hours',
    'third-party': '6-10 hours',
    general: '2-3 hours',
  };

  return {
    agent: 'privacy',
    task,
    tier: tierMap[scenario],
    approach: APPROACH[scenario],
    steps: STEPS[scenario],
    checklist: CHECKLIST[scenario],
    pitfalls: PITFALLS[scenario],
    patterns: PATTERNS[scenario],
    duration_estimate: context?.includes('enterprise') ? '2-4 weeks' : durationMap[scenario],
  };
}

// ─── PII / privacy check patterns ──────────────────────────────────────────
//
// Scope: personal-data EXPOSURE risks (GDPR/CCPA), deliberately distinct from
// the `secrets` agent (credentials) and `security-scanner` (OWASP injection/authz).
// Checks are ordered by priority — one finding per source line (first match wins).

interface PrivacyCheck {
  regex: RegExp;
  severity: FindingSeverity;
  category: string;
  description: string;
  fix: string;
  cwe?: string;
}

const CHECKS: PrivacyCheck[] = [
  // Personal data written to logs — the single most common privacy leak.
  {
    regex: /(?:console\.(?:log|info|warn|error|debug)|logger?\.\w+|log\.\w+)\s*\([^)]*\b(?:e-?mail|ssn|social_?security|passport|phone|dob|date_?of_?birth|first_?name|last_?name|full_?name|home_?address|credit_?card)\b/i,
    severity: 'high',
    category: 'PII in Logs',
    description: 'Personal data appears to be written to logs — logs are often retained, shipped to third parties, and searchable.',
    fix: 'Never log personal data. Log an opaque user id instead, or redact PII fields before passing them to the logger.',
    cwe: 'CWE-532',
  },
  // Real US Social Security Number literal in source.
  {
    regex: /\b\d{3}-\d{2}-\d{4}\b/,
    severity: 'high',
    category: 'Hardcoded PII',
    description: 'A value matching a US Social Security Number (NNN-NN-NNNN) is present in source.',
    fix: 'Remove real personal data from source and tests. Use clearly-synthetic fixtures (e.g. 000-00-0000).',
    cwe: 'CWE-359',
  },
  // Payment card number literal (Visa / Mastercard / Amex).
  {
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/,
    severity: 'high',
    category: 'Hardcoded PII',
    description: 'A value matching a payment-card number is present in source (PCI-DSS scope).',
    fix: 'Never store raw card numbers. Use a PCI-compliant processor token; keep synthetic PANs out of source.',
    cwe: 'CWE-359',
  },
  // Personal data forwarded to analytics / third-party SDKs.
  {
    regex: /(?:analytics|mixpanel|amplitude|segment|posthog|gtag|fbq|heap)\s*[.(][^;]{0,120}\b(?:e-?mail|ssn|phone|full_?name|user_?email)\b/i,
    severity: 'medium',
    category: 'PII Shared With Third Party',
    description: 'Personal data appears to be sent to an analytics or third-party SDK, which usually requires a lawful basis and a DPA.',
    fix: 'Pseudonymise before sending (hash/opaque id), obtain consent, and confirm a Data Processing Agreement covers the field.',
    cwe: 'CWE-359',
  },
  // Special-category (Art. 9) / health data handling.
  {
    regex: /\b(?:diagnosis|medical_?record|health_?record|patient_?data|biometric|fingerprint_?data|genetic|ethnicity|religion|sexual_?orientation)\b/i,
    severity: 'medium',
    category: 'Special Category Data (GDPR Art. 9)',
    description: 'Special-category personal data is referenced — it carries stricter consent and safeguarding obligations.',
    fix: 'Require explicit consent, encrypt at rest, restrict access, and document the Art. 9 processing condition.',
    cwe: 'CWE-359',
  },
  // Analytics/tracking initialised with no visible consent gate.
  {
    regex: /\b(?:gtag\s*\(\s*['"]config['"]|fbq\s*\(\s*['"]init['"]|ga\s*\(\s*['"]create['"])/,
    severity: 'medium',
    category: 'Tracking Without Consent',
    description: 'A tracking pixel/analytics tag is initialised directly — under ePrivacy it must be gated behind opt-in consent.',
    fix: 'Load tracking only after the user grants consent via a consent-management platform; block it by default.',
    cwe: 'CWE-359',
  },
  // PII placed in a URL / query string (leaks into logs, referrers, history).
  {
    regex: /[?&](?:e-?mail|ssn|phone|dob|full_?name)=/i,
    severity: 'medium',
    category: 'PII in URL',
    description: 'Personal data is passed in a URL query string, which leaks into server logs, browser history and Referer headers.',
    fix: 'Move personal data out of the URL into a POST body or an opaque token.',
    cwe: 'CWE-598',
  },
  // PII persisted to browser storage.
  {
    regex: /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*['"][^'"]*(?:e-?mail|ssn|phone|full_?name|dob)[^'"]*['"]/i,
    severity: 'low',
    category: 'PII in Client Storage',
    description: 'Personal data is stored in browser storage, which is unencrypted and readable by any script on the page.',
    fix: 'Keep PII server-side keyed by an opaque session id; store only non-identifying flags in the browser.',
    cwe: 'CWE-359',
  },
  // Analytics explicitly configured NOT to anonymise IPs.
  {
    regex: /anonymize_?ip\s*[:=]\s*false/i,
    severity: 'low',
    category: 'Analytics IP Not Anonymised',
    description: 'IP anonymisation is explicitly disabled — the full IP is personal data under GDPR.',
    fix: 'Enable IP anonymisation (e.g. anonymize_ip: true) or avoid collecting the full address.',
    cwe: 'CWE-359',
  },
];

// ─── Analysis API ──────────────────────────────────────────────────────────

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const check of CHECKS) {
      if (check.regex.test(line)) {
        const finding: AgentFinding = {
          severity: check.severity,
          category: check.category,
          description: check.description,
          fix: check.fix,
          location: `line ${i + 1}`,
        };
        if (check.cwe) finding.cwe = check.cwe;
        findings.push(finding);
        break; // one finding per line — highest-priority check wins
      }
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
      ? `No personal-data exposure risks detected in ${subject}. Score: ${score}/100.`
      : `Found ${findings.length} privacy issue(s) in ${subject}: ${critical} critical, ${high} high, ${medium} medium, ${low} low. Score: ${score}/100 — ${verdict.replace(/_/g, ' ')}.`;

  return {
    agent: 'privacy',
    subject,
    findings,
    score,
    verdict,
    summary,
    critical_count: critical,
    high_count: high,
  };
}
