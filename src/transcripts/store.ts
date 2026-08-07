// Sidecar transcripts.db connection + additive migration runner
// (VERSION-3 item 6, Step 2).
//
// Opened lazily (node:sqlite is a Node 22.5+ built-in; loaded via createRequire
// so bundlers skip it and older runtimes degrade gracefully). WAL + busy_timeout
// let the HUD keep reading veto.db while capture writes here without lock
// contention. This module NEVER opens veto.db — the two DBs stay isolated.

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { effectiveTranscriptsDir } from './config.js';
import { MIGRATIONS, TRANSCRIPTS_SCHEMA_VERSION } from './schema.js';

const _require = createRequire(import.meta.url);
let _DbSync: typeof import('node:sqlite').DatabaseSync | null = null;

function requireDbSync(): typeof import('node:sqlite').DatabaseSync {
  if (!_DbSync) {
    _DbSync = (_require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  }
  return _DbSync;
}

/** True when node:sqlite can be loaded — capture is silently unavailable otherwise. */
export function transcriptsAvailable(): boolean {
  try { requireDbSync(); return true; } catch { return false; }
}

/** Root dir for all transcript data (archives + sidecar DB). Env override for tests. */
export function transcriptsRoot(): string {
  return process.env.VETO_TRANSCRIPTS_DIR ?? effectiveTranscriptsDir();
}

/** Path to the sidecar index DB. Env override for tests (mirrors VETO_TEST_DB). */
export function transcriptsDbPath(): string {
  return process.env.VETO_TRANSCRIPTS_DB ?? join(transcriptsRoot(), 'index.db');
}

/** Dir holding the L0 .gz archive files (populated in Step 5). */
export function archiveDir(): string {
  return join(transcriptsRoot(), 'archives');
}

let _db: DatabaseSync | null = null;
let _openedPath: string | null = null;

export function resetTranscriptsDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
    _openedPath = null;
  }
}

export function getTranscriptsDb(): DatabaseSync {
  const path = transcriptsDbPath();
  if (_db && _openedPath === path) return _db;
  if (_db) resetTranscriptsDb();
  const DbSync = requireDbSync();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DbSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  _db = db;
  _openedPath = path;
  return db;
}

/**
 * Apply every migration newer than the DB's current user_version, each in its
 * own transaction. Idempotent: re-running is a no-op once caught up. Returns the
 * resulting schema version.
 */
export function runMigrations(db: DatabaseSync): number {
  let applied = readUserVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version > applied) {
      db.exec('BEGIN');
      try {
        db.exec(m.up);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
        applied = m.version;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  return applied;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function schemaVersion(db: DatabaseSync = getTranscriptsDb()): number {
  return readUserVersion(db);
}

export { TRANSCRIPTS_SCHEMA_VERSION };
