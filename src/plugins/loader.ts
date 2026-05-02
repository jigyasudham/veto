import { readdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import type { AgentPlan, AgentAnalysis, WorkerAgentType } from '../agents/types.js';

export interface PluginModule {
  plan: (task: string, context?: string) => AgentPlan;
  analyze?: (code: string, context?: string) => AgentAnalysis;
}

const PLUGIN_DIR = join(homedir(), '.veto', 'agents');
const registry = new Map<string, PluginModule>();
let loaded = false;

function pluginName(file: string): string {
  return basename(file, extname(file));
}

export async function loadPlugins(): Promise<string[]> {
  if (loaded) return Array.from(registry.keys());
  loaded = true;

  if (!existsSync(PLUGIN_DIR)) return [];

  const files = readdirSync(PLUGIN_DIR).filter(f => /\.(js|mjs)$/.test(f));
  const names: string[] = [];

  for (const file of files) {
    const name = pluginName(file);
    try {
      const mod = await import(join(PLUGIN_DIR, file)) as unknown;
      if (
        mod && typeof mod === 'object' &&
        'plan' in mod && typeof (mod as Record<string, unknown>).plan === 'function'
      ) {
        registry.set(name, mod as PluginModule);
        names.push(name);
      } else {
        process.stderr.write(`[veto] Plugin "${file}" skipped — must export plan(task, context?)\n`);
      }
    } catch (err) {
      process.stderr.write(`[veto] Plugin "${file}" failed to load: ${err}\n`);
    }
  }

  return names;
}

export function getPlugin(name: string): PluginModule | undefined {
  return registry.get(name);
}

export function isPlugin(name: string): boolean {
  return registry.has(name);
}

export function listPlugins(): Array<{ name: string; has_analyze: boolean }> {
  return Array.from(registry.entries()).map(([name, mod]) => ({
    name,
    has_analyze: typeof mod.analyze === 'function',
  }));
}
