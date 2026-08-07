import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_DB = join(tmpdir(), `veto-mapping-${Date.now()}-${process.pid}.db`);
process.env.VETO_TRANSCRIPTS_DB = TEST_DB;

const { parseClaudeSession } = await import('../../src/cli/statusline.js');
const { recordSessionMapping, getSessionMapping, latestMappingForProject } =
  await import('../../src/transcripts/mapping.js');
const { resetTranscriptsDb, getTranscriptsDb } = await import('../../src/transcripts/store.js');

afterAll(() => {
  resetTranscriptsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  delete process.env.VETO_TRANSCRIPTS_DB;
});

describe('parseClaudeSession', () => {
  it('extracts session_id + transcript_path + workspace dir from a Claude Code payload', () => {
    const raw = JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/home/me/.claude/projects/x/sess-abc.jsonl',
      workspace: { current_dir: 'D:\\Veto', project_dir: 'D:\\Veto' },
      context_window: { used_percentage: 42 },
    });
    const ref = parseClaudeSession(raw);
    expect(ref).not.toBeNull();
    expect(ref!.sessionId).toBe('sess-abc');
    expect(ref!.transcriptPath).toContain('sess-abc.jsonl');
    expect(ref!.projectDir).toBe('D:\\Veto');
  });

  it('returns null when either id is missing, or JSON is bad/empty', () => {
    expect(parseClaudeSession(JSON.stringify({ transcript_path: '/x.jsonl' }))).toBeNull(); // no session_id
    expect(parseClaudeSession(JSON.stringify({ session_id: 's' }))).toBeNull();              // no transcript_path
    expect(parseClaudeSession('not json')).toBeNull();
    expect(parseClaudeSession('')).toBeNull();
  });

  it('falls back through workspace.project_dir then cwd for the dir', () => {
    const ref = parseClaudeSession(JSON.stringify({
      session_id: 's', transcript_path: '/t.jsonl', cwd: '/home/me/proj',
    }));
    expect(ref!.projectDir).toBe('/home/me/proj');
  });
});

describe('session_map round-trip', () => {
  it('records and reads back a mapping (project dir normalized)', () => {
    recordSessionMapping({
      sourceSessionId: 'sess-1',
      transcriptPath: '/home/me/.claude/projects/x/sess-1.jsonl',
      projectDir: 'D:\\Veto', // uppercase drive
    });
    const row = getSessionMapping('sess-1');
    expect(row).not.toBeNull();
    expect(row!.transcript_path).toContain('sess-1.jsonl');
    expect(row!.project_dir).toBe('d:\\Veto'); // drive-letter canonicalized
    expect(row!.source).toBe('claude');
  });

  it('UPSERTs: re-recording the same session updates path + last_seen, no duplicate row', () => {
    recordSessionMapping({ sourceSessionId: 'sess-2', transcriptPath: '/a/old.jsonl', projectDir: 'd:\\p' });
    const first = getSessionMapping('sess-2')!;
    recordSessionMapping({ sourceSessionId: 'sess-2', transcriptPath: '/a/new.jsonl', projectDir: 'd:\\p' });
    const second = getSessionMapping('sess-2')!;
    expect(second.transcript_path).toBe('/a/new.jsonl');
    expect(second.last_seen_at >= first.last_seen_at).toBe(true);
  });
});

describe('latestMappingForProject — newest active mapping (S5 concurrency rule)', () => {
  it('returns the most recently seen session for a project', () => {
    const proj = 'd:\\concurrent';
    recordSessionMapping({ sourceSessionId: 'old', transcriptPath: '/o.jsonl', projectDir: proj });
    // Force a strictly later timestamp for the second mapping.
    const later = new Date(Date.now() + 1000).toISOString();
    getTranscriptsDb().prepare(
      `INSERT INTO session_map (source, source_session_id, transcript_path, project_dir, last_seen_at)
       VALUES ('claude','new','/n.jsonl',?,?)`
    ).run(proj, later);

    const latest = latestMappingForProject(proj);
    expect(latest!.source_session_id).toBe('new');
    expect(latest!.transcript_path).toBe('/n.jsonl');
  });

  it('returns null for a project with no mappings', () => {
    expect(latestMappingForProject('d:\\nonexistent-xyz')).toBeNull();
  });
});
