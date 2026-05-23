import { watch, FSWatcher } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WatchEvent {
  event_type: 'change' | 'rename';
  file: string;
  ext: string;
  triggered_at: string;
  recommended_agent: string;
  suggested_tool: string;
  reason: string;
  inline_annotation_supported?: boolean;
}

interface WatchSession {
  watcher: FSWatcher;
  project_dir: string;
  events: WatchEvent[];
  started_at: string;
}

const sessions = new Map<string, WatchSession>();

const EXT_RULES: Array<[(f: string, e: string) => boolean, string, string, string, boolean?]> = [
  [(f) => basename(f) === 'package.json',                    'dependency-audit', 'veto_agent_plan', 'package.json changed — check for new CVEs or unwanted deps'],
  [(f) => /\.(env|env\..+)$/.test(basename(f)),              'secrets',          'veto_secrets_scan', '.env file changed — scan for exposed credentials', true],
  [(f, e) => ['.sql', '.prisma'].includes(e),                'database',         'veto_agent_plan', 'Database schema file changed'],
  [(f, e) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f),      'tester',           'veto_agent_plan', 'Test file changed — review test coverage'],
  [(f, e) => ['.ts', '.tsx', '.js', '.jsx'].includes(e),     'code-quality',     'veto_code_review', 'Source file saved — code quality check recommended', true],
  [(f, e) => ['.yaml', '.yml', '.toml'].includes(e),         'devops',           'veto_agent_plan', 'Config file changed'],
  [(f, e) => e === '.json' && basename(f) !== 'package.json','coder',            'veto_agent_plan', 'JSON config changed'],
];

function classify(file: string): { agent: string; tool: string; reason: string; inline_annotation_supported: boolean } {
  const ext = extname(file).toLowerCase();
  for (const [match, agent, tool, reason, inline] of EXT_RULES) {
    if (match(file, ext)) return { agent, tool, reason, inline_annotation_supported: inline ?? false };
  }
  return { agent: 'coder', tool: 'veto_agent_plan', reason: 'File changed', inline_annotation_supported: false };
}

export function startWatch(projectDir: string): string {
  const dir = resolve(projectDir);
  const id = randomUUID().slice(0, 8);

  const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    // ignore node_modules, .git, dist
    if (/node_modules|\.git|dist|\.veto/.test(filename)) return;

    const session = sessions.get(id);
    if (!session) return;

    const { agent, tool, reason, inline_annotation_supported } = classify(filename);
    session.events.push({
      event_type: eventType === 'rename' ? 'rename' : 'change',
      file: filename,
      ext: extname(filename).toLowerCase(),
      triggered_at: new Date().toISOString(),
      recommended_agent: agent,
      suggested_tool: tool,
      reason,
      inline_annotation_supported,
    });
  });

  sessions.set(id, {
    watcher,
    project_dir: dir,
    events: [],
    started_at: new Date().toISOString(),
  });

  return id;
}

export function pollWatch(watchId: string): { found: boolean; events: WatchEvent[]; project_dir?: string } {
  const session = sessions.get(watchId);
  if (!session) return { found: false, events: [] };
  const events = [...session.events];
  session.events = [];
  return { found: true, events, project_dir: session.project_dir };
}

export function stopWatch(watchId: string): boolean {
  const session = sessions.get(watchId);
  if (!session) return false;
  session.watcher.close();
  sessions.delete(watchId);
  return true;
}

export function listWatches(): Array<{ id: string; project_dir: string; started_at: string; pending_events: number }> {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    project_dir: s.project_dir,
    started_at: s.started_at,
    pending_events: s.events.length,
  }));
}
