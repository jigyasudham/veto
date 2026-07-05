// UX Designer — user flows, simplicity, real-user experience
import type { AgentVote } from './types.js';
import { extractDecision, pickSide, reframeVote } from './decision-extractor.js';

// Backend-only tasks: UX approves without friction
const BACKEND_ONLY = /\b(api|backend|server|database|db|query|schema|migration|auth.*middleware|jwt|oauth|cron|cli|script|worker|queue|cache|redis|sql|index|trigger|webhook)\b/i;
const FRONTEND_SIGNALS = /\b(ui|ux|form|button|modal|page|screen|component|view|layout|menu|nav|input|field|label|error.?message|loading|user.?interface|frontend|react|vue|svelte|html|css)\b/i;

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /window\.alert\s*\(|window\.confirm\s*\(/i,
    reason: 'window.alert/confirm blocks the page and cannot be styled. Users hate it.',
    recommendation: 'Replace with toast notifications (react-hot-toast) or inline dialogs.',
  },
  {
    pattern: /no.{0,20}error.{0,20}(message|state|feedback).{0,30}(form|submit|input)/i,
    reason: 'Forms without error feedback leave users confused and drive support tickets.',
    recommendation: 'Add inline validation messages for every field that can fail.',
  },
  {
    pattern: /(?:7|8|9|10|eleven|twelve).{0,15}step/i,
    reason: 'More than 6 steps in a flow loses 70%+ of users before completion.',
    recommendation: 'Break into smaller flows or use progressive disclosure.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /no.{0,15}(mobile|responsive|viewport)/i,
    concern: '60%+ of users are on mobile. Responsive is baseline, not a bonus.',
    recommendation: 'Mobile-first CSS. Test breakpoints: 375px, 768px, 1280px.',
  },
  {
    pattern: /no.{0,15}(loading|spinner|progress|skeleton)/i,
    concern: 'Missing loading state — users cannot tell if their action registered.',
    recommendation: 'Show loading indicator for any operation that takes >300ms.',
  },
  {
    pattern: /\bmodal\b|\bpopup\b|\bdialog\b/i,
    concern: 'Modals interrupt flow and fail on small screens. Use sparingly.',
    recommendation: 'Reserve modals for destructive confirmations only. Use inline for everything else.',
  },
  {
    pattern: /no.{0,15}(accessib|aria|a11y|wcag)/i,
    concern: 'Missing accessibility — 15% of users cannot use the product.',
    recommendation: 'Add aria-labels, keyboard nav, focus management. Test with VoiceOver.',
  },
  {
    pattern: /color.{0,20}only|rely.{0,15}on.{0,15}color/i,
    concern: '8% of users are colorblind — color-only signals are invisible to them.',
    recommendation: 'Add icons, patterns, or text alongside color to convey meaning.',
  },
  {
    pattern: /no.{0,15}(empty.?state|zero.?state|first.?time)/i,
    concern: 'No empty state — first-time users see a blank screen that looks broken.',
    recommendation: 'Design empty state that explains what goes here and how to start.',
  },
  {
    pattern: /no.{0,15}(confirm|confirmation|undo|undo.?redo)/i,
    concern: 'Destructive action without confirmation leads to user data loss.',
    recommendation: 'Add confirmation dialog for destructive actions. Provide undo where possible.',
  },
  {
    pattern: /auto.?submit|submit.{0,10}without.{0,10}(confirm|review)/i,
    concern: 'Auto-submitting without user review removes user agency.',
    recommendation: 'Always let users review before final submission.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no UX concerns.', concerns: [] };
  }

  // Pure backend tasks get a light pass — but still apply decision stance
  const isBackend = BACKEND_ONLY.test(task) && !FRONTEND_SIGNALS.test(task);
  if (isBackend) {
    const backendVote: AgentVote = {
      verdict: 'approve',
      reason: 'Backend task — no direct UX concerns. Ensure API errors surface clearly to users.',
      concerns: [],
    };
    return applyDecisionStance(backendVote, task);
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

  // Topic-based UX analysis for tasks with no direct frontend signals
  const TOPIC_INSIGHTS: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
    {
      pattern: /cli|terminal|command.?line|help|flag|arg/i,
      concern: 'CLI UX is still UX. Commands that give no feedback on success, have inconsistent flag names, or print walls of unformatted text drive users to abandon the tool.',
      recommendation: 'Every CLI command needs: success/fail output, consistent flag naming (kebab-case), and color-coded status (green/red/yellow). Test with a first-time user.',
    },
    {
      pattern: /error|message|feedback|output|response/i,
      concern: 'Technical error messages like "TypeError: Cannot read property of undefined" tell the developer nothing actionable. Users want to know what to do, not what went wrong internally.',
      recommendation: 'Every user-facing error must include: what failed, why it failed (if knowable), and what the user should do next. Never expose stack traces.',
    },
    {
      pattern: /install|setup|init|onboard|first.?run/i,
      concern: 'Onboarding friction is the leading cause of tool abandonment. Every extra step in setup loses 20–30% of users. The first experience must succeed or users never return.',
      recommendation: 'Time-box the happy path setup to under 2 minutes. Every step must have a clear success indicator. Provide a single copy-paste command that does everything.',
    },
    {
      pattern: /vscode|extension|sidebar|panel|button/i,
      concern: 'VS Code extensions that clutter the UI with too many buttons and panels feel like bloatware. Users uninstall extensions that are visually noisy.',
      recommendation: 'Default to minimal UI: one status bar item. Expand to sidebar only when user explicitly enables it. Follow VS Code\'s own design patterns and icon conventions.',
    },
    {
      pattern: /tool.?count|tool.?list|discover/i,
      concern: 'A large tool surface requires users to read documentation before they can use the product. No tool is valuable if users can\'t discover it exists.',
      recommendation: 'Provide a discovery entry point and make it the first thing users learn. Consider surfacing "most useful for your current task" recommendations automatically.',
    },
    {
      pattern: /wait|loading|slow|latency|timeout/i,
      concern: 'Operations that take more than 300ms with no feedback feel broken to users. For LLM-backed operations (2–30s), silence is indistinguishable from a crash.',
      recommendation: 'Show progress for any operation over 500ms. For long operations, stream partial results or show a "working..." status. Never leave the user in silence.',
    },
  ];

  let vote: AgentVote;

  if (blocks.length > 0) {
    vote = {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: blocks.slice(1).map(b => b.reason),
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  } else if (concerns.length > 0) {
    vote = {
      verdict: 'warn',
      reason: `${concerns.length} UX concern${concerns.length > 1 ? 's' : ''} — real users will notice this.`,
      concerns,
      recommendation: recommendations[0],
    };
  } else {
    // Topic matches are non-voting advice — a topical observation is not a
    // found UX problem and must not move the verdict.
    const topicMatched = TOPIC_INSIGHTS.filter(t => t.pattern.test(task));
    if (topicMatched.length > 0) {
      const top = topicMatched.slice(0, 2);
      vote = {
        verdict: 'approve',
        reason: 'UX looks solid. No user experience concerns identified.',
        concerns: [],
        advice: top.map(t => `${t.concern} → ${t.recommendation}`).join('\n'),
      };
    } else {
      vote = { verdict: 'approve', reason: 'UX looks solid. No user experience concerns identified.', concerns: [] };
    }
  }

  return applyDecisionStance(vote, task);
}

// UX risk: options that add setup friction, credentials, or configuration overhead
const UX_RISK = /\b(http|api.?key|auth|oauth|port|server\s+config|credentials|token|setup.{0,15}required|install.{0,15}extra)\b/i;

function applyDecisionStance(vote: AgentVote, task: string): AgentVote {
  const ctx = extractDecision(task);
  if (!ctx.isDecisionTask) return vote;
  const { optionA, optionB } = ctx;
  const side = pickSide(optionA, optionB, UX_RISK);
  const advice = side
    ? `"${side.preferred}" keeps the developer experience simpler — no extra setup or credentials. "${side.avoided}" adds friction that will silently reduce adoption.`
    : `Evaluate which option requires fewer steps for a first-time user. The shorter happy path wins on developer experience.`;
  return reframeVote(vote, ctx, side?.preferred ?? null, advice);
}
