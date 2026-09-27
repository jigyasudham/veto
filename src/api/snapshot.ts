// `veto api snapshot` — what the extension's cards show, read without changing
// anything.
//
// The rest of Veto opens its databases through getDb()/getTranscriptsDb(),
// which migrate on open, and the lessons commands refresh what they report
// before reporting it. None of that may happen here: this process switches both
// databases to read-only connections first, so the existing status functions
// run unchanged, and any write one of them attempted would fail rather than
// happen. No harvesting, trial pass, discovery or indexing is called.

import { existsSync } from 'node:fs';
import type { Envelope } from './contract.js';
import { captureLabel, dbMismatch, envelope, sectionError, type ApiContext } from './common.js';

type Section = Record<string, unknown> & { state: 'ok' | 'unavailable' | 'error'; message?: string };

function attempt(build: () => Record<string, unknown>): Section {
  try {
    return { state: 'ok', ...build() };
  } catch (err) {
    return sectionError(err);
  }
}

export async function apiSnapshot(ctx: ApiContext, req: { project: string; db?: string }): Promise<Envelope> {
  const mismatch = await dbMismatch(ctx, req.db);
  if (mismatch) return mismatch;

  const local = await import('../memory/local.js');
  if (!local.sqliteAvailable()) {
    return envelope(ctx, 'sqlite_unavailable', {
      message: `Node ${process.version} cannot load node:sqlite, so Veto cannot read its data.`,
      next_action: 'Use Node 22.13 or later (or 23.4 or later).',
    });
  }
  const { normalizeProjectDir } = local;
  const { projectKey, projectKeySql } = await import('../transcripts/project-key.js');
  const { VETO_DB_SCHEMA_VERSION } = await import('../memory/schema.js');
  const dir = normalizeProjectDir(req.project);

  // ── veto.db ──
  const dbPath = local.getDbPath();
  const dbExists = dbPath === ':memory:' || existsSync(dbPath);
  let database: Section;
  if (!dbExists) {
    database = { state: 'unavailable', message: 'No Veto database yet — it is created the first time Veto starts.' };
  } else {
    database = attempt(() => {
      local.useReadOnlyDb();
      const version = (local.getDb().prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      return { schema_version: version, expected_schema_version: VETO_DB_SCHEMA_VERSION, newer_than_backend: version > VETO_DB_SCHEMA_VERSION };
    });
  }
  const dbReadable = database.state === 'ok';
  const noDb = (): Section => ({ state: 'unavailable', message: database.message ?? 'The Veto database could not be read.' });

  // ── transcripts ──
  const capture = await captureLabel();
  const transcripts = await (async (): Promise<Section> => {
    try {
      const store = await import('../transcripts/store.js');
      const base = { capture, recall_permitted: true };
      if (!store.useReadOnlyTranscriptsDb()) {
        return { state: 'ok', ...base, archives_in_project: 0, archives_all_projects: 0, by_source_in_project: {}, last_archived_at: null };
      }
      const db = store.getTranscriptsDb();
      const all = (db.prepare('SELECT COUNT(*) AS n FROM archives').get() as { n: number }).n;
      const rows = db.prepare(`SELECT source, COUNT(*) AS n, MAX(updated_at) AS last FROM archives WHERE ${projectKeySql('project_dir')} = ? GROUP BY source`)
        .all(projectKey(dir)) as Array<{ source: string; n: number; last: string | null }>;
      return {
        state: 'ok', ...base,
        archives_in_project: rows.reduce((sum, r) => sum + r.n, 0),
        archives_all_projects: all,
        by_source_in_project: Object.fromEntries(rows.map(r => [r.source, r.n])),
        last_archived_at: rows.map(r => r.last).filter((t): t is string => !!t).sort().pop() ?? null,
      };
    } catch (err) {
      return sectionError(err);
    }
  })();

  // ── lessons + trial (veto.db) ──
  let lessons: Section = noDb();
  let trial: Section = noDb();
  if (dbReadable) {
    const { lessonsStatus } = await import('../lessons/manage.js');
    const { trialStatus } = await import('../lessons/trial.js');
    lessons = attempt(() => {
      const s = lessonsStatus();
      return {
        sharing: s.sharing ? 'on' : s.needsReconsent ? 'reconsent_required' : 'off',
        scope: 'all_projects',
        notes: s.notes,
        by_host: s.byHost,
        any_project: s.anyProject,
        held: s.held,
        unresolved_folders: s.unresolved,
        // A count only: the list names the user's folders.
        excluded_projects: s.excluded.length,
        disabled_hosts: [...s.disabledHosts].map(([host, reason]) => ({ host, reason })),
      };
    });
    trial = (() => {
      try {
        const t = trialStatus();
        if (!t) return { state: 'unavailable', message: 'No trial is running — it starts when lessons sharing is accepted.' };
        return {
          state: 'ok', mode: 'shadow', started_at: t.startedAt, ends_at: t.endsAt, qualifying: t.qualifying, target: t.target,
          complete: t.complete, outcomes: t.byOutcome, drift: t.drift,
        };
      } catch (err) {
        return sectionError(err);
      }
    })();
  }

  return envelope(ctx, 'ok', {
    data: { project: { dir, key: projectKey(dir) }, database, transcripts, lessons, trial },
  });
}
