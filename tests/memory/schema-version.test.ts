import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, resetDb } from '../../src/memory/local.js';
import { VETO_DB_SCHEMA_VERSION } from '../../src/memory/schema.js';

beforeEach(() => resetDb());

describe('veto.db read-contract drift marker', () => {
  it('stamps PRAGMA user_version with the current schema version', () => {
    const db = getDb();
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(VETO_DB_SCHEMA_VERSION);
  });

  it('exposes every column external readers depend on (stable read surface)', () => {
    const db = getDb();
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

    expect(cols('sessions')).toEqual(expect.arrayContaining(
      ['id', 'platform', 'active_client', 'started_at', 'summary', 'token_count', 'project_dir', 'created_at']));
    expect(cols('council_outcomes')).toEqual(expect.arrayContaining(
      ['id', 'verdict', 'lead_dev', 'pm', 'architect', 'ux', 'devil', 'legal', 'security', 'recommended', 'debated_at']));
    expect(cols('patterns')).toEqual(expect.arrayContaining(
      ['pattern_key', 'pattern_val', 'confidence', 'seen_count', 'updated_at']));
    expect(cols('rate_usage')).toEqual(expect.arrayContaining(
      ['platform', 'request_count', 'token_count', 'date_key']));
    expect(cols('knowledge_base')).toEqual(expect.arrayContaining(
      ['id', 'title', 'tags', 'project_dir', 'type', 'created_at']));
    expect(cols('learning_data')).toEqual(expect.arrayContaining(
      ['model_tier', 'agent', 'output_quality']));
    expect(cols('scan_diagnostics')).toEqual(expect.arrayContaining(
      ['file_path', 'line', 'col_start', 'message', 'severity', 'source']));
  });
});
