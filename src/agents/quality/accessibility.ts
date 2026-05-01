import { AgentPlan, AgentAnalysis, AgentFinding, WorkerAgentType } from '../types.js';

export function plan(task: string, context?: string): AgentPlan {
  return {
    agent: 'accessibility' as WorkerAgentType,
    task,
    tier: 2,
    approach: 'Audit against WCAG 2.1 AA — the legal minimum for most jurisdictions. Work through four principles: Perceivable (can users perceive all content?), Operable (can users navigate with keyboard and assistive tech?), Understandable (is the UI predictable and error-recovery clear?), Robust (does it work with screen readers and future tech?). Flag failures by WCAG criterion number.',
    steps: [
      'Check colour contrast: text must meet 4.5:1 (normal) or 3:1 (large text) against background — WCAG 1.4.3',
      'Check all images have alt text — decorative images use alt="" — WCAG 1.1.1',
      'Check all form inputs have associated <label> elements — WCAG 1.3.1',
      'Check the entire UI is keyboard-navigable: Tab order is logical, no keyboard traps — WCAG 2.1.1',
      'Check focus indicator is visible on all interactive elements — WCAG 2.4.7',
      'Check no content flashes more than 3 times per second — WCAG 2.3.1',
      'Check page has a descriptive <title> — WCAG 2.4.2',
      'Check heading hierarchy: h1→h2→h3, no levels skipped — WCAG 1.3.1',
      'Check error messages identify the field and explain how to fix — WCAG 3.3.1',
      'Check interactive elements have accessible names (aria-label where needed) — WCAG 4.1.2',
      'Test with a screen reader (NVDA/VoiceOver) on the critical path',
    ],
    checklist: [
      '[ ] Colour contrast ≥ 4.5:1 for normal text, 3:1 for large text',
      '[ ] All images have meaningful alt text',
      '[ ] All form inputs have visible labels',
      '[ ] Full keyboard navigation — no mouse required',
      '[ ] Visible focus indicator on all interactive elements',
      '[ ] No flashing content > 3 Hz',
      '[ ] Logical heading hierarchy',
      '[ ] Error messages identify field + explain fix',
      '[ ] Screen reader tested on critical path',
    ],
    pitfalls: [
      'Using colour alone to convey information — 8% of men have colour vision deficiency',
      'Placeholder text as a label substitute — placeholder disappears when typing',
      'Custom interactive components without ARIA roles — screen readers see a div, not a button',
      'Positive contrast ratio on a design tool that does not account for anti-aliasing',
      'Fixing accessibility at end of development — 10× more expensive than building it in',
    ],
    patterns: [
      'POUR framework: Perceivable → Operable → Understandable → Robust',
      'Keyboard-first development: if it works with keyboard only, it usually works with everything',
      'Semantic HTML over ARIA: a <button> is better than a <div role="button">',
      'Error recovery: every error must name the field and tell the user exactly how to fix it',
    ],
    duration_estimate: '2-6 hours',
  };
}

export function analyze(code: string, context?: string): AgentAnalysis {
  const findings: AgentFinding[] = [];

  if (/<img(?![^>]*\balt=)/i.test(code)) {
    findings.push({ severity: 'high', category: 'WCAG-1.1.1', description: 'Image(s) missing alt attribute', fix: 'Add alt="description" to all <img> tags. Use alt="" for decorative images.' });
  }

  if (/<input(?![^>]*\btype="hidden")[^>]*>(?![\s\S]*?<label)/i.test(code) && !/<label/i.test(code)) {
    findings.push({ severity: 'high', category: 'WCAG-1.3.1', description: 'Form input(s) may lack associated label', fix: 'Add <label for="inputId"> or wrap input in <label>.' });
  }

  if (/onClick|onclick/.test(code) && !/<button|role="button"/i.test(code)) {
    findings.push({ severity: 'medium', category: 'WCAG-2.1.1', description: 'Click handler on non-interactive element — may not be keyboard accessible', fix: 'Use <button> for click interactions, or add role="button" tabIndex={0} and onKeyDown handler.' });
  }

  if (/:focus\s*\{[^}]*outline\s*:\s*none/i.test(code) || /:focus\s*\{[^}]*outline\s*:\s*0/i.test(code)) {
    findings.push({ severity: 'high', category: 'WCAG-2.4.7', description: 'Focus outline suppressed — keyboard users lose navigation indicator', fix: 'Remove outline:none from :focus. Use outline:none on :focus-visible only with a custom focus style.' });
  }

  if (/<h[1-6]/i.test(code)) {
    const headings = (code.match(/<h([1-6])/gi) ?? []).map(h => parseInt(h[2]));
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] - headings[i - 1] > 1) {
        findings.push({ severity: 'medium', category: 'WCAG-1.3.1', description: `Heading level skipped: h${headings[i - 1]} → h${headings[i]}`, fix: 'Heading levels must be sequential. Do not skip levels.' });
        break;
      }
    }
  }

  if (/aria-label|aria-labelledby|role=/i.test(code)) {
    if (/role="presentation"|role="none"/i.test(code) && /<img/i.test(code)) {
      findings.push({ severity: 'low', category: 'WCAG-1.1.1', description: 'Image with role="presentation" — verify this is truly decorative', fix: 'If decorative, use alt="". If informative, remove role="presentation" and add meaningful alt.' });
    }
  }

  const critCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const score = Math.max(0, 100 - critCount * 30 - highCount * 20 - findings.filter(f => f.severity === 'medium').length * 10);

  return {
    agent: 'accessibility' as WorkerAgentType,
    subject: context ?? 'UI code',
    findings,
    score,
    verdict: score >= 85 ? 'approved' : score >= 65 ? 'approved_with_warnings' : score >= 40 ? 'needs_revision' : 'rejected',
    summary: findings.length === 0 ? 'No accessibility issues detected in static analysis. Manual screen reader test still recommended.' : `${findings.length} accessibility issue(s). Top: ${findings[0].description}`,
    critical_count: critCount,
    high_count: highCount,
  };
}
