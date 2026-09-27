// `veto api diagnostics` — the checks `veto doctor` makes, as data.
//
// The per-app rows come from diagnoseHosts(), the same function doctor renders,
// so the two cannot disagree. By default nothing slow runs: each app's config
// file is read, not its CLI, and nothing is launched. `checks` asks for more:
//   host_cli — run each app's own `mcp list` (what the app itself reports);
//   probe    — launch the configured server and see it answer (timed out).
// No network check: doctor's "is a newer version out" asks npm, and an
// extension showing status has no business doing that on the user's behalf.

import { existsSync } from 'node:fs';
import type { Envelope } from './contract.js';
import { API_CONTRACT } from './contract.js';
import { dbMismatch, envelope, maskHome, sectionError, type ApiContext } from './common.js';

export async function apiDiagnostics(ctx: ApiContext, req: { checks: Array<'host_cli' | 'probe'>; db?: string }): Promise<Envelope> {
  const mismatch = await dbMismatch(ctx, req.db);
  if (mismatch) return mismatch;

  const local = await import('../memory/local.js');
  const sqliteOk = local.sqliteAvailable();
  const { VETO_DB_SCHEMA_VERSION } = await import('../memory/schema.js');

  let database: Record<string, unknown>;
  const dbPath = local.getDbPath();
  if (!sqliteOk) database = { state: 'unavailable', message: `Node ${process.version} cannot load node:sqlite.` };
  else if (dbPath !== ':memory:' && !existsSync(dbPath)) database = { state: 'unavailable', message: 'No Veto database yet — it is created the first time Veto starts.' };
  else {
    try {
      local.useReadOnlyDb();
      const version = (local.getDb().prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      database = { state: 'ok', schema_version: version, expected_schema_version: VETO_DB_SCHEMA_VERSION, newer_than_backend: version > VETO_DB_SCHEMA_VERSION };
    } catch (err) {
      database = sectionError(err);
    }
  }

  const useCli = req.checks.includes('host_cli');
  const probe = req.checks.includes('probe');
  const { diagnoseHosts } = await import('../cli/doctor-hosts.js');
  const diagnoses = await diagnoseHosts({ probe, useCli, latestVersion: null });
  const hosts = diagnoses.map(d => {
    const last = [...d.starts].sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
    return {
      id: d.report.spec.id,
      name: d.report.spec.name,
      installed: d.report.installed.installed,
      registration: d.report.state,
      source: maskHome(d.report.source),
      level: d.level,
      headline: maskHome(d.headline),
      details: d.details.map(line => maskHome(line)),
      fix: d.fix ? maskHome(d.fix) : null,
      probe: d.probe ? { ok: d.probe.ok, ms: d.probe.ms ?? null, server_version: d.probe.serverVersion ?? null, tools: d.probe.tools ?? null } : null,
      last_start: last ? {
        client: last.client, at: last.last_seen, veto_version: last.veto_version, node_version: last.node_version, sqlite_ok: last.sqlite_ok,
      } : null,
    };
  });

  return envelope(ctx, 'ok', {
    data: {
      backend: { version: ctx.version, contract: API_CONTRACT, node_version: process.version, sqlite_ok: sqliteOk },
      database,
      checked: { host_cli: useCli, probe },
      authentication: 'not_checked',
      hosts,
    },
  });
}
