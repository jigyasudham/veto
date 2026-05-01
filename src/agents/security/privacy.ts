import type { AgentPlan } from '../types.js';

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
