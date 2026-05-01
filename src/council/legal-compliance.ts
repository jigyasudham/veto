// Legal & Compliance — licenses, data privacy, GDPR, ToS, IP, regulatory
import type { AgentVote } from './types.js';

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /\b(gpl|gnu.?general.?public.?license)\b/i,
    reason: 'GPL code in a non-GPL project creates license contamination — entire project must become GPL.',
    recommendation: 'Audit all dependencies with license-checker. Replace GPL deps with MIT/Apache/BSD alternatives.',
  },
  {
    pattern: /\bagpl\b/i,
    reason: 'AGPL requires open-sourcing any server code users interact with over a network.',
    recommendation: 'Either make your code AGPL, obtain a commercial license, or replace the AGPL dependency.',
  },
  {
    pattern: /collect.{0,40}(personal|pii|email|phone|address).{0,40}no.{0,20}consent/i,
    reason: 'Collecting personal data without consent violates GDPR Article 6 and CCPA — fines up to 4% global revenue.',
    recommendation: 'Add explicit consent collection before gathering PII. Document legal basis (contract, consent, legitimate interest).',
  },
  {
    pattern: /\b(hipaa|phi|protected.?health|health.?record)\b/i,
    reason: 'Health data (PHI) requires HIPAA-compliant infrastructure, signed BAAs, and mandatory audit logging.',
    recommendation: 'Use a HIPAA-compliant cloud provider. Sign Business Associate Agreements. Encrypt PHI at rest and in transit.',
  },
  {
    pattern: /collect.{0,30}(children|child|minor|under.{0,5}1[23])/i,
    reason: 'Collecting data from under-13s without verifiable parental consent violates COPPA (US) and GDPR.',
    recommendation: 'Add age gate. Obtain verifiable parental consent. Consult legal counsel before proceeding.',
  },
  {
    pattern: /store.{0,30}(credit.?card|card.?number|\bpan\b|\bcvv\b|\bcvc\b)/i,
    reason: 'Storing raw card data requires PCI-DSS Level 1 compliance — years of audits and millions in infrastructure.',
    recommendation: "Never store raw card data. Use Stripe/Braintree tokenization. Your PCI scope drops to SAQ-A.",
  },
  {
    pattern: /scrape.{0,30}(facebook|twitter|linkedin|instagram|google|youtube|amazon)/i,
    reason: 'Scraping major platforms violates their ToS and has led to multi-million dollar lawsuits (hiQ v. LinkedIn).',
    recommendation: 'Use official APIs only. Review ToS data-use clauses. Seek legal opinion if data has commercial value.',
  },
  {
    pattern: /train.{0,40}(model|ai|ml|llm).{0,40}(user.?data|customer.?data|without.{0,15}consent)/i,
    reason: 'Training AI/ML on user data without consent violates GDPR and the ToS of most data platforms.',
    recommendation: 'Obtain explicit opt-in consent for ML training use. Provide opt-out. Document data flows in privacy policy.',
  },
  {
    pattern: /\b(biometric|facial.?recogni|fingerprint).{0,30}(store|collect|process)\b/i,
    reason: 'Biometric data has strict consent laws: BIPA (Illinois), GDPR Article 9, TX/WA state laws.',
    recommendation: 'Obtain explicit written consent. Check state/country-specific laws. Consider if biometrics are necessary at all.',
  },
  {
    pattern: /\bccpa\b.{0,30}(ignore|skip|bypass|not.{0,10}(apply|need))/i,
    reason: 'CCPA applies to any business serving California residents above certain thresholds — not opt-in.',
    recommendation: 'Add "Do Not Sell My Personal Information" link. Honor opt-out requests within 15 days.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /no.{0,25}privacy.?policy/i,
    concern: 'Collecting any user data without a privacy policy violates GDPR, CCPA, and most app store guidelines.',
    recommendation: 'Draft a privacy policy covering: what you collect, why, how long, who you share with, user rights.',
  },
  {
    pattern: /log.{0,25}(email|ip.?address|phone|full.?name|ssn)|(email|phone|full.?name|ssn).{0,25}(log|plaintext|plain.?text)/i,
    concern: 'Logging PII creates data retention liability and complicates right-to-erasure compliance.',
    recommendation: 'Pseudonymize PII in logs (hash emails, truncate IPs). Set log retention to 30-90 days maximum.',
  },
  {
    pattern: /no.{0,20}(delete|erasure|right.?to.?delete|data.?removal|forget)/i,
    concern: 'GDPR Article 17 mandates honoring right-to-erasure requests within 30 days.',
    recommendation: 'Build user data deletion endpoint. Cascade to backups. Document deletion confirmation process.',
  },
  {
    pattern: /open.?source|npm.{0,20}install|pip.{0,20}install|composer|cargo.{0,20}add/i,
    concern: 'New dependencies may carry GPL/AGPL licenses that contaminate your project license.',
    recommendation: 'Run license-checker or FOSSA after adding deps. Block GPL/AGPL in CI for proprietary projects.',
  },
  {
    pattern: /cookie|tracking|analytics|pixel|beacon/i,
    concern: 'Cookies and tracking pixels require consent banners for EU/UK users (ePrivacy Directive + GDPR).',
    recommendation: 'Integrate consent management platform (Cookiebot, OneTrust) for EU users.',
  },
  {
    pattern: /third.?party.{0,30}(share|send|forward|transmit).{0,30}(user|personal|customer)/i,
    concern: 'Sharing personal data with third parties requires disclosure in privacy policy and may need consent.',
    recommendation: 'List all third-party data recipients in privacy policy. Sign Data Processing Agreements (DPAs).',
  },
  {
    pattern: /retain.{0,30}(forever|indefinitely|no.?limit|no.?expiry)|store.{0,30}forever/i,
    concern: 'Retaining personal data indefinitely violates GDPR storage limitation principle (Article 5(1)(e)).',
    recommendation: 'Define retention periods per data type. Auto-delete or anonymize after the period expires.',
  },
  {
    pattern: /\b(trademark|patent|copyright)\b/i,
    concern: 'IP risk flagged — verify you have rights to use and distribute this.',
    recommendation: 'Confirm licensing rights. Consult an IP attorney if building on patented methods or using third-party branding.',
  },
  {
    pattern: /\b(gdpr|data.?protection)\b.{0,30}(ignore|bypass|skip|not.{0,10}(apply|worry))/i,
    concern: "GDPR applies to any service used by EU residents regardless of where you're based.",
    recommendation: 'Conduct a GDPR compliance review. Appoint a Data Protection Officer if required.',
  },
  {
    pattern: /export.{0,20}(encryption|crypto|cipher).{0,20}(us|usa|america|international)/i,
    concern: 'Exporting encryption software may require US export license (EAR/ECCN classification).',
    recommendation: 'Check ECCN classification for your encryption strength. File annual self-classification if needed.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no legal concerns.', concerns: [] };
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
      reason: `${concerns.length} legal or compliance concern${concerns.length > 1 ? 's' : ''} — review before shipping.`,
      concerns,
      recommendation: recommendations[0],
    };
  }

  return { verdict: 'approve', reason: 'No legal or compliance issues detected.', concerns: [] };
}
