import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ContextGuidanceResult = {
  geminiMemorySkipped: boolean;
  codexOverrideSkipped: boolean;
  projectAgents: 'created' | 'existing' | 'not-detected';
};

/**
 * Install only Veto-owned project guidance. Native AI memory files are
 * deliberately read-only: Veto must never replace, hide, or merge into them.
 */
export function writeContextGuidance(options: {
  cwd: string;
  geminiDir: string;
  codexDir: string;
  guide: string;
}): ContextGuidanceResult {
  const geminiMemorySkipped = existsSync(options.geminiDir);
  const codexDetected = existsSync(options.codexDir);

  if (!codexDetected) {
    return { geminiMemorySkipped, codexOverrideSkipped: false, projectAgents: 'not-detected' };
  }

  const projectAgents = join(options.cwd, 'AGENTS.md');
  if (existsSync(projectAgents)) {
    return { geminiMemorySkipped, codexOverrideSkipped: true, projectAgents: 'existing' };
  }

  writeFileSync(projectAgents, options.guide, 'utf8');
  return { geminiMemorySkipped, codexOverrideSkipped: true, projectAgents: 'created' };
}
