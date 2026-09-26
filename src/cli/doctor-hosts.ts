// The "is Veto actually working in each app" part of `veto doctor`.
//
// Three independent signals per installed host, weakest to strongest:
//   1. registration — what the host's own `mcp list` says (or, without its CLI,
//      the file it reads). Catches: wrong file, disabled entry, entry missing.
//   2. probe — the configured command, launched here, answers MCP. Catches: npx
//      cannot reach the registry, a broken install, a server that dies on start.
//   3. host start — the server recorded that THIS host launched it, with which
//      Node, and whether SQLite loaded there (host-starts.ts). The only signal
//      that sees the host's own environment.
// A host is only reported healthy on what it has shown, and every ✓ says which
// signal it rests on.

import { hostSpecs, serverCommand, type HostSpec } from './hosts.js';
import { inspectHost, isWorking, type HostReport } from './register.js';
import { probeServer, type ProbeResult } from './probe.js';
import { readHostStarts, startsForHost, type HostStart } from '../host-starts.js';

export type HostDiagnosis = {
  report: HostReport;
  probe: ProbeResult | null;
  starts: HostStart[];
  level: 'ok' | 'warn' | 'fail' | 'absent';
  headline: string;
  details: string[];
  fix: string | null;
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

const STATE_TEXT: Record<string, string> = {
  connected: 'connected',
  enabled: 'registered (enabled)',
  listed: 'registered',
  'in-file': 'registered',
  failed: 'registered, but the app reports it FAILED to connect',
  disabled: 'registered, but DISABLED in the app',
  'in-file-disabled': 'registered, but DISABLED in the app',
  missing: 'not registered',
  unreadable: 'config file unreadable',
};

function fixFor(spec: HostSpec, report: HostReport): string | null {
  if (report.state === 'disabled' || report.state === 'in-file-disabled') {
    // Only agy's `mcp enable` has been verified to exist.
    if (spec.id === 'antigravity') return 'agy mcp enable veto';
    return spec.config ? `turn veto back on in ${spec.name}'s MCP settings (${spec.config.path})` : `turn veto back on in ${spec.name}'s MCP settings`;
  }
  if (report.state === 'missing' || report.state === 'unreadable' || report.state === 'failed') {
    // Without the app's own CLI on PATH, `veto init` cannot register a host
    // that keeps servers in its own registry (Claude Code) — give the command.
    if (spec.cli && report.installed.via !== 'path' && !spec.config) {
      const { command, args } = serverCommand();
      return `${[spec.cli.bin, ...spec.cli.add(command, args)].join(' ')}   (from a terminal where \`${spec.cli.bin}\` works)`;
    }
    return 'veto init   (then fully restart the app)';
  }
  return null;
}

export function diagnoseHost(report: HostReport, probe: ProbeResult | null, allStarts: HostStart[], latestVersion: string | null, now = Date.now()): HostDiagnosis {
  const spec = report.spec;
  const starts = startsForHost(spec.id, allStarts).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const details: string[] = [];
  if (!report.installed.installed) return { report, probe, starts, level: 'absent', headline: `${spec.name} — not installed`, details, fix: null };

  let level: HostDiagnosis['level'] = isWorking(report.state) ? 'ok' : 'fail';
  let headline = `${spec.name} — ${STATE_TEXT[report.state] ?? report.state}`;
  details.push(`source: ${report.source}`);
  if (report.note) details.push(report.note);

  if (report.legacyOnly) {
    level = 'fail';
    headline = `${spec.name} — Veto is only in ${spec.legacyConfigs?.[0]}, a file ${spec.name} no longer reads`;
  } else if ((spec.legacyConfigs ?? []).length && level === 'ok') {
    details.push(`an old Veto entry may remain in ${spec.legacyConfigs![0]} — harmless, ${spec.name} ignores that file`);
  }

  if (probe) {
    if (probe.ok) details.push(`launch test: answered in ${(probe.ms / 1000).toFixed(1)} s — Veto ${probe.serverVersion ?? '?'}, ${probe.tools} tools`);
    else {
      details.push(`launch test FAILED: ${probe.error}`);
      if (level === 'ok') level = 'fail';
    }
    if (probe.hint) { details.push(probe.hint); if (level === 'ok') level = 'warn'; }
  }

  const latest = starts[0];
  if (latest) {
    details.push(`last started by ${latest.client}${latest.client_version ? ` ${latest.client_version}` : ''} ${ago(latest.last_seen, now)} — Veto ${latest.veto_version}, Node ${latest.node_version}`);
    if (!latest.sqlite_ok) {
      level = 'fail';
      details.push(`that Node cannot load node:sqlite — nothing Veto saves from ${spec.name} persists. The app launches ${latest.exec_path}; Veto needs Node >= 22.13`);
    }
    if (latestVersion && latest.veto_version !== latestVersion) {
      details.push(`it ran Veto ${latest.veto_version}; ${latestVersion} is current — fully restart ${spec.name} to pick it up`);
    }
  } else if (isWorking(report.state)) {
    details.push(`no start by ${spec.name} recorded yet (recording began with Veto 3.7.0) — after restarting it, run veto doctor again`);
  }

  return { report, probe, starts, level, headline, details, fix: level === 'fail' ? fixFor(spec, report) : null };
}

/** Inspect every host, launch each distinct configured command once, and diagnose. */
export async function diagnoseHosts(options: { probe?: boolean; latestVersion?: string | null; specs?: HostSpec[] } = {}): Promise<HostDiagnosis[]> {
  const specs = options.specs ?? hostSpecs();
  const reports = specs.map(spec => inspectHost(spec));
  const probes = new Map<string, Promise<ProbeResult>>();
  if (options.probe !== false) {
    for (const r of reports) {
      if (!r.installed.installed || !r.entry || !isWorking(r.state)) continue;
      const key = JSON.stringify([r.entry.command, r.entry.args]);
      if (!probes.has(key)) probes.set(key, probeServer(r.entry.command, r.entry.args));
    }
  }
  const starts = readHostStarts();
  const out: HostDiagnosis[] = [];
  for (const r of reports) {
    const key = r.entry ? JSON.stringify([r.entry.command, r.entry.args]) : '';
    const probe = probes.has(key) ? await probes.get(key)! : null;
    out.push(diagnoseHost(r, probe, starts, options.latestVersion ?? null));
  }
  return out;
}
