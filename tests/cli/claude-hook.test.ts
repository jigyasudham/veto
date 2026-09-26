import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_COMMAND, HOOK_FILE, installClaudeHook, isLegacyVetoHook, projectHookState } from '../../src/cli/claude-hook.js';

const roots: string[] = [];
const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'veto-hook-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const LEGACY = 'powershell -ExecutionPolicy Bypass -File .claude/hooks/veto-secrets-scan.ps1 "$CLAUDE_TOOL_INPUT_FILE_PATH"';

function runHook(project: string, filePath: string) {
  return spawnSync(process.execPath, [join(project, '.claude', 'hooks', HOOK_FILE)], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('Claude Code secrets-scan hook', () => {
  it('replaces the old entry that never ran, keeping every other hook', () => {
    const project = makeRoot();
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PostToolUse: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: LEGACY }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      ] },
    }));
    expect(projectHookState(project)).toBe('legacy-broken');
    expect(installClaudeHook(project).settings).toBe('migrated');
    const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    const commands = settings.hooks.PostToolUse.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map(h => h.command));
    expect(commands).toEqual([HOOK_COMMAND, 'echo mine']);
    expect(projectHookState(project)).toBe('working');
    expect(installClaudeHook(project).settings).toBe('present');
  });

  it('removes the dead files older inits wrote, only when they are exactly what Veto wrote', () => {
    const project = makeRoot();
    const hooks = join(project, '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-compact'), '#!/bin/sh\nnpx -y @jigyasudham/veto veto_session_save --auto_summarize=true');
    writeFileSync(join(hooks, 'post-file-write'), '#!/bin/sh\necho my own edit');
    const r = installClaudeHook(project);
    expect(r.removedDeadFiles).toEqual([join(hooks, 'pre-compact')]);
    expect(existsSync(join(hooks, 'post-file-write'))).toBe(true);
  });

  it('actually fires: reads the hook JSON on stdin and exits 2 on a secret', () => {
    const project = makeRoot();
    installClaudeHook(project);
    const leaky = join(project, 'config.ts');
    writeFileSync(leaky, `export const key = "AKIA${'ABCDEFGHIJKLMNOP'}";\n`);
    const r = runHook(project, leaky);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/possible secret .*line 1: AWS access key/);
  });

  it('stays quiet on a clean file and on input it cannot read', () => {
    const project = makeRoot();
    installClaudeHook(project);
    const clean = join(project, 'ok.ts');
    writeFileSync(clean, 'export const x = process.env.API_KEY;\n');
    expect(runHook(project, clean).status).toBe(0);
    expect(spawnSync(process.execPath, [join(project, '.claude', 'hooks', HOOK_FILE)], { input: 'not json', windowsHide: true }).status).toBe(0);
  });

  it('recognises only the legacy command as legacy', () => {
    expect(isLegacyVetoHook(LEGACY)).toBe(true);
    expect(isLegacyVetoHook(HOOK_COMMAND)).toBe(false);
    expect(isLegacyVetoHook(undefined)).toBe(false);
  });
});
