// Memory export/import — file-based cross-machine continuity
// No external services. Export to JSON, copy the file, import on another machine.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb, getDbPath } from './local.js';

const DEFAULT_EXPORT_PATH = join(homedir(), '.veto', 'veto-export.json');

export type ExportResult = {
  success: boolean;
  export_path: string;
  exported: Record<string, number>;
  exported_at: string;
  error?: string;
  next_step: string;
};

export type ImportResult = {
  success: boolean;
  import_path: string;
  merged: Record<string, number>;
  skipped: Record<string, number>;
  imported_at: string;
  error?: string;
};

export type DbSizeResult = {
  db_path: string;
  tables: Record<string, number>;
};

export function exportMemory(outputPath?: string): ExportResult {
  const exportPath = outputPath ?? DEFAULT_EXPORT_PATH;
  const db = getDb();

  try {
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
    const decisions = db.prepare('SELECT * FROM decisions ORDER BY made_at DESC').all();
    const knowledge = db.prepare('SELECT * FROM knowledge_base ORDER BY created_at DESC').all();
    const patterns = db.prepare('SELECT * FROM patterns ORDER BY confidence DESC').all();
    const projectMaps = db.prepare('SELECT * FROM project_map ORDER BY updated_at DESC').all();
    const councilOutcomes = db.prepare('SELECT * FROM council_outcomes ORDER BY debated_at DESC').all();

    const payload = {
      veto_export_version: 1,
      exported_at: new Date().toISOString(),
      db_path: getDbPath(),
      data: {
        sessions,
        decisions,
        knowledge_base: knowledge,
        patterns,
        project_map: projectMaps,
        council_outcomes: councilOutcomes,
      },
    };

    writeFileSync(exportPath, JSON.stringify(payload, null, 2), 'utf-8');

    const exported = {
      sessions: sessions.length,
      decisions: decisions.length,
      knowledge_base: knowledge.length,
      patterns: patterns.length,
      project_map: projectMaps.length,
      council_outcomes: councilOutcomes.length,
    };

    return {
      success: true,
      export_path: exportPath,
      exported,
      exported_at: payload.exported_at,
      next_step: `Copy ${exportPath} to your other machine, then call veto_memory_import with that file path.`,
    };
  } catch (err) {
    return {
      success: false,
      export_path: exportPath,
      exported: {},
      exported_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      next_step: 'Fix the error above and retry.',
    };
  }
}

export function importMemory(inputPath?: string): ImportResult {
  const importPath = inputPath ?? DEFAULT_EXPORT_PATH;

  if (!existsSync(importPath)) {
    return {
      success: false,
      import_path: importPath,
      merged: {},
      skipped: {},
      imported_at: new Date().toISOString(),
      error: `File not found: ${importPath}. Run veto_memory_export on your other machine first, then copy the file here.`,
    };
  }

  const db = getDb();
  const merged: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  try {
    const raw = readFileSync(importPath, 'utf-8');
    const payload = JSON.parse(raw) as {
      veto_export_version: number;
      data: Record<string, Record<string, unknown>[]>;
    };

    if (payload.veto_export_version !== 1) {
      throw new Error(`Unknown export version: ${payload.veto_export_version}`);
    }

    const { sessions = [], decisions = [], knowledge_base = [], patterns = [], project_map = [], council_outcomes = [] } = payload.data;

    merged['sessions'] = 0; skipped['sessions'] = 0;
    for (const s of sessions) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO sessions
          (id, started_at, ended_at, platform, project_dir, summary, context, task_state, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(s['id'] ?? ''), String(s['started_at'] ?? ''),
        s['ended_at'] != null ? String(s['ended_at']) : null,
        String(s['platform'] ?? 'claude'),
        s['project_dir'] != null ? String(s['project_dir']) : null,
        s['summary'] != null ? String(s['summary']) : null,
        s['context'] != null ? String(s['context']) : null,
        s['task_state'] != null ? String(s['task_state']) : null,
        typeof s['token_count'] === 'number' ? s['token_count'] : 0,
        String(s['created_at'] ?? new Date().toISOString())
      ) as { changes: number };
      if (r.changes > 0) merged['sessions']++; else skipped['sessions']++;
    }

    merged['decisions'] = 0; skipped['decisions'] = 0;
    for (const d of decisions) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO decisions
          (id, session_id, made_at, decision, rationale, council_verdict, files_affected, overridden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(d['id'] ?? ''), String(d['session_id'] ?? ''),
        String(d['made_at'] ?? ''), String(d['decision'] ?? ''),
        d['rationale'] != null ? String(d['rationale']) : null,
        d['council_verdict'] != null ? String(d['council_verdict']) : null,
        d['files_affected'] != null ? String(d['files_affected']) : null,
        typeof d['overridden'] === 'number' ? d['overridden'] : 0
      ) as { changes: number };
      if (r.changes > 0) merged['decisions']++; else skipped['decisions']++;
    }

    merged['knowledge_base'] = 0; skipped['knowledge_base'] = 0;
    for (const k of knowledge_base) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO knowledge_base
          (id, type, title, content, tags, project_dir, session_id, relevance, accessed_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(k['id'] ?? ''),
        k['type'] != null ? String(k['type']) : 'solution',
        String(k['title'] ?? ''), String(k['content'] ?? ''),
        k['tags'] != null ? String(k['tags']) : null,
        k['project_dir'] != null ? String(k['project_dir']) : null,
        k['session_id'] != null ? String(k['session_id']) : null,
        typeof k['relevance'] === 'number' ? k['relevance'] : 1.0,
        typeof k['accessed_count'] === 'number' ? k['accessed_count'] : 0,
        String(k['created_at'] ?? new Date().toISOString()),
        String(k['updated_at'] ?? new Date().toISOString())
      ) as { changes: number };
      if (r.changes > 0) merged['knowledge_base']++; else skipped['knowledge_base']++;
    }

    merged['patterns'] = 0; skipped['patterns'] = 0;
    for (const p of patterns) {
      const existing = db.prepare('SELECT seen_count, confidence FROM patterns WHERE pattern_key = ?').get(String(p['pattern_key'] ?? '')) as { seen_count: number; confidence: number } | undefined;
      if (existing) {
        // Merge: take higher confidence, sum seen counts
        const mergedConf = Math.max(existing.confidence, typeof p['confidence'] === 'number' ? p['confidence'] : 1.0);
        const mergedCount = existing.seen_count + (typeof p['seen_count'] === 'number' ? p['seen_count'] : 1);
        db.prepare('UPDATE patterns SET confidence = ?, seen_count = ?, updated_at = ? WHERE pattern_key = ?')
          .run(mergedConf, mergedCount, new Date().toISOString(), String(p['pattern_key'] ?? ''));
        skipped['patterns']++;
      } else {
        db.prepare(`
          INSERT INTO patterns (id, pattern_key, pattern_val, confidence, seen_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          String(p['id'] ?? ''), String(p['pattern_key'] ?? ''),
          String(p['pattern_val'] ?? ''),
          typeof p['confidence'] === 'number' ? p['confidence'] : 1.0,
          typeof p['seen_count'] === 'number' ? p['seen_count'] : 1,
          String(p['updated_at'] ?? new Date().toISOString())
        );
        merged['patterns']++;
      }
    }

    merged['project_map'] = 0; skipped['project_map'] = 0;
    for (const m of project_map) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO project_map (id, project_dir, structure, key_modules, tech_stack, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        String(m['id'] ?? ''), String(m['project_dir'] ?? ''),
        String(m['structure'] ?? '{}'),
        m['key_modules'] != null ? String(m['key_modules']) : null,
        m['tech_stack'] != null ? String(m['tech_stack']) : null,
        String(m['updated_at'] ?? new Date().toISOString())
      ) as { changes: number };
      if (r.changes > 0) merged['project_map']++; else skipped['project_map']++;
    }

    merged['council_outcomes'] = 0; skipped['council_outcomes'] = 0;
    for (const c of council_outcomes) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO council_outcomes
          (id, session_id, task, verdict, lead_dev, pm, architect, ux, devil, legal, security, recommended, debated_at, project_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(c['id'] ?? ''),
        c['session_id'] != null ? String(c['session_id']) : null,
        String(c['task'] ?? ''), String(c['verdict'] ?? ''),
        c['lead_dev'] != null ? String(c['lead_dev']) : null,
        c['pm'] != null ? String(c['pm']) : null,
        c['architect'] != null ? String(c['architect']) : null,
        c['ux'] != null ? String(c['ux']) : null,
        c['devil'] != null ? String(c['devil']) : null,
        c['legal'] != null ? String(c['legal']) : null,
        c['security'] != null ? String(c['security']) : null,
        c['recommended'] != null ? String(c['recommended']) : null,
        String(c['debated_at'] ?? new Date().toISOString()),
        c['project_dir'] != null ? String(c['project_dir']) : null
      ) as { changes: number };
      if (r.changes > 0) merged['council_outcomes']++; else skipped['council_outcomes']++;
    }

    return {
      success: true,
      import_path: importPath,
      merged,
      skipped,
      imported_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      import_path: importPath,
      merged,
      skipped,
      imported_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MarkdownExportResult {
  success: boolean;
  output_path: string;
  sections: Record<string, number>;
  exported_at: string;
  error?: string;
}

export function exportMemoryMarkdown(projectDir?: string, outputPath?: string): MarkdownExportResult {
  const outPath = outputPath ?? (projectDir ? join(projectDir, 'VETO_MEMORY.md') : join(homedir(), '.veto', 'VETO_MEMORY.md'));
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const knowledge = db.prepare(
      `SELECT * FROM knowledge_base${projectDir ? ' WHERE project_dir = ?' : ''} ORDER BY created_at DESC LIMIT 100`
    ).all(...(projectDir ? [projectDir] : [])) as Record<string, unknown>[];

    const patterns = db.prepare(
      'SELECT * FROM patterns ORDER BY confidence DESC LIMIT 50'
    ).all() as Record<string, unknown>[];

    const decisions = db.prepare(
      'SELECT * FROM decisions ORDER BY made_at DESC LIMIT 30'
    ).all() as Record<string, unknown>[];

    const sessions = db.prepare(
      `SELECT id, platform, summary, project_dir, started_at FROM sessions${projectDir ? ' WHERE project_dir = ?' : ''} ORDER BY started_at DESC LIMIT 20`
    ).all(...(projectDir ? [projectDir] : [])) as Record<string, unknown>[];

    const lines: string[] = [
      `# Veto Memory Export`,
      `> Generated: ${now}${projectDir ? ` | Project: ${projectDir}` : ''}`,
      `> Import with: \`veto init\` (auto-detected) or \`veto memory import --format=markdown\``,
      '',
    ];

    if (knowledge.length > 0) {
      lines.push('## Knowledge Base', '');
      for (const k of knowledge) {
        lines.push(`### ${k['title'] ?? 'Untitled'}`);
        lines.push(`**Type:** ${k['type']} | **Created:** ${k['created_at']}`);
        if (k['tags']) lines.push(`**Tags:** ${k['tags']}`);
        lines.push('');
        lines.push(String(k['content'] ?? '').slice(0, 600));
        lines.push('');
      }
    }

    if (patterns.length > 0) {
      lines.push('## Learned Patterns', '');
      for (const p of patterns) {
        lines.push(`- **${p['pattern_key']}** (confidence: ${p['confidence']}, seen: ${p['seen_count']})`);
        lines.push(`  ${String(p['pattern_val'] ?? '').slice(0, 200)}`);
        lines.push('');
      }
    }

    if (decisions.length > 0) {
      lines.push('## Architecture Decisions', '');
      for (const d of decisions) {
        lines.push(`### ${d['decision']}`);
        lines.push(`**Made:** ${d['made_at']} | **Verdict:** ${d['council_verdict'] ?? 'manual'}`);
        if (d['rationale']) lines.push('', String(d['rationale']).slice(0, 400));
        lines.push('');
      }
    }

    if (sessions.length > 0) {
      lines.push('## Session History', '');
      for (const s of sessions) {
        lines.push(`- **[${s['platform']}]** ${s['started_at']} — ${String(s['summary'] ?? 'No summary').slice(0, 120)}`);
      }
      lines.push('');
    }

    const content = lines.join('\n');
    writeFileSync(outPath, content, 'utf-8');

    return {
      success: true,
      output_path: outPath,
      sections: {
        knowledge_base: knowledge.length,
        patterns: patterns.length,
        decisions: decisions.length,
        sessions: sessions.length,
      },
      exported_at: now,
    };
  } catch (err) {
    return {
      success: false,
      output_path: outPath,
      sections: {},
      exported_at: now,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function importMemoryMarkdown(inputPath: string): { success: boolean; message: string; imported: number } {
  if (!existsSync(inputPath)) {
    return { success: false, message: `File not found: ${inputPath}`, imported: 0 };
  }
  try {
    const content = readFileSync(inputPath, 'utf-8');
    const db = getDb();
    let imported = 0;

    // Parse ### heading blocks in Knowledge Base section
    const kbSection = content.match(/## Knowledge Base([\s\S]*?)(?=## |$)/);
    if (kbSection) {
      const blocks = kbSection[1].split(/^### /m).slice(1);
      for (const block of blocks) {
        const titleLine = block.split('\n')[0]?.trim();
        if (!titleLine) continue;
        const bodyMatch = block.match(/\n\n([\s\S]+)$/);
        const body = bodyMatch ? bodyMatch[1].trim() : '';
        if (!titleLine || !body) continue;
        const id = `md-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try {
          db.prepare(`
            INSERT OR IGNORE INTO knowledge_base (id, type, title, content, created_at, updated_at)
            VALUES (?, 'imported', ?, ?, ?, ?)
          `).run(id, titleLine, body.slice(0, 2000), new Date().toISOString(), new Date().toISOString());
          imported++;
        } catch { /* ignore dup */ }
      }
    }

    return { success: true, message: `Imported ${imported} knowledge entries from ${inputPath}`, imported };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err), imported: 0 };
  }
}

export function getLocalDbSize(): DbSizeResult {
  const db = getDb();
  const tables = ['sessions', 'decisions', 'council_outcomes', 'knowledge_base', 'patterns', 'project_map', 'learning_data'];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      counts[table] = row.c;
    } catch {
      counts[table] = 0;
    }
  }
  return { db_path: getDbPath(), tables: counts };
}
