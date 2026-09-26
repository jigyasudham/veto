#!/usr/bin/env node
// Veto CLI — entry point for `npx veto init`

// Suppress Node experimental warnings (node:sqlite) for clean UX
process.removeAllListeners('warning');

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { repairBrokenClaudeEntry } from './cli/claude-repair.js';
import { writeContextGuidance } from './cli/context-guidance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
const TAGLINE = '93 agentic tools. 49 specialists. Every major AI CLI. Self-learning. Zero extra cost on subscriptions.';
const VETO_DIR = join(homedir(), '.veto');
const HOME = homedir();

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function printBanner() {
  console.log('');
  console.log(c.bold(c.cyan('  ██╗   ██╗███████╗████████╗ ██████╗')));
  console.log(c.bold(c.cyan('  ██║   ██║██╔════╝╚══██╔══╝██╔═══██╗')));
  console.log(c.bold(c.cyan('  ██║   ██║█████╗     ██║   ██║   ██║')));
  console.log(c.bold(c.cyan('  ╚██╗ ██╔╝██╔══╝     ██║   ██║   ██║')));
  console.log(c.bold(c.cyan('   ╚████╔╝ ███████╗   ██║   ╚██████╔╝')));
  console.log(c.bold(c.cyan('    ╚═══╝  ╚══════╝   ╚═╝    ╚═════╝')));
  console.log('');
  console.log(c.dim(`  ${TAGLINE}`));
  console.log(c.dim(`  v${VERSION}`));
  console.log('');
}

async function initCommand() {
  printBanner();

  // 1. Create ~/.veto directory
  if (!existsSync(VETO_DIR)) {
    mkdirSync(VETO_DIR, { recursive: true });
    console.log(c.green('  ✓') + ` Created ${VETO_DIR}`);
  } else {
    console.log(c.dim('  · ') + `Found existing ${VETO_DIR}`);
  }

  // 2. Initialize SQLite database
  process.stdout.write('  · Initializing SQLite database...');
  const { getDb, getDbPath, saveSession } = await import('./memory/local.js');

  try {
    const db = getDb();
    const dbPath = getDbPath();
    const { session_id } = saveSession({
      platform: 'claude',
      summary: 'Veto initialized',
      context: 'Initial setup via npx veto init',
    });
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id);
    if (!row) throw new Error('DB smoke test failed');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session_id);
    console.log(c.green(' ✓'));
    console.log(c.green('  ✓') + ` Database ready at ${dbPath}`);
  } catch (err: unknown) {
    console.log(c.red(' ✗'));
    const msg = err instanceof Error ? err.message : String(err);
    console.error(c.red(`  Error initializing database: ${msg}`));
    process.exit(1);
  }

  // 3. Auto-import VETO_MEMORY.md if present in cwd
  const cwd = resolve(process.cwd());
  const vetoMemoryPath = join(cwd, 'VETO_MEMORY.md');
  if (existsSync(vetoMemoryPath)) {
    process.stdout.write('  · Importing VETO_MEMORY.md...');
    try {
      const { importMemoryMarkdown } = await import('./memory/sync.js');
      const importResult = importMemoryMarkdown(vetoMemoryPath);
      console.log(c.green(' ✓') + ` ${importResult.imported} knowledge entries imported`);
    } catch {
      console.log(c.dim(' skipped'));
    }
  }

  // 4. Auto-scan current project and store project map
  const { updateProjectMap } = await import('./memory/local.js');
  const { discoverProject } = await import('./discover.js');
  try {
    process.stdout.write('  · Scanning project directory...');
    const disc = discoverProject(cwd, 'standard');
    updateProjectMap({
      project_dir: disc.project_dir,
      structure: { ecosystems: disc.ecosystems, key_files: disc.key_files, file_counts: disc.file_counts, total_files: disc.total_files, scanned_at: disc.scanned_at },
      key_modules: disc.key_files,
      tech_stack: disc.tech_stack,
    });
    const stackStr = disc.tech_stack.length ? ` (${disc.tech_stack.slice(0, 4).join(', ')})` : '';
    console.log(c.green(' ✓') + ` Project map saved${stackStr}`);
  } catch {
    console.log(c.dim(' skipped'));
  }

  // 4. Auto-configure every AI CLI / IDE found on this machine
  console.log('');
  console.log('  Configuring all AI tools found on this machine...');
  console.log('');

  let configured = 0;
  let skipped = 0;

  // Every host from one table (cli/hosts.ts). A host's own CLI registers Veto
  // where that host reads it; a file is written only when the CLI is absent,
  // and only a file the host is known to read.
  const { hostSpecs, detectHost, serverCommand } = await import('./cli/hosts.js');
  const { registerHost } = await import('./cli/register.js');
  const { command: npxBin, args: serverArgs } = serverCommand();
  for (const spec of hostSpecs()) {
    const installed = detectHost(spec);
    if (!installed.installed) {
      console.log(c.dim('  · ') + c.dim(`${spec.name} — not installed, skipping`));
      continue;
    }
    const outcome = registerHost(spec, installed);
    if (outcome.status === 'manual') {
      console.log(c.yellow('  ⚠ ') + `${spec.name} — not registered: ${outcome.detail}`);
      for (const line of outcome.instructions) console.log(c.dim(`          ${line.replace(/\n/g, '\n          ')}`));
      skipped++;
      continue;
    }
    if (outcome.status === 'skipped') {
      console.log(c.dim('  · ') + c.dim(`${spec.name} — ${outcome.detail}`));
      continue;
    }
    if (spec.id === 'claude' && outcome.status === 'already') {
      // An old entry can point at a deleted global install; heal it in place.
      const mcpCmd = ['claude', 'mcp', 'add', 'veto', '-s', 'user', '--', npxBin, ...serverArgs].join(' ');
      if (repairBrokenClaudeEntry(join(HOME, '.claude.json'), mcpCmd)) {
        console.log(c.green('  ✓ ') + 'Claude Code — repaired stale registration (was pointing at a missing file)');
        configured++;
        continue;
      }
    }
    const how = outcome.via === 'cli' ? outcome.detail : `wrote ${outcome.detail}`;
    const verb = outcome.status === 'already' ? 'already registered' : outcome.status === 'updated' ? 'updated' : 'registered';
    console.log(c.green('  ✓ ') + `${spec.name} — ${verb} ${c.dim(`(${how})`)}`);
    if (outcome.status !== 'already' && outcome.backup) console.log(c.dim(`          previous file kept as ${outcome.backup}`));
    for (const legacy of spec.legacyConfigs ?? []) {
      if (existsSync(legacy)) console.log(c.dim(`          note: ${legacy} is an old location ${spec.name} no longer reads`));
    }
    configured++;
  }

  console.log('');

  // Veto-owned fallback skill: the one instruction an AI still sees when its
  // host failed to start Veto (cli/fallback-skill.ts).
  {
    const { writeFallbackSkill } = await import('./cli/fallback-skill.js');
    const dirs = hostSpecs().filter(s => detectHost(s).installed).flatMap(s => s.skillDirs ?? []);
    for (const w of writeFallbackSkill(dirs)) {
      const where = join(w.dir, 'veto', 'SKILL.md');
      if (w.result === 'written' || w.result === 'updated') console.log(c.green('  ✓ ') + `Fallback skill ${w.result} ${c.dim(where)}`);
      else if (w.result === 'foreign') console.log(c.dim('  · ') + c.dim(`${where} is your own skill — left untouched`));
      else if (w.result === 'failed') console.log(c.yellow('  ⚠ ') + `Could not write ${where}`);
    }
  }

  // 5. Write platform-specific context guidance files
  // These are read at session start by each AI client — zero tool calls needed.
  console.log('  Writing context guidance files...');
  console.log('');

  const VETO_GUIDE = `# Veto MCP Server

Veto is active. 93 tools across 6 categories:

**Session & Context** — veto_status · veto_session_save · veto_continue · veto_handoff
Save work at 60–70% context capacity. veto_status triggers auto-save above 70%.

**Code Intelligence** — veto_diff_review · veto_code_review · veto_security_scan · veto_secrets_scan · veto_ci_gate
Run veto_diff_review before any merge — it runs all three scans in parallel.

**Council & Routing** — veto_council_debate · veto_route_task · veto_execute_parallel
Council = 7 specialist agents (Lead Dev, PM, Architect, UX, Devil's Advocate, Legal, Security).
Verdicts: GREEN (proceed) · YELLOW (warnings) · RED (blocked) · DEADLOCK (human decision needed).
Two-phase LLM-backed flow: call with { task } → get debate_prompt → reason as all 7 agents → call again with { task, agent_responses }.

**Memory & Discovery** — veto_discover · veto_summarize · veto_memory_store · veto_memory_search
Run veto_discover on any unfamiliar repo before touching files.

**Observability** — veto_usage_status · veto_health · veto_audit_log · veto_learning_stats

Recommended start sequence:
1. veto_status — confirm running
2. veto_discover — map the project
3. veto_route_task — pick the right agent
4. veto_diff_review — validate before shipping
5. veto_session_save — checkpoint before context fills

**If no veto_* tool is available** (Veto did not load in this app): say so in one
sentence, then use the CLI, which runs the same code — \`veto continue <id> --as <client>\`,
\`veto sessions --all\`, \`veto doctor\`. Never read ~/.veto/veto.db or import Veto's files.
`;

  let ctxWritten = 0;

  // Native AI memory files are deliberately never written by Veto. Their
  // respective CLIs own those files; replacing them would hide user knowledge.
  const geminiDir = join(HOME, '.gemini');
  // Codex gets an optional project guide only when no user guide exists.
  const codexDir2 = join(HOME, '.codex');
  try {
    const guidance = writeContextGuidance({ cwd, geminiDir, codexDir: codexDir2, guide: VETO_GUIDE });
    if (guidance.geminiMemorySkipped) {
      console.log(c.dim('  · ') + c.dim("Gemini/Antigravity CLI — Veto does not write GEMINI.md (it is Gemini's own memory file)"));
    }
    if (guidance.projectAgents === 'created') {
      console.log(c.green('  ✓ ') + `Codex CLI — wrote AGENTS.md in ${cwd}`);
      ctxWritten++;
    } else if (guidance.projectAgents === 'existing') {
      console.log(c.dim('  · ') + c.dim('Codex CLI — AGENTS.md already exists, skipping'));
    }
    if (guidance.codexOverrideSkipped) {
      console.log(c.dim('  · ') + c.dim("Codex CLI — Veto does not write ~/.codex/AGENTS.override.md (it would hide your AGENTS.md)"));
    }
  } catch {
    console.log(c.yellow('  ⚠ ') + 'Codex CLI — could not write project AGENTS.md');
  }

  // Older inits wrote Veto's guide INTO those native files. Copies that are
  // nothing but a guide Veto wrote are renamed aside; anything else is left alone.
  const { moveAsideLeftoverGuides, describeLeftover } = await import('./cli/leftover-guides.js');
  const leftovers = moveAsideLeftoverGuides(HOME);
  for (const moved of leftovers.moved) {
    console.log(c.green('  ✓ ') + `${describeLeftover(moved, HOME)} — renamed to ${basename(moved.backupPath)}`);
  }
  for (const kept of leftovers.kept) {
    console.log(c.yellow('  ⚠ ') + describeLeftover(kept, HOME) + (kept.kind === 'exact'
      ? ' — could not be renamed; move it aside by hand'
      : ' — left as is; delete the "# Veto MCP Server" block by hand if you like'));
  }

  // Windsurf: ~/.codeium/windsurf/rules/veto.md
  const windsurfRulesDir = join(HOME, '.codeium', 'windsurf', 'rules');
  if (existsSync(join(HOME, '.codeium', 'windsurf'))) {
    try {
      mkdirSync(windsurfRulesDir, { recursive: true });
      writeFileSync(join(windsurfRulesDir, 'veto.md'), VETO_GUIDE, 'utf8');
      console.log(c.green('  ✓ ') + 'Windsurf — wrote ~/.codeium/windsurf/rules/veto.md');
      ctxWritten++;
    } catch { console.log(c.yellow('  ⚠ ') + 'Windsurf — could not write rules/veto.md'); }
  }

  if (ctxWritten > 0) console.log('');

  // 6. Claude Code secrets-scan hook for this project (cli/claude-hook.ts).
  // Older inits installed one that never fired; this replaces it in place.
  if (detectHost(hostSpecs().find(s => s.id === 'claude')!).installed) {
    const { installClaudeHook } = await import('./cli/claude-hook.js');
    const r = installClaudeHook(cwd);
    if (r.settings === 'migrated') console.log(c.green('  ✓ ') + 'Claude Code — replaced the old secrets-scan hook, which never ran, with a working one');
    else if (r.settings === 'added') console.log(c.green('  ✓ ') + 'Claude Code — added a secrets-scan hook for Write/Edit in .claude/settings.json');
    else if (r.settings === 'present') console.log(c.dim('  · ') + c.dim('Claude Code — secrets-scan hook already installed'));
    else console.log(c.yellow('  ⚠ ') + 'Claude Code — could not update .claude/settings.json (invalid JSON or no permission)');
    for (const f of r.removedDeadFiles) console.log(c.dim(`          removed ${f} (Claude Code never ran it)`));
    console.log('');
  }

  if (configured === 0 && skipped === 0) {
    console.log(c.yellow('  ⚠  No AI tools detected.'));
    console.log('  Install Claude Code, Gemini CLI, Antigravity CLI, or Codex CLI and run veto init again.');
    console.log('');
  } else {
    console.log('');
    console.log(c.green(`  ✓ Veto registered with ${configured} app${configured !== 1 ? 's' : ''}.`));
    if (skipped > 0) console.log(c.yellow(`  ⚠ ${skipped} app${skipped !== 1 ? 's' : ''} still need${skipped === 1 ? 's' : ''} the manual step shown above.`));
    console.log('');
    console.log('  Next steps:');
    console.log(c.dim('  1.') + ' Fully restart each configured AI client (not just reload)');
    console.log(c.dim('  2.') + ' Registration is global — every window and project picks it up');
    console.log(c.dim('  3.') + ` Confirm: ${c.cyan('veto doctor')} — shows, per app, whether it has actually started Veto`);
    console.log('');
    console.log(c.dim('  Tip: run `veto init` again anytime to install newly-added AI tools.'));
    console.log('');
  }

  // ── Billing mode detection ──────────────────────────────────────────────────
  // Check for API key env vars as a signal the user may be on pay-per-token billing.
  const apiKeyEnvVars = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
  const detectedKeys = apiKeyEnvVars.filter(k => !!process.env[k]);
  const { setConfig: setVetoConfig } = await import('./memory/config.js');

  if (detectedKeys.length > 0) {
    setVetoConfig({ billing_mode: 'api' });
    console.log(c.yellow('  ⚠  API key environment variables detected:') + c.dim(` ${detectedKeys.join(', ')}`));
    console.log(c.yellow('     Veto has set billing_mode = api in ~/.veto/config.json.'));
    console.log('');
    console.log('  ' + c.bold('Important — cost warning:'));
    console.log('  Veto\'s "zero cost" claim applies to subscription plans (Claude Max, Gemini');
    console.log('  Advanced, etc.). On API/pay-per-token billing, any MCP Sampling calls made');
    console.log('  by Veto agents will count toward your token usage and be billed accordingly.');
    console.log('');
    console.log(c.dim('  To silence this warning if you are on a subscription:'));
    console.log(c.dim('  Edit ~/.veto/config.json and set "billing_mode": "subscription"'));
    console.log('');
  } else {
    setVetoConfig({ billing_mode: 'subscription' });
  }

  // ── Post-install health check ───────────────────────────────────────────────
  // Confirm the server can actually run before the user discovers a failure inside
  // their AI client. The one real runtime risk is node:sqlite (unflagged in 22.13+/23.4+).
  console.log('  ' + c.bold('Post-install check'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  let healthOk = true;

  // Ask the runtime whether it can actually load node:sqlite rather than deriving it
  // from the version number. The arithmetic version of this check accepted 22.5–22.12
  // and 23.0–23.3, where the module exists only behind --experimental-sqlite, so
  // `veto doctor` reported a green tick on installs whose persistence was dead.
  const { sqliteAvailable } = await import('./memory/local.js');
  if (sqliteAvailable()) {
    console.log(`  ${c.green('✓')} Node.js ${process.version}`);
  } else {
    console.log(`  ${c.red('✗')} Node.js ${process.version} — Veto needs >= 22.13 (or >= 23.4) for node:sqlite; persistence will not work`);
    healthOk = false;
  }

  try {
    const { getDb } = await import('./memory/local.js');
    getDb(); // exercises node:sqlite + schema/migration init
    console.log(`  ${c.green('✓')} Local database initialised`);
  } catch (err: unknown) {
    console.log(`  ${c.red('✗')} Database failed to initialise: ${err instanceof Error ? err.message : String(err)}`);
    healthOk = false;
  }
  console.log('');

  // MCP Sampling support is client-dependent and can't be probed from the CLI —
  // surface the honest guidance so the fallback path isn't a surprise.
  console.log('  ' + c.bold('MCP Sampling') + c.dim(' (powers zero-extra-cost agent reasoning)'));
  console.log(c.dim('  Clients with Sampling (Claude Code, Cursor, Windsurf, VS Code) run agents'));
  console.log(c.dim('  directly. Clients without it get an agentic-fallback prompt to reason instead.'));
  console.log(c.dim('  Run `veto doctor` anytime for the full health + registration report.'));
  console.log('');

  if (!healthOk) {
    console.log(c.yellow('  ⚠  Resolve the issues above before using Veto in your AI client.'));
    console.log('');
  }
}


// ─── Doctor Command ─────────────────────────────────────────────────────────────

async function doctorCommand(fix = false, quick = false) {
  console.log('');
  console.log(c.bold('  Veto Doctor') + c.dim(' — system health check'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log('');

  let issues = 0;

  // Node.js — ask the runtime whether node:sqlite actually loads. A "major >= 22"
  // check (what doctor did until 3.7.0) passed 22.5–22.12, where the module
  // exists only behind a flag and persistence is dead; init was fixed for this
  // long ago and doctor was not.
  const { sqliteAvailable: sqliteOk } = await import('./memory/local.js');
  if (sqliteOk()) {
    console.log(`  ${c.green('✓')} Node.js ${process.version} ${c.dim('(this terminal)')}`);
  } else {
    console.log(`  ${c.red('✗')} Node.js ${process.version} — Veto needs >= 22.13 (or >= 23.4) for node:sqlite; persistence will not work`);
    issues++;
  }

  // Version — the running build, compared best-effort against the registry's
  // latest so an out-of-date install is visible at a glance.
  let latest = '';
  try {
    latest = execSync('npm view @jigyasudham/veto version', { windowsHide: true, encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* offline / npm unavailable — skip the comparison */ }

  if (latest && latest !== VERSION) {
    console.log(`  ${c.yellow('⚠')} Veto v${VERSION} — ${c.yellow(`v${latest} is available`)}`);
    issues++;
  } else if (latest) {
    console.log(`  ${c.green('✓')} Veto v${VERSION} ${c.dim('(latest)')}`);
  } else {
    console.log(`  ${c.green('✓')} Veto v${VERSION}`);
  }

  // Global CLI install — how the bare `veto` command gets on PATH. Since 2.7.1
  // every generated MCP config pins `@latest`, which npx must re-resolve against
  // the registry, so a global copy can no longer shadow the MCP server. Only
  // flag it when it has fallen behind the registry.
  let globalVersion = '';
  try {
    const out = execSync('npm ls -g @jigyasudham/veto --depth=0', { windowsHide: true, encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });
    globalVersion = out.match(/@jigyasudham\/veto@([\d.]+)/)?.[1] ?? '';
  } catch { /* not installed globally — CLI still reachable via npx */ }

  if (globalVersion && latest && globalVersion !== latest) {
    console.log(`  ${c.yellow('⚠')} Global CLI install v${globalVersion} — ${c.yellow(`v${latest} is available`)}`);
    console.log(`  ${c.dim(`    update: ${c.cyan('npm i -g @jigyasudham/veto@latest')} (the MCP server is unaffected — its config pins @latest)`)}`);
    issues++;
  } else if (globalVersion) {
    console.log(`  ${c.green('✓')} Global CLI install v${globalVersion} ${c.dim('— bare veto commands on PATH')}`);
  } else {
    console.log(`  ${c.dim('·')} No global CLI install — bare ${c.cyan('veto')} commands unavailable in this terminal`);
    console.log(`  ${c.dim(`    optional: ${c.cyan('npm i -g @jigyasudham/veto')} — safe: MCP configs pin @latest, so a global copy cannot shadow the server`)}`);
  }

  // ~/.veto directory
  if (existsSync(VETO_DIR)) {
    console.log(`  ${c.green('✓')} ${c.dim(VETO_DIR)} exists`);
  } else {
    console.log(`  ${c.red('✗')} ${VETO_DIR} missing — run: ${c.cyan('veto init')}`);
    issues++;
  }

  // SQLite database
  try {
    const { getDb, getDbPath } = await import('./memory/local.js');
    const db = getDb();
    const dbPath = getDbPath();
    const sessions  = (db.prepare('SELECT COUNT(*) as c FROM sessions').get()       as { c: number }).c;
    const memories  = (db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get() as { c: number }).c;
    const patterns  = (db.prepare('SELECT COUNT(*) as c FROM patterns').get()       as { c: number }).c;
    console.log(`  ${c.green('✓')} Database ${c.dim(dbPath)}`);
    console.log(`  ${c.dim('    ')}${sessions} sessions · ${memories} memories · ${patterns} patterns`);
  } catch (err: unknown) {
    console.log(`  ${c.red('✗')} Database error: ${err instanceof Error ? err.message : String(err)}`);
    issues++;
  }

  // Semantic search model. It degrades SILENTLY at query time — by design, so a
  // damaged copy can never take recall down — which is precisely why its state
  // belongs in a health check. Without this line, a missing model is
  // indistinguishable from search simply getting worse.
  try {
    const { isCaptureEnabled } = await import('./transcripts/config.js');
    const { embeddingsAvailable, modelProvenance } = await import('./transcripts/embed.js');
    const captureOn = isCaptureEnabled();

    if (embeddingsAvailable()) {
      const { model_id, revision } = modelProvenance();
      console.log(`  ${c.green('✓')} Semantic search ${c.dim(`${model_id}@${revision.slice(0, 12)}`)}`);
      if (!captureOn) {
        console.log(`  ${c.dim(`    transcript capture is off — enable with ${c.cyan('veto transcripts enable')}`)}`);
      }
    } else if (captureOn) {
      // Only an issue when capture is on: that is the one case where a user is
      // actively searching and silently getting less than they should.
      console.log(`  ${c.yellow('⚠')} Semantic search unavailable — recall is keyword-only`);
      console.log(`  ${c.dim(`    the embedding table ships with Veto; reinstall to restore it: ${c.cyan('npm i -g @jigyasudham/veto@latest')}`)}`);
      issues++;
    } else {
      console.log(`  ${c.dim('·')} Semantic search idle ${c.dim('— transcript capture is off')}`);
    }
  } catch {
    // The whole feature is optional; a health check must never be the thing
    // that fails because an optional dependency is absent.
    console.log(`  ${c.dim('·')} Semantic search unavailable ${c.dim('— recall would run keyword-only')}`);
  }

  // Leftovers from older inits, which wrote Veto's guide into Codex's and
  // Gemini's own files. --fix renames copies that are nothing but that guide.
  try {
    const { findLeftoverGuides, moveAsideLeftoverGuides, describeLeftover } = await import('./cli/leftover-guides.js');
    const moved = fix ? moveAsideLeftoverGuides(HOME).moved : [];
    for (const m of moved) {
      console.log(`  ${c.green('✓')} ${describeLeftover(m, HOME)} — renamed to ${basename(m.backupPath)}`);
    }
    const remaining = findLeftoverGuides(HOME);
    for (const guide of remaining) {
      console.log(`  ${c.yellow('⚠')} ${describeLeftover(guide, HOME)}`);
      console.log(`  ${c.dim(guide.kind === 'exact'
        ? `    fix: ${c.cyan('veto doctor --fix')} (renames only this Veto-written copy to ${basename(guide.path)}.veto-backup)`
        : '    Veto will not edit a file with your own content in it; delete the "# Veto MCP Server" block by hand')}`);
      issues++;
    }
    if (!remaining.length && !moved.length && (existsSync(join(HOME, '.codex')) || existsSync(join(HOME, '.gemini')))) {
      console.log(`  ${c.green('✓')} No old Veto guide in Codex or Gemini files`);
    }
  } catch { /* a health check never fails on its own checks */ }

  console.log('');
  console.log('  ' + c.bold('AI apps') + c.dim(quick ? ' — registration only (--quick skips the launch test)' : ' — registration · launch test · last start'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  const { diagnoseHosts } = await import('./cli/doctor-hosts.js');
  const diagnoses = await diagnoseHosts({ probe: !quick, latestVersion: latest || null });
  for (const d of diagnoses) {
    if (d.level === 'absent') { console.log(`  ${c.dim('·')} ${c.dim(d.headline)}`); continue; }
    const mark = d.level === 'ok' ? c.green('✓') : d.level === 'warn' ? c.yellow('⚠') : c.red('✗');
    console.log(`  ${mark} ${d.headline}`);
    for (const line of d.details) console.log(c.dim(`      ${line}`));
    if (d.fix) console.log(`      ${c.dim('fix:')} ${c.cyan(d.fix)}`);
    if (d.level !== 'ok') issues++;
  }

  // The instruction an AI sees when an app did not load Veto (cli/fallback-skill.ts).
  console.log('');
  console.log('  ' + c.bold('Fallback guidance') + c.dim(' — what an AI is told when Veto did not load'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  {
    const { skillState } = await import('./cli/fallback-skill.js');
    const dirs = [...new Set(diagnoses.filter(d => d.level !== 'absent').flatMap(d => d.report.spec.skillDirs ?? []))];
    if (!dirs.length) console.log(c.dim('  · no installed app lists skills'));
    for (const dir of dirs) {
      const state = skillState(dir);
      const where = join(dir, 'veto', 'SKILL.md');
      if (state === 'current') console.log(`  ${c.green('✓')} ${c.dim(where)}`);
      else if (state === 'foreign') console.log(`  ${c.dim('·')} ${c.dim(`${where} is your own skill — Veto leaves it alone`)}`);
      else {
        const why = state === 'missing' ? 'missing' : state === 'modified' ? 'edited since Veto wrote it' : 'from an older Veto';
        console.log(`  ${c.yellow('⚠')} ${where} — ${why}`);
        console.log(`      ${c.dim('fix:')} ${c.cyan('veto init')}`);
        issues++;
      }
    }
  }

  // This project's Claude Code hook (cli/claude-hook.ts).
  {
    const { projectHookState } = await import('./cli/claude-hook.js');
    if (projectHookState(process.cwd()) === 'legacy-broken') {
      console.log(`  ${c.yellow('⚠')} This project's Claude Code secrets-scan hook is the old one, which never ran`);
      console.log(`      ${c.dim('fix:')} ${c.cyan('veto init')} ${c.dim('(replaces it in .claude/settings.json)')}`);
      issues++;
    }
  }

  // Data pipes that can stop silently when a host changes its file format.
  console.log('');
  console.log('  ' + c.bold('Freshness') + c.dim(' — pipelines that fail silently when an app changes'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  try {
    const { captureStatus } = await import('./transcripts/config.js');
    const cs = captureStatus();
    if (!cs.effective) {
      console.log(c.dim('  · transcript capture is off'));
    } else {
      const { captureFreshness } = await import('./transcripts/freshness.js');
      const installedSources = (['claude', 'codex', 'gemini'] as const)
        .filter(id => diagnoses.some(d => d.report.spec.id === id && d.level !== 'absent'));
      for (const f of captureFreshness({ captureSince: cs.consent_at ?? null, sources: installedSources })) {
        if (!f.lastSaveFromHost && !f.newestArchive) continue;
        if (f.stalled) {
          console.log(`  ${c.yellow('⚠')} ${f.source} capture looks stalled — last archive ${f.newestArchive ?? 'never'}, yet a save came from ${f.source} at ${f.lastSaveFromHost}`);
          console.log(c.dim(`      ${f.source} may have changed its session file format; see: veto transcripts sources`));
          issues++;
        } else {
          console.log(`  ${c.green('✓')} ${f.source} capture ${c.dim(`last archive ${f.newestArchive ?? '—'}`)}`);
        }
      }
      if (diagnoses.some(d => d.report.spec.id === 'antigravity' && d.level !== 'absent')) {
        console.log(c.dim('  · Antigravity chats are not captured — Veto reads Claude Code, Codex and Gemini CLI session files only'));
      }
    }
  } catch { console.log(c.dim('  · transcript freshness unavailable')); }
  try {
    const { trialStatus, trialBacklog } = await import('./lessons/trial.js');
    const ts = trialStatus();
    if (ts) {
      const backlog = trialBacklog();
      const mark = ts.drift ? c.red('✗') : c.green('✓');
      console.log(`  ${mark} lessons trial ${ts.qualifying}/${ts.target} qualifying sessions ${c.dim(`· ends ${ts.endsAt.slice(0, 10)}${ts.complete ? ' · complete' : ''}`)}`);
      if (ts.drift) {
        console.log(c.dim('      the last sessions in a row had no request Veto could read — Codex has likely changed its rollout format'));
        issues++;
      }
      if (backlog && backlog.unexamined > 0) {
        console.log(c.dim(`      ${backlog.unexamined} Codex session(s) not examined yet (oldest ${backlog.oldestUnexamined?.slice(0, 10)}) — the trial examines them on the next veto_session_save`));
      }
    }
  } catch { /* lessons optional */ }

  // Billing mode
  console.log('');
  console.log('  ' + c.bold('Billing'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  const { getConfig: getVetoConfig } = await import('./memory/config.js');
  const vetoConfig = getVetoConfig();
  const apiKeyEnvVarsDoctor = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
  const detectedKeysDoctor = apiKeyEnvVarsDoctor.filter(k => !!process.env[k]);

  if (vetoConfig.billing_mode === 'api' || detectedKeysDoctor.length > 0) {
    console.log(`  ${c.yellow('⚠')} billing_mode: ${c.yellow('api')} — MCP Sampling calls count toward your token usage`);
    console.log(`  ${c.dim('  Veto\'s "zero cost" claim applies to subscription plans only.')}`);
    console.log(`  ${c.dim('  To update: edit ~/.veto/config.json → "billing_mode": "subscription"')}`);
    issues++;
  } else {
    console.log(`  ${c.green('✓')} billing_mode: subscription — zero extra cost`);
  }

  console.log('');
  if (issues === 0) {
    console.log(c.green('  ✓ All checks passed — Veto is healthy!'));
  } else {
    console.log(c.yellow(`  ⚠  ${issues} issue${issues !== 1 ? 's' : ''} found.`) + ' Each has its fix above.');
  }
  console.log('');
  // Scriptable: a CI step or a wrapper can trust the exit code.
  process.exitCode = issues === 0 ? 0 : 1;
}

// ─── CLI Subcommands ────────────────────────────────────────────────────────────

async function statusCommand() {
  const { getDbPath } = await import('./memory/local.js');
  const { getDb } = await import('./memory/local.js');
  const db = getDb();
  const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
  const memoryCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get() as { c: number }).c;
  const patternCount = (db.prepare('SELECT COUNT(*) as c FROM patterns').get() as { c: number }).c;
  const outcomeCount = (db.prepare('SELECT COUNT(*) as c FROM learning_data').get() as { c: number }).c;

  console.log('');
  console.log(c.bold('  Veto Status'));
  console.log(c.dim('  ─────────────────────────────'));
  console.log(`  Version     ${c.cyan(VERSION)}`);
  console.log(`  DB          ${c.dim(getDbPath())}`);
  console.log(`  Sessions    ${c.cyan(String(sessionCount))}`);
  console.log(`  Memory      ${c.cyan(String(memoryCount))} knowledge entries`);
  console.log(`  Patterns    ${c.cyan(String(patternCount))}`);
  console.log(`  Outcomes    ${c.cyan(String(outcomeCount))} recorded`);
  console.log('');
}

async function sessionsCommand() {
  const { listSessions, countSessions, getDb } = await import('./memory/local.js');

  const args = process.argv.slice(3);

  if (args[0] === '--clean') {
    const db = getDb();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(
      "DELETE FROM sessions WHERE save_type = 'auto' AND created_at < ?"
    ).run(cutoff) as { changes: number };
    console.log('');
    console.log(c.green(`  ✓ Removed ${result.changes} auto-save${result.changes !== 1 ? 's' : ''} older than 7 days.`));
    console.log('');
    return;
  }

  // veto sessions [search words] [--all | --limit N] [--json]
  const asJson = args.includes('--json');
  let limit = 20;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') limit = 100_000;
    else if (a === '--limit') limit = Number(args[++i]);
    else if (a.startsWith('--limit=')) limit = Number(a.slice(8));
    else if (a === '--json') continue;
    else if (a.startsWith('--')) { console.error(c.red(`  Unknown option ${a}`)); console.error(c.dim('  Usage: veto sessions [search words] [--all | --limit N] [--json] | --clean')); process.exit(1); }
    else words.push(a);
  }
  if (!Number.isFinite(limit) || limit < 1) { console.error(c.red('  --limit needs a positive number')); process.exit(1); }
  const query = words.join(' ') || undefined;
  const sessions = listSessions(Math.floor(limit), query);
  const total = countSessions();

  if (asJson) {
    console.log(JSON.stringify({
      total, shown: sessions.length, query: query ?? null,
      sessions: sessions.map(s => ({ id: s.id, created_at: s.created_at, platform: s.platform, save_type: s.save_type, project_dir: s.project_dir, summary: s.summary })),
    }, null, 2));
    return;
  }

  console.log('');
  const scope = query ? `${sessions.length} matching "${query}"` : `${sessions.length} of ${total}`;
  console.log(c.bold('  Saved Sessions') + c.dim(` (${scope})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (sessions.length === 0) {
    console.log(c.dim(query ? '  No session matches that search.' : '  No sessions saved yet. Use veto_session_save inside an AI session.'));
  } else {
    for (const s of sessions) {
      const date = new Date(s.created_at).toLocaleString();
      const badge = s.save_type === 'auto' ? c.dim(' [auto]') : '';
      console.log(`  ${c.cyan(s.id.slice(0, 8))}  ${c.dim(date)}  ${c.bold(s.platform ?? 'claude')}${badge}  ${s.summary?.slice(0, 60) ?? ''}`);
    }
  }
  console.log('');
  if (!query && sessions.length < total) console.log(c.dim(`  ${total - sessions.length} older not shown — veto sessions --all, --limit N, or add a search word`));
  console.log(c.dim('  Resume one: veto continue <first 8 characters> --as <claude|codex|gemini|antigravity>'));
  console.log(c.dim('  Tip: veto sessions --clean  removes auto-saves older than 7 days'));
  console.log('');
}

async function memoryCommand() {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  // veto memory export [--format=markdown] [--output=path]
  if (subcommand === 'export') {
    const formatArg = args.find(a => a.startsWith('--format='));
    const outputArg = args.find(a => a.startsWith('--output='));
    const format = formatArg?.split('=')[1] ?? 'json';
    const outputPath = outputArg?.split('=')[1];
    const { exportMemory, exportMemoryMarkdown } = await import('./memory/sync.js');
    if (format === 'markdown') {
      const cwd = resolve(process.cwd());
      const result = exportMemoryMarkdown(cwd, outputPath);
      if (result.success) {
        console.log(c.green('  ✓') + ` VETO_MEMORY.md written to ${result.output_path}`);
        console.log(c.dim(`  Sections: ${JSON.stringify(result.sections)}`));
      } else {
        console.error(c.red(`  ✗ Export failed: ${result.error}`));
      }
    } else {
      const result = exportMemory(outputPath);
      if (result.success) {
        console.log(c.green('  ✓') + ` Exported to ${result.export_path}`);
      } else {
        console.error(c.red(`  ✗ Export failed: ${result.error}`));
      }
    }
    return;
  }

  // veto memory import [--format=markdown] <path>
  if (subcommand === 'import') {
    const formatArg = args.find(a => a.startsWith('--format='));
    const format = formatArg?.split('=')[1] ?? 'json';
    const inputPath = args.find(a => !a.startsWith('--')) ?? '';
    const { importMemory, importMemoryMarkdown } = await import('./memory/sync.js');
    if (format === 'markdown') {
      if (!inputPath) { console.error(c.red('  ✗ Provide a file path: veto memory import --format=markdown <path>')); return; }
      const result = importMemoryMarkdown(inputPath);
      console.log(result.success ? c.green('  ✓') + ` ${result.message}` : c.red(`  ✗ ${result.message}`));
    } else {
      const result = importMemory(inputPath || undefined);
      console.log(result.success ? c.green('  ✓') + ` Import complete` : c.red(`  ✗ Import failed: ${result.error}`));
    }
    return;
  }

  // veto memory [query]
  const query = args.join(' ') || undefined;
  const { searchKnowledge } = await import('./memory/local.js');
  const results = searchKnowledge({ query, limit: 20 });

  console.log('');
  console.log(c.bold('  Knowledge Base') + (query ? c.dim(` — "${query}"`) : '') + c.dim(` (${results.length} results)`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (results.length === 0) {
    console.log(c.dim('  No entries found.'));
  } else {
    for (const r of results) {
      const tags = r.tags ? JSON.parse(r.tags).join(', ') : '';
      console.log(`  ${c.cyan(`[${r.type}]`)} ${c.bold(r.title)}`);
      if (tags) console.log(`  ${c.dim('tags: ' + tags)}`);
      console.log(`  ${c.dim(r.content.slice(0, 100).replace(/\n/g, ' ') + (r.content.length > 100 ? '...' : ''))}`);
      console.log('');
    }
  }
}

async function patternsCommand() {
  const { getPatterns } = await import('./memory/local.js');
  const prefix = process.argv[3];
  const patterns = getPatterns(prefix, 30);

  console.log('');
  console.log(c.bold('  Learned Patterns') + c.dim(` (${patterns.length})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────────────'));

  if (patterns.length === 0) {
    console.log(c.dim('  No patterns yet. Record outcomes with veto_record_outcome to build up patterns.'));
  } else {
    for (const p of patterns) {
      const conf = Math.round(p.confidence * 100);
      const confColor = conf >= 80 ? c.green : conf >= 60 ? c.yellow : c.dim;
      console.log(`  ${confColor(`${conf}%`)}  ${c.cyan(p.pattern_key)}  ${c.dim('→')}  ${p.pattern_val}  ${c.dim(`(seen ${p.seen_count}x)`)}`);
    }
  }
  console.log('');
}

async function statuslineCommand() {
  const sub = process.argv[3] ?? 'status';
  const args = process.argv.slice(4);
  const clientArg = args.find(a => a.startsWith('--client='))?.split('=')[1] ?? 'claude';
  const force = args.includes('--force') || args.includes('--yes') || args.includes('-y');
  const dryRun = args.includes('--dry-run');

  const sl = await import('./cli/statusline.js');

  // Codex and Gemini cannot run a status-line command, so their line is drawn by
  // Veto itself: `watch` in a split pane, or `print --client=…` for one line
  // (tmux status-right, scripts). Nothing here reads stdin or writes a file.
  const hostClient = clientArg === 'codex' || clientArg === 'gemini' ? clientArg : null;
  const projectFlag = args.find(a => a.startsWith('--dir='))?.slice('--dir='.length);
  const projectDir = resolve(projectFlag || process.cwd());

  if (sub === 'watch') {
    const hosts = await import('./cli/statusline-hosts.js');
    const explicit = args.find(a => a.startsWith('--client='))?.split('=')[1];
    const host = explicit === 'claude' || explicit === 'codex' || explicit === 'gemini' ? explicit : undefined;
    const seconds = Number(args.find(a => a.startsWith('--interval='))?.split('=')[1] ?? 5);
    await hosts.watchStatusline({ host, projectDir, intervalMs: (Number.isFinite(seconds) ? seconds : 5) * 1000 });
    process.exit(0);
  }

  if (sub === 'print' && hostClient) {
    const hosts = await import('./cli/statusline-hosts.js');
    process.stdout.write(hosts.renderHostStatusline(hostClient, projectDir) + '\n', () => process.exit(0));
    return;
  }

  if (sub === 'install' && hostClient) {
    const hosts = await import('./cli/statusline-hosts.js');
    console.log('');
    console.log('  ' + hosts.watchSetupGuide(hostClient, projectDir).replace(/\n/g, '\n  '));
    console.log('');
    return;
  }

  // Hot path: one line to stdout, nothing else. No banner, no colors-config noise.
  if (sub === 'print') {
    // --capture <file>: verification aid — log the raw Claude Code payload next to
    // the rendered line so you can compare the actual context % against `ctx N%`.
    const capIdx = args.indexOf('--capture');
    const capturePath = capIdx !== -1 ? args[capIdx + 1] : undefined;
    await sl.printStatusline({}, capturePath);
    // Exit promptly: the line is already flushed, and we must not linger holding an
    // open stdin handle if the parent kept the pipe open on this per-render hot path.
    process.exit(0);
  }

  if (sub === 'install') {
    const r = sl.installStatusline(clientArg, { force, dryRun });
    console.log('');
    console.log((r.ok ? c.green('  ✓ ') : c.red('  ✗ ')) + r.message.replace(/\n/g, '\n  '));
    if (r.ok && r.changed) console.log(c.dim('\n  Restart your AI CLI to see the Veto line. Remove with: veto statusline uninstall'));
    console.log('');
    if (!r.ok) process.exit(1);
    return;
  }

  if (sub === 'uninstall') {
    const r = sl.uninstallStatusline(clientArg);
    console.log('');
    console.log((r.ok ? c.green('  ✓ ') : c.red('  ✗ ')) + r.message);
    console.log('');
    if (!r.ok) process.exit(1);
    return;
  }

  if (sub === 'status') {
    const info = sl.statuslineStatusInfo(clientArg);
    console.log('');
    console.log(c.bold('  Veto Statusline'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  Installed:  ${info.installed ? c.green('yes') : c.dim('no')}`);
    if (info.settingsPath) console.log(`  Settings:   ${c.dim(info.settingsPath)}`);
    console.log(`  Sample:     ${info.sample}`);
    console.log('');
    console.log(c.dim('  Claude Code: veto statusline install [--force] [--dry-run]'));
    console.log(c.dim('  Codex / Gemini (no custom status line): veto statusline watch — runs in a pane beside the AI;'));
    console.log(c.dim('    setup for your terminal: veto statusline install --client=codex|gemini'));
    console.log('');
    return;
  }

  console.error(c.red(`  Unknown statusline subcommand: ${sub}`));
  console.error(c.dim('  Usage: veto statusline <install|uninstall|print|status|watch> [--client=claude|codex|gemini] [--dir=<project>] [--interval=<seconds>]'));
  process.exit(1);
}

async function transcriptsCommand() {
  const sub = process.argv[3] ?? 'status';
  const args = process.argv.slice(4);
  const { enableCapture, disableCapture, captureStatus, consentText } = await import('./transcripts/config.js');

  if (sub === 'enable') {
    const r = enableCapture();
    console.log('');
    console.log(c.green(c.bold('  ✓ Transcript capture enabled')));
    console.log('');
    console.log('  ' + consentText(r.dir, r.retention_days).replace(/\n/g, '\n  '));
    console.log('');
    if (r.reconsented) console.log(c.dim('  (Disclosure changed since you last enabled — consent re-recorded.)\n'));
    return;
  }

  if (sub === 'disable') {
    disableCapture();
    console.log('');
    console.log(c.yellow('  ✓ Transcript capture disabled.') + c.dim(' Existing archives are kept — remove them with: veto transcripts purge'));
    console.log('');
    return;
  }

  if (sub === 'status') {
    const s = captureStatus();
    const { transcriptsDiskUsage, fmtBytes } = await import('./transcripts/manage.js');
    let disk; try { disk = transcriptsDiskUsage(); } catch { disk = null; }
    console.log('');
    console.log(c.bold('  Veto Transcript Capture'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    const state = s.effective ? c.green('enabled') : s.needsReconsent ? c.yellow('needs re-consent — run: veto transcripts enable') : c.dim('disabled');
    console.log(`  Capture:     ${state}`);
    console.log(`  Archive dir: ${c.dim(s.dir)}${s.usingDefaultDir ? c.dim('  (default)') : ''}`);
    console.log(`  Retention:   ${s.retention_days} days`);
    if (disk) console.log(`  Disk usage:  ${fmtBytes(disk.totalBytes)} ${c.dim(`(${disk.archives} session(s); ${fmtBytes(disk.archiveBytes)} archives + ${fmtBytes(disk.dbBytes)} index)`)}`);
    if (s.consent_at) console.log(`  Consent:     ${c.dim(`v${s.consent_version} · accepted ${s.consent_at}`)}`);
    if (s.cloudSyncWarning) console.log(c.yellow(`  ⚠ Archive dir looks cloud-synced (${s.cloudSyncWarning}) — consider a local path.`));
    console.log('');
    console.log(c.dim('  enable · disable · list · sources · metric · show <id> · purge <id>|--project <dir>|--all'));
    console.log('');
    return;
  }

  // Codex and Gemini publish no session mapping of their own, so what capture
  // can see for them is whatever discovery finds on disk. Showing that is the
  // difference between "capture is on" and "capture will actually work here".
  // The v3.0 success metric. Derived from data Veto already records; see
  // transcripts/metric.ts for what it can and cannot answer.
  if (sub === 'metric') {
    const { recallMetric, renderRecallMetric } = await import('./transcripts/metric.js');
    const m = recallMetric();
    console.log('');
    console.log(renderRecallMetric(m).replace(/^ {2}/gm, '  '));
    console.log('');
    if (args.includes('--json')) console.log(JSON.stringify(m, null, 2));
    return;
  }

  if (sub === 'sources') {
    const { discoverCodexSessions, discoverGeminiSessions, codexSessionsDir, geminiTmpDir } =
      await import('./transcripts/discover.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    // projectKey, not normalizeProjectDir: Gemini records `d:\veto` for D:\Veto.
    const { projectKey } = await import('./transcripts/project-key.js');
    const want = projFlag ? projectKey(projFlag) : null;
    console.log('');
    console.log(c.bold('  Transcript sources'));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  ${c.cyan('claude')}  ${c.dim('mapped live by the statusline, or found in ~/.claude/projects at save time')}`);
    for (const [name, find, dir] of [
      ['codex', discoverCodexSessions, codexSessionsDir()],
      ['gemini', discoverGeminiSessions, geminiTmpDir()],
    ] as const) {
      let rows: { sourceSessionId: string; projectDir: string | null; mtimeMs: number }[] = [];
      try { rows = find(); } catch { rows = []; }
      const shown = want ? rows.filter(r => r.projectDir && projectKey(r.projectDir) === want) : rows;
      console.log(`  ${c.cyan(name)}  ${c.dim(dir)}`);
      if (shown.length === 0) console.log(c.dim(`     (no sessions discovered${want ? ' for this project' : ''})`));
      for (const r of shown.slice(0, 5)) {
        console.log(`     ${r.sourceSessionId.slice(0, 8)}…  ${c.dim(new Date(r.mtimeMs).toISOString())}  ${r.projectDir ?? c.dim('(unknown project)')}`);
      }
      if (shown.length > 5) console.log(c.dim(`     … and ${shown.length - 5} more`));
    }
    console.log('');
    console.log(c.dim('  Discovered sessions are archived at save time when you pass platform=<source>.'));
    console.log('');
    return;
  }

  if (sub === 'list') {
    const { listArchives, fmtBytes } = await import('./transcripts/manage.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const rows = listArchives({ projectDir: projFlag });
    console.log('');
    console.log(c.bold(`  Archived transcripts${projFlag ? ` (project ${projFlag})` : ''}`));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    if (rows.length === 0) console.log(c.dim('  (none captured yet)'));
    for (const r of rows) {
      console.log(`  ${c.cyan(r.sourceSessionId)}  ${c.dim(r.source)}  ${r.events} ev  ${fmtBytes(r.archiveBytes)}  ${c.dim(r.updatedAt)}${r.indexed ? '' : c.yellow(' (unindexed)')}`);
      if (r.projectDir) console.log(`     ${c.dim(r.projectDir)}`);
    }
    console.log('');
    return;
  }

  if (sub === 'show') {
    // Any CLI's session by default; --source=<claude|codex|gemini> narrows it.
    const id = args.find(a => !a.startsWith('--'));
    const source = args.find(a => a.startsWith('--source='))?.split('=')[1];
    if (!id) { console.error(c.red('  Usage: veto transcripts show <source_session_id> [--source=claude|codex|gemini]')); process.exit(1); }
    const { showArchive, fmtBytes } = await import('./transcripts/manage.js');
    const { renderTOC } = await import('./transcripts/toc.js');
    const { renderFacts } = await import('./transcripts/pyramid.js');
    const d = showArchive(id, source);
    if (!d) { console.error(c.red(`  No archive for session ${id}`)); process.exit(1); }
    console.log('');
    console.log(c.bold(`  Transcript ${id}`));
    console.log(c.dim('  ─────────────────────────────────────────────────────'));
    console.log(`  ${d.summary.events} events · ${fmtBytes(d.summary.archiveBytes)} · captured ${d.summary.capturedAt}`);
    console.log('');
    console.log(c.bold('  Facts')); console.log('  ' + renderFacts(d.facts).replace(/\n/g, '\n  '));
    console.log('');
    console.log(c.bold(`  Table of contents (${d.toc.length} phases)`));
    console.log('  ' + renderTOC(d.toc).replace(/\n/g, '\n  '));
    console.log('');
    return;
  }

  if (sub === 'purge') {
    const { purgeSession, purgeProject, purgeAll } = await import('./transcripts/manage.js');
    const projFlag = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const source = args.find(a => a.startsWith('--source='))?.split('=')[1];
    const all = args.includes('--all');
    const id = args.find(a => !a.startsWith('--'));
    let r;
    if (all) r = purgeAll();
    else if (projFlag) r = purgeProject(projFlag);
    else if (id) r = purgeSession(id, source);
    else { console.error(c.red('  Usage: veto transcripts purge <source_session_id> [--source=claude|codex|gemini] | --project=<dir> | --all')); process.exit(1); }
    console.log('');
    // Nothing matched is not a success: say so instead of a green "✓ Purged 0".
    if (r.archives === 0 && r.mappings === 0) {
      console.log(c.yellow(`  ⚠ Nothing matched${id && !all && !projFlag ? ` session ${id}` : ''} — no archive was deleted. See ${c.cyan('veto transcripts list')}.`));
    } else {
      console.log(c.green(`  ✓ Purged ${r.archives} archive(s): ${r.events} events, ${r.indexRows} index rows, ${r.files} file(s), ${r.mappings} mapping(s) removed.`));
    }
    console.log('');
    return;
  }

  console.error(c.red(`  Unknown transcripts subcommand: ${sub}`));
  console.error(c.dim('  Usage: veto transcripts <enable|disable|status|list|show|purge>'));
  process.exit(1);
}

function shortHelpCommand() {
  console.log('');
  console.log(c.bold(c.cyan('  veto')) + c.dim(` v${VERSION}`) + c.dim(` — 93 agentic tools. 49 specialists. Every major AI CLI. Zero extra cost on subscriptions.`));
  console.log('');
  console.log(c.bold('  CLI Commands'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('veto init')}                    Configure all AI tools + scan project`);
  console.log(`  ${c.cyan('veto doctor')}                  Per app: registered? starts? last started by it? + health`);
  console.log(`  ${c.cyan('veto doctor --quick')}          Same, without launching the server to test it`);
  console.log(`  ${c.cyan('veto doctor --fix')}            Also rename old Veto guides left in Codex/Gemini files`);
  console.log(`  ${c.cyan('veto status')}                  Version, DB path, memory/session counts`);
  console.log(`  ${c.cyan('veto sessions')} ${c.dim('[words] [--all|--limit N] [--json]')}`);
  console.log(`                         Saved sessions (newest 20 by default; says how many exist)`);
  console.log(`  ${c.cyan('veto continue')} ${c.dim('[id|prefix] [--as <client>] [--json]')}`);
  console.log(`                         Restore a session from a terminal — same code as veto_continue,`);
  console.log(`                         for when an app did not load Veto's tools`);
  console.log(`  ${c.cyan('veto tools')} ${c.dim('[filter]')}         List all MCP tools (--json supported)`);
  console.log(`  ${c.cyan('veto agents')} ${c.dim('[filter]')}        List all worker + council agents (--json)`);
  console.log(`  ${c.cyan('veto memory')} ${c.dim('[query]')}         Search knowledge base`);
  console.log(`  ${c.cyan('veto patterns')} ${c.dim('[prefix]')}      List learned agent/routing patterns`);
  console.log(`  ${c.cyan('veto routing')} ${c.dim('[status|enable|disable|reset|log]')}`);
  console.log(`                         Routing feedback loop (opt-in signal storage)`);
  console.log(`  ${c.cyan('veto statusline')} ${c.dim('[install|uninstall|print|status|watch]')}`);
  console.log(`                         Compact Veto line under your AI CLI prompt (Claude Code),`);
  console.log(`                         or in a pane beside Codex/Gemini: veto statusline watch`);
  console.log(`  ${c.cyan('veto transcripts')} ${c.dim('[enable|disable|status]')}`);
  console.log(`                         Opt-in local session-transcript capture (off by default)`);
  console.log(`  ${c.cyan('veto lessons')} ${c.dim('[on|list|why|forget|flows|off|exclude|include|alias|recheck]')}`);
  console.log(`                         Notes your AIs wrote in their own memory: see them, where they may go, stop them`);
  console.log(`  ${c.cyan('veto version')}                 Show version (alias for status)`);
  console.log(`  ${c.cyan('veto hook install')}            Install pre-commit secrets scan hook`);
  console.log(`  ${c.cyan('veto hook remove')}             Remove the veto pre-commit hook`);
  console.log(`  ${c.cyan('veto check')}                   Scan staged changes for secrets (used by hook)`);
  console.log(`  ${c.cyan('veto help')}                    Show this help`);
  console.log(`  ${c.cyan('veto help --troubleshoot')}     Show troubleshooting guide`);
  console.log('');
  console.log(c.bold('  MCP Tools (93 Agentic Tools)'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('Session')}       veto_status · veto_session_save · veto_session_restore · veto_sessions_list · veto_session_replay · veto_autosave_status · veto_snapshot`);
  console.log(`  ${c.dim('Council')}       veto_council_debate · veto_benchmark · veto_adr`);
  console.log(`  ${c.dim('Intelligence')}  veto_agent_plan · veto_execute_parallel · veto_explain · veto_delegate · veto_compose_agents`);
  console.log(`  ${c.dim('Scanning')}      veto_code_review · veto_security_scan · veto_secrets_scan · veto_diff_review · veto_full_review · veto_pr_review`);
  console.log(`  ${c.dim('Pipelines')}     veto_workflow · veto_task_parse · veto_new_feature · veto_pre_commit · veto_ci_gate`);
  console.log(`  ${c.dim('Watching')}      veto_watch · veto_watch_poll · veto_watch_stop`);
  console.log(`  ${c.dim('Advanced')}      veto_local_llm · veto_semantic_search · veto_sdd_agent · veto_playwright · veto_notify_ide · veto_translate · veto_a11y_advisor`);
  console.log(`  ${c.dim('Quality')}       veto_type_coverage · veto_test_gaps · veto_clone_detector · veto_lint_rules · veto_api_contract`);
  console.log(`  ${c.dim('Discovery')}     veto_discover · veto_summarize · veto_git_blame · veto_changelog · veto_onboard · veto_debt_register`);
  console.log(`  ${c.dim('DevTools')}      veto_docs_fetch · veto_context_status · veto_openapi_gen · veto_flag_auditor · veto_env_setup · veto_diagram · veto_rca`);
  console.log(`                veto_commit_message · veto_pr_description · veto_pr_post · veto_prompt_optimizer · veto_sre_advisor · veto_merge_conflict`);
  console.log(`  ${c.dim('System')}        veto_route_task · veto_rate_status · veto_audit_log · veto_health · veto_metrics · veto_learning_stats · veto_learning_apply · veto_handoff · veto_continue · veto_platform_setup · veto_plugins`);
  console.log('');
  console.log(c.bold('  MCP Resources'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('veto://sessions')}              All saved sessions`);
  console.log(`  ${c.cyan('veto://project-map?dir=<path>')} Project structure map`);
  console.log(`  ${c.cyan('veto://memory?q=<query>')}      Knowledge base search`);
  console.log(`  ${c.cyan('veto://patterns')}              Learned patterns`);
  console.log('');
  console.log(c.bold('  MCP Prompts'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.cyan('code-review')} · ${c.cyan('security-audit')} · ${c.cyan('deploy-checklist')} · ${c.cyan('explain-file')}`);
  console.log(`  ${c.cyan('full-review')} · ${c.cyan('new-feature')} · ${c.cyan('debug-incident')} · ${c.cyan('onboard')}`);
  console.log('');
  console.log(c.bold('  Docs & Support'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.dim('GitHub:')}  https://github.com/jigyasudham/veto`);
  console.log(`  ${c.dim('Issues:')} https://github.com/jigyasudham/veto/issues`);
  console.log(`  ${c.dim('npm:')}     https://www.npmjs.com/package/@jigyasudham/veto`);
  console.log('');
}

function troubleshootCommand() {
  console.log('');
  console.log(c.bold('  Troubleshooting'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  ${c.yellow('Veto not available in a new VS Code window / project')}`);
  console.log(`  ${c.dim('→')} Claude Code: MCP must be registered at user scope, not project scope`);
  console.log(`  ${c.dim('→')} Run: ${c.cyan('claude mcp add veto -s user -- npx -y --package @jigyasudham/veto@latest veto-server')}`);
  console.log(`  ${c.dim('→')} The ${c.cyan('-s user')} flag makes Veto global across ALL windows and projects`);
  console.log(`  ${c.dim('→')} Gemini / Cursor / Windsurf / Zed: run ${c.cyan('veto init')} once — config is written globally`);
  console.log('');
  console.log(`  ${c.yellow('MCP disconnected / tools not loading')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} again, then fully restart your AI client (Claude / Gemini / Cursor / Windsurf / Zed)`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto doctor')} — it shows, per app, whether the app lists Veto, whether it starts, and when that app last started it`);
  console.log(`  ${c.dim('→')} Check Node.js version: ${c.cyan('node --version')}  (need >= 22.13, or >= 23.4)`);
  console.log('');
  console.log(`  ${c.yellow('veto command not found')}`);
  console.log(`  ${c.dim('→')} The bare ${c.cyan('veto')} command comes from a global install: ${c.cyan('npm i -g @jigyasudham/veto')}`);
  console.log(`  ${c.dim('→')} Safe to install: MCP configs pin ${c.cyan('@latest')}, so a global copy cannot shadow the server`);
  console.log(`  ${c.dim('→')} No-install alternative: ${c.cyan('npx -y @jigyasudham/veto@latest <command>')}`);
  console.log(`  ${c.dim('→')} From source:    ${c.cyan('npm run build && npm link')}`);
  console.log('');
  console.log(`  ${c.yellow('Tools missing in Claude / Gemini after install')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto init')} to write / regenerate the MCP config`);
  console.log(`  ${c.dim('→')} Fully quit and reopen the AI client (not just reload)`);
  console.log(`  ${c.dim('→')} Until the app is fixed, an AI there can still restore a session: ${c.cyan('veto continue <id> --as <client>')}`);
  console.log(`  ${c.dim('→')} Antigravity reads ${c.dim('~/.gemini/config/mcp_config.json')} — an entry in ~/.gemini/antigravity-cli/ does nothing`);
  console.log('');
  console.log(`  ${c.yellow('Old version still showing after update')}`);
  console.log(`  ${c.dim('→')} The MCP config is pinned to ${c.cyan('@latest')} — fully restart the AI client to fetch it`);
  console.log(`  ${c.dim('→')} If the config predates 2.7.1 (no ${c.cyan('@latest')} pin), re-run ${c.cyan('veto init')} to rewrite it`);
  console.log(`  ${c.dim('→')} The global CLI updates separately: ${c.cyan('npm i -g @jigyasudham/veto@latest')}`);
  console.log(`  ${c.dim('→')} Confirm: ${c.cyan('veto doctor')} (compares both against the registry's latest)`);
  console.log('');
  console.log(`  ${c.yellow('Database / SQLite errors on startup')}`);
  console.log(`  ${c.dim('→')} Requires Node.js >= 22.13 or >= 23.4 (uses built-in node:sqlite)`);
  console.log(`  ${c.dim('→')} Check ${c.dim('~/.veto')} directory exists and is writable`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} to see the active DB path`);
  console.log('');
  console.log(`  ${c.yellow('Memory or sessions not persisting between chats')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} — verify DB path and memory count`);
  console.log(`  ${c.dim('→')} Ensure ${c.dim('~/.veto')} is not on a read-only or temp volume`);
  console.log('');
  console.log(`  ${c.yellow('Permission denied on Windows (PowerShell)')}`);
  console.log(`  ${c.dim('→')} ${c.cyan('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned')}`);
  console.log(`  ${c.dim('→')} Or run terminal as Administrator and retry`);
  console.log('');
  console.log(`  ${c.yellow('Rate limit / too many requests errors')}`);
  console.log(`  ${c.dim('→')} Use ${c.cyan('veto_rate_status')} tool to check current usage`);
  console.log(`  ${c.dim('→')} Wait a moment, then retry — limits reset per minute`);
  console.log('');
  console.log(`  ${c.yellow('veto init fails on first run')}`);
  console.log(`  ${c.dim('→')} Veto does not require an API key — it uses your existing AI subscriptions via MCP`);
  console.log(`  ${c.dim('→')} Ensure Node.js >= 22.13 and run ${c.cyan('veto init')} from your project directory`);
  console.log(`  ${c.dim('→')} Check that your AI client (Claude Code / Gemini / Codex / Antigravity) is installed`);
  console.log('');
  console.log(`  ${c.yellow('veto_health shows degraded / components failing')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('veto status')} for a summary of all components`);
  console.log(`  ${c.dim('→')} Check ${c.cyan('veto_audit_log')} for recent error events`);
  console.log(`  ${c.dim('→')} Re-run ${c.cyan('veto init')} to repair config and rescan project`);
  console.log('');
  console.log(`  ${c.yellow('Installed via npx but MCP disconnects after restart')}`);
  console.log(`  ${c.dim('→')} npx runs temporarily — it does NOT add veto-server to PATH permanently`);
  console.log(`  ${c.dim('→')} Fix: run ${c.cyan('npx veto init')} again so the config is rewritten with the correct npx command`);
  console.log(`  ${c.dim('→')} The rewritten config pins ${c.cyan('@latest')}, so each restart fetches the newest version — no global install needed`);
  console.log('');
  console.log(`  ${c.yellow('Installed on a new machine but MCP not working')}`);
  console.log(`  ${c.dim('→')} Run ${c.cyan('npx @jigyasudham/veto init')} on the new machine — config is not transferred`);
  console.log(`  ${c.dim('→')} Each machine needs its own init run to register the MCP server`);
  console.log(`  ${c.dim('→')} Then restart the AI client on that machine`);
  console.log('');
}

// ─── Routing Command ────────────────────────────────────────────────────────────

async function routingCommand() {
  const { getRoutingFeedbackStats, resetRoutingFeedback, listRoutingFeedback, isFeedbackEnabled, setFeedbackEnabled } = await import('./router/learning-updater.js');
  const sub = process.argv[3];

  if (sub === 'enable') {
    setFeedbackEnabled(true);
    console.log('');
    console.log(c.green('  ✓ Routing feedback enabled.'));
    console.log(c.dim('  Every veto_route_task call now records a routing signal (30-day TTL).'));
    console.log(c.dim('  Disable with: veto routing disable  |  Clear with: veto routing reset'));
    console.log('');
    return;
  }

  if (sub === 'disable') {
    setFeedbackEnabled(false);
    console.log('');
    console.log(c.yellow('  ✓ Routing feedback disabled.'));
    console.log(c.dim('  No new signals will be recorded. Existing data is retained.'));
    console.log(c.dim('  Re-enable with: veto routing enable'));
    console.log('');
    return;
  }

  if (sub === 'reset') {
    const result = resetRoutingFeedback();
    console.log('');
    console.log(c.green('  ✓ Routing feedback reset.'));
    console.log(`  ${c.dim('Deleted:')} ${c.cyan(String(result.deleted_feedback))} feedback signal${result.deleted_feedback !== 1 ? 's' : ''}`);
    if (result.reset_thresholds) {
      console.log(`  ${c.dim('Thresholds:')} reset to defaults (30/70)`);
    }
    console.log('');
    return;
  }

  if (sub === 'log') {
    const limit = parseInt(process.argv[4] ?? '20', 10);
    const entries = listRoutingFeedback(isNaN(limit) ? 20 : limit);
    console.log('');
    console.log(c.bold('  Routing Feedback Log') + c.dim(` (${entries.length})`));
    console.log(c.dim('  ─────────────────────────────────────────────────────────────'));
    if (entries.length === 0) {
      console.log(c.dim('  No feedback signals yet. Enable feedback: veto routing enable'));
    } else {
      for (const e of entries) {
        const outcomeColor = e.outcome === 'accepted' ? c.green : e.outcome === 'overridden' ? c.yellow : c.dim;
        const exp = new Date(e.expires_at).toLocaleDateString();
        console.log(`  ${c.dim(e.recorded_at.slice(0, 10))}  T${e.model_tier}  ${outcomeColor(e.outcome.padEnd(10))}  ${c.dim(`q:${e.quality ?? '-'}`)}  ${e.task_snippet.slice(0, 55)}`);
        console.log(`  ${c.dim(`  expires: ${exp}  agent: ${e.agent ?? 'dynamic'}`)}`);
        console.log('');
      }
    }
    return;
  }

  // Default: status
  const stats = getRoutingFeedbackStats();
  const enabled = isFeedbackEnabled();
  const statusStr = enabled ? c.green('enabled') : c.dim('disabled');

  console.log('');
  console.log(c.bold('  Routing Feedback') + c.dim(' — loop status'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  console.log(`  Status      ${statusStr}`);
  console.log(`  TTL         ${c.cyan(String(stats.ttl_days))} days`);
  console.log(`  Signals     ${c.cyan(String(stats.active))} active · ${c.dim(String(stats.expired))} expired · ${String(stats.total)} total`);
  if (Object.keys(stats.by_outcome).length > 0) {
    const parts = Object.entries(stats.by_outcome).map(([k, v]) => `${k}: ${v}`).join(' · ');
    console.log(`  Outcomes    ${c.dim(parts)}`);
  }
  if (Object.keys(stats.by_tier).length > 0) {
    const parts = Object.entries(stats.by_tier).map(([tier, s]) => `T${tier}: ${s.count} (q${s.avg_quality ?? '-'})`).join(' · ');
    console.log(`  By tier     ${c.dim(parts)}`);
  }
  if (stats.next_expiry) {
    console.log(`  Next expiry ${c.dim(new Date(stats.next_expiry).toLocaleDateString())}`);
  }
  console.log('');
  console.log(c.dim(`  Commands: veto routing enable · veto routing disable · veto routing reset · veto routing log`));
  console.log('');
}

// ─── Hook installer ────────────────────────────────────────────────────────────

async function hookCommand() {
  const sub = process.argv[3];
  if (sub !== 'install' && sub !== 'remove') {
    console.error(c.red(`  Usage: veto hook install  |  veto hook remove`));
    process.exit(1);
  }

  // Walk up to find .git directory
  let gitDir: string | null = null;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.git'))) { gitDir = join(dir, '.git'); break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!gitDir) {
    console.error(c.red('  Not a git repository (or any parent up to 10 levels).'));
    process.exit(1);
  }

  const hookPath = join(gitDir, 'hooks', 'pre-commit');

  if (sub === 'remove') {
    if (!existsSync(hookPath)) {
      console.log(c.dim('  No pre-commit hook found.'));
      return;
    }
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes('veto check')) {
      console.log(c.yellow('  ⚠ Hook exists but was not created by veto. Not removed.'));
      console.log(c.dim(`    Path: ${hookPath}`));
      return;
    }
    unlinkSync(hookPath);
    console.log(c.green('  ✓ Veto pre-commit hook removed.'));
    return;
  }

  // install
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes('veto check')) {
      console.log(c.yellow('  ⚠ A pre-commit hook already exists and was not created by veto.'));
      console.log(c.dim(`    Inspect it before overwriting: ${hookPath}`));
      process.exit(1);
    }
    console.log(c.green('  ✓ Veto pre-commit hook already installed.'));
    return;
  }

  const script = [
    '#!/bin/sh',
    '# Veto pre-commit hook — secrets scan on staged changes',
    '# Generated by: veto hook install  |  Remove with: veto hook remove',
    'if command -v veto >/dev/null 2>&1; then',
    '  exec veto check',
    'else',
    '  exec npx -y @jigyasudham/veto check',
    'fi',
  ].join('\n') + '\n';

  writeFileSync(hookPath, script, { mode: 0o755 });
  console.log('');
  console.log(c.green('  ✓') + ` Pre-commit hook installed at ${c.dim(hookPath)}`);
  console.log(c.dim('  Scans staged changes for secrets before every commit.'));
  console.log(c.dim('  Remove with: veto hook remove'));
  console.log('');
}

// ─── Secrets check (for pre-commit hook) ───────────────────────────────────────

async function checkCommand() {
  const { scan } = await import('./agents/security/secrets.js');

  let diff = '';
  try {
    diff = execSync('git diff --cached', { windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { /* not a git repo or git not available */ }

  if (!diff.trim()) {
    console.log(c.green('  ✓ Veto: no staged changes to scan.'));
    process.exit(0);
  }

  // Only scan added lines; skip diff headers
  const added = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');

  const findings = scan(added);
  const blocking = findings.filter(f => f.severity === 'critical' || f.severity === 'high');

  if (findings.length === 0) {
    console.log(c.green('  ✓ Veto secrets scan: clean'));
    process.exit(0);
  }

  console.log('');
  console.log(c.bold('  Veto Secrets Scan'));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  for (const f of findings) {
    const sev = f.severity === 'critical' ? c.red(f.severity)
              : f.severity === 'high'     ? c.yellow(f.severity)
              : c.dim(f.severity);
    console.log(`  ${sev}  ${c.bold(f.type)}  ${c.dim(`line ${f.line}`)}  ${c.dim(f.value)}`);
    console.log(`         ${c.dim(f.fix)}`);
    console.log('');
  }

  if (blocking.length > 0) {
    console.log(c.red(`  ✗ Blocked: ${blocking.length} critical/high secret${blocking.length !== 1 ? 's' : ''} in staged changes.`));
    console.log(c.dim('  Fix the issues above, re-stage, and commit again.'));
    console.log('');
    process.exit(1);
  }

  console.log(c.yellow(`  ⚠ ${findings.length} medium/low finding${findings.length !== 1 ? 's' : ''} — commit allowed. Review above.`));
  console.log('');
  process.exit(0);
}

// ─── Tools / Agents listings ────────────────────────────────────────────────────

// The 7 Council personas debated by veto_council_debate. They live as separate
// modules under src/council/ (no shared manifest), so the roster is mirrored here
// for the listing. Keep in sync with src/council/decision-engine.ts.
const COUNCIL_AGENTS = [
  { id: 'Lead Developer',     role: 'Implementation feasibility and code-level risk (can block).' },
  { id: 'Product Manager',    role: 'User value, scope, and priority trade-offs.' },
  { id: 'System Architect',   role: 'Architecture fit, scalability, and long-term design (can block).' },
  { id: 'UX Designer',        role: 'Usability, accessibility, and user-facing impact.' },
  { id: "Devil's Advocate",   role: 'Probes every failure mode — always raises concerns.' },
  { id: 'Legal & Compliance', role: 'Licensing, privacy, and regulatory exposure (can block).' },
  { id: 'Security',           role: 'Threat model and vulnerability surface (can block).' },
];

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// veto tools [filter] [--json] — lists the MCP tools straight from TOOL_DEFINITIONS
// (the same source the server registers) so the listing can never drift.
async function toolsCommand() {
  const { TOOL_DEFINITIONS } = await import('./tools/definitions.js');
  const asJson = process.argv.includes('--json');
  const filter = process.argv.slice(3).find(a => !a.startsWith('--'))?.toLowerCase();

  let tools = TOOL_DEFINITIONS.map(t => ({ name: t.name, description: t.description }));
  if (filter) tools = tools.filter(t => t.name.toLowerCase().includes(filter) || t.description.toLowerCase().includes(filter));

  if (asJson) {
    console.log(JSON.stringify({ count: tools.length, tools }, null, 2));
    return;
  }

  console.log('');
  console.log(c.bold('  Veto MCP Tools') + c.dim(` (${tools.length}${filter ? ` matching "${filter}"` : ` of ${TOOL_DEFINITIONS.length}`})`));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));
  if (tools.length === 0) {
    console.log(c.dim('  No tools match that filter.'));
  } else {
    const width = Math.max(...tools.map(t => t.name.length));
    for (const t of tools) {
      console.log(`  ${c.cyan(t.name.padEnd(width))}  ${c.dim(truncate(t.description, 64))}`);
    }
  }
  console.log('');
  console.log(c.dim('  Tip: veto tools <filter>  filters by name/description  ·  --json for machine output'));
  console.log('');
}

// veto agents [filter] [--json] — lists the 43 worker specialists from AGENT_MANIFEST
// (grouped by domain) plus the 7 Council personas.
async function agentsCommand() {
  const { AGENT_MANIFEST } = await import('./agents/manifest.js');
  const asJson = process.argv.includes('--json');
  const filter = process.argv.slice(3).find(a => !a.startsWith('--'))?.toLowerCase();

  const match = (s: string) => !filter || s.toLowerCase().includes(filter);
  const workers = AGENT_MANIFEST
    .map(a => ({ id: a.id, role: a.role, output_type: a.output_type, domain: a.domain }))
    .filter(a => match(a.id) || match(a.role) || match(a.domain));
  const council = COUNCIL_AGENTS.filter(a => match(a.id) || match(a.role));

  if (asJson) {
    console.log(JSON.stringify({
      worker_agents: { count: workers.length, agents: workers },
      council_agents: { count: council.length, agents: council },
    }, null, 2));
    return;
  }

  console.log('');
  console.log(c.bold('  Veto Agents') + c.dim(` — ${workers.length} worker specialists + ${council.length} council`));
  console.log(c.dim('  ─────────────────────────────────────────────────────'));

  if (workers.length === 0 && council.length === 0) {
    console.log(c.dim('  No agents match that filter.'));
    console.log('');
    return;
  }

  for (const domain of [...new Set(workers.map(a => a.domain))]) {
    const inDomain = workers.filter(a => a.domain === domain);
    const width = Math.max(...inDomain.map(a => a.id.length));
    console.log('');
    console.log(`  ${c.bold(domain)} ${c.dim(`(${inDomain.length})`)}`);
    for (const a of inDomain) {
      const badge = a.output_type === 'analysis' ? c.yellow('analysis') : c.dim('plan    ');
      console.log(`    ${c.cyan(a.id.padEnd(width))}  ${badge}  ${c.dim(truncate(a.role, 58))}`);
    }
  }

  if (council.length > 0) {
    const width = Math.max(...council.map(a => a.id.length));
    console.log('');
    console.log(`  ${c.bold('council')} ${c.dim(`(${council.length})`)} ${c.dim('— 7-agent debate via veto_council_debate')}`);
    for (const a of council) {
      console.log(`    ${c.cyan(a.id.padEnd(width))}  ${c.dim(truncate(a.role, 60))}`);
    }
  }

  console.log('');
  console.log(c.dim('  Worker agents run via veto_route_task / veto_agent_plan · council via veto_council_debate'));
  console.log(c.dim('  Tip: veto agents <filter>  ·  --json for machine output'));
  console.log('');
}

// ─── Router ────────────────────────────────────────────────────────────────────

const command = process.argv[2] ?? 'init';

switch (command) {
  case 'init':
    initCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'status':
    statusCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'sessions':
    sessionsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'continue':
  case 'resume':
    import('./cli/continue.js')
      .then(async ({ runContinueCommand }) => { process.exitCode = await runContinueCommand(process.argv.slice(3)); })
      .catch((err) => {
        console.error(c.red(`Error: ${err.message}`));
        process.exit(1);
      })
      // The server module this reuses can hold timers open; the answer is already out.
      .finally(() => process.exit(process.exitCode ?? 0));
    break;

  case 'memory':
    memoryCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'patterns':
    patternsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'tools':
    toolsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'agents':
    agentsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'doctor':
    doctorCommand(process.argv.includes('--fix'), process.argv.includes('--quick')).catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'routing':
    routingCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'statusline':
    statuslineCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'transcripts':
    transcriptsCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'lessons':
    import('./cli/lessons.js')
      .then(async ({ runLessonsCommand }) => { process.exitCode = await runLessonsCommand(process.argv.slice(3)); })
      .catch((err) => {
        console.error(c.red(`Error: ${err.message}`));
        process.exit(1);
      });
    break;

  case 'hook':
    hookCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'check':
    checkCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'version':
  case 'v':
    statusCommand().catch((err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(1);
    });
    break;

  // Conventional version flags — print the concise version and exit.
  case '--version':
  case '-v':
  case '-V':
    console.log(`veto v${VERSION}`);
    break;

  case 'help':
  case '--help':
  case '-h':
    if (process.argv[3] === '--troubleshoot') {
      troubleshootCommand();
    } else {
      shortHelpCommand();
    }
    break;

  default:
    console.error(c.red(`  Unknown command: ${command}`));
    console.error(c.dim(`  Run ${c.cyan('veto help')} for usage.`));
    process.exit(1);
}
