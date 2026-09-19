// Consent v2 for Harvest-and-Share (council 320c40dc, legal conditions): it
// names both flows, across projects and between AI vendors, is OFF by default,
// and no upgrade can switch it on. Only the user can accept it, typing "yes"
// in a terminal of their own: a command an AI runs is refused, so no AI can
// turn sharing on for them (owner decision, 2026-09-19).

import { enableLessonsSharing } from '../memory/config.js';
import { syncLessonSources, type LessonSyncReport } from './harvest.js';
import { lessonFlows, lessonsStatus, unresolvedFolders } from './manage.js';

/**
 * What each AI CLI sets in the environment of the commands it runs.
 * CLAUDECODE and AI_AGENT are set by Claude Code (checked on this machine);
 * GEMINI_CLI by Gemini CLI's shell tool; the CODEX_ ones by Codex's sandboxed
 * and npm-launched runs. A real terminal is required as well, so a marker a
 * host does not set is not the only line of defence.
 */
export const AI_SESSION_MARKERS = ['CLAUDECODE', 'AI_AGENT', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM'] as const;

/** The marker showing an AI is running this command, or null in the user's own terminal. */
export function detectAiSession(env: NodeJS.ProcessEnv = process.env): string | null {
  return AI_SESSION_MARKERS.find(name => (env[name] ?? '') !== '') ?? null;
}

/** The disclosure shown before the user accepts. Changing what it promises means bumping LESSONS_CONSENT_VERSION. */
export function lessonsDisclosure(): string {
  return [
    'What you are turning on: sharing between your AIs\' notes',
    '',
    'Claude, Codex and Gemini each keep notes in their own memory (Claude\'s',
    'memory folders, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md). With sharing on,',
    'Veto passes those notes on where they help:',
    '',
    '  • ACROSS YOUR PROJECTS: a note about you or this computer, written while',
    '    you worked on one project, can be shared into your other projects.',
    '  • BETWEEN AIs: a note one AI wrote can be shared with the others, so a',
    '    note Claude wrote can reach Codex and Gemini, and the other way round.',
    '    A note given to an AI goes to that AI\'s company as part of your',
    '    conversation, like anything else you send it.',
    '',
    'What Veto does, and does not do:',
    '  • It only reads those memory files. It never changes or deletes them.',
    '  • It keeps a copy of each note in its own database on this computer,',
    '    with email addresses, your home folder and anything that looks like a',
    '    password or key removed first. Veto itself uploads nothing.',
    '  • A note stays in its own project if it is about that project, or if it',
    '    contains a command, a web address, a credential or an instruction to',
    '    fetch, send or run something. Notes about secrets or personal details',
    '    never leave their project.',
    '  • A shared note is marked as information from another AI session, never',
    '    as an instruction to follow.',
    '',
    'For now this is a trial: Veto reads the notes and records which ones it',
    'would have shared, but gives none of them to any AI yet.',
    '',
    'You stay in control:',
    '  veto lessons list          every note Veto has read',
    '  veto lessons why <id>      one note, where it came from, where it may go',
    '  veto lessons forget <id>   stop one note for good',
    '  veto lessons exclude       keep the current project out entirely',
    '  veto lessons off           turn sharing off and delete everything Veto copied',
  ].join('\n');
}

export type ConsentSummary = {
  report: LessonSyncReport;
  notes: number;
  projects: number;
  anyProject: number;
  ownProject: number;
  unlinked: number;
  byHost: Record<'claude' | 'codex' | 'gemini', number>;
  disabledHosts: string[];
};

/** Record consent, read every AI's memory once, and summarise what was found. */
export function acceptLessonsConsent(home?: string): ConsentSummary {
  enableLessonsSharing();
  const report = syncLessonSources(home);
  const status = lessonsStatus();
  const flows = lessonFlows();
  return {
    report,
    notes: status.notes,
    projects: new Set(flows.filter(f => !f.projectIdentity.startsWith('global:')).map(f => f.projectIdentity)).size,
    anyProject: status.anyProject,
    ownProject: flows.reduce((sum, f) => sum + f.ownProject + f.nowhere, 0),
    unlinked: unresolvedFolders().length,
    byHost: status.byHost,
    disabledHosts: [...status.disabledHosts.keys()],
  };
}
