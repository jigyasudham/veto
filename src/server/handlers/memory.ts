// Memory, patterns, and project-map tools. Pure handlers — they use the memory
// layer plus the shared active-project-dir accessor, nothing server-local.

import { storeKnowledge, searchKnowledge, deleteKnowledge, updateProjectMap, getProjectMap, upsertPattern, getPatterns } from '../../memory/local.js';
import { exportMemory, importMemory, exportMemoryMarkdown, importMemoryMarkdown } from '../../memory/sync.js';
import { addConstraint, listConstraints, setConstraintActive, checkDiffAgainstConstraints } from '../../memory/decisions.js';
import { readGitDiff } from '../scan-core.js';
import { buildRepoMap } from '../../repo-map/index.js';
import type { KnowledgeType } from '../../memory/schema.js';
import { getActiveProjectDir } from '../runtime.js';
import type { HandlerMap } from '../registry.js';

const jsonText = (payload: unknown, isError = false) =>
  ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) });

export const memoryHandlers: HandlerMap = {
  veto_decisions: ({ args }) => {
    const action = String(args?.action ?? '').trim();
    const projectDir = args?.project_dir ? String(args.project_dir) : (getActiveProjectDir() ?? undefined);

    if (action === 'add') {
      const rule = String(args?.rule ?? '').trim();
      const patterns = Array.isArray(args?.forbidden_patterns) ? args.forbidden_patterns.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
      if (!rule || patterns.length === 0) {
        return jsonText({ success: false, message: 'add requires rule and a non-empty forbidden_patterns array.' }, true);
      }
      const constraint = addConstraint({
        rule,
        forbidden_patterns: patterns,
        why: args?.why ? String(args.why) : undefined,
        file_scope: args?.file_scope ? String(args.file_scope) : undefined,
        severity: args?.severity === 'warn' ? 'warn' : 'block',
        project_dir: projectDir,
      });
      return jsonText({ success: true, constraint, message: 'Decision recorded as an enforceable constraint. veto_diff_review and veto_ci_gate now flag diffs that violate it.' });
    }

    if (action === 'list') {
      const constraints = listConstraints(projectDir, args?.include_inactive === true);
      return jsonText({ success: true, count: constraints.length, constraints });
    }

    if (action === 'check') {
      let diff = args?.diff ? String(args.diff) : '';
      if (!diff) diff = readGitDiff(projectDir);
      if (!diff.trim()) return jsonText({ success: false, message: 'No diff provided and no git changes detected.' }, true);
      const violations = checkDiffAgainstConstraints(diff, projectDir);
      const verdict = violations.some(v => v.severity === 'block') ? 'fail' : violations.length > 0 ? 'warn' : 'pass';
      return jsonText({ success: true, verdict, violations_found: violations.length, violations, constraints_active: listConstraints(projectDir).length });
    }

    if (action === 'disable' || action === 'enable') {
      const id = String(args?.id ?? '').trim();
      if (!id) return jsonText({ success: false, message: `${action} requires id.` }, true);
      const changed = setConstraintActive(id, action === 'enable');
      return changed
        ? jsonText({ success: true, message: `Constraint ${id} ${action}d.` })
        : jsonText({ success: false, message: `No constraint with id ${id}.` }, true);
    }

    return jsonText({ success: false, message: "action must be one of: add, list, check, disable, enable." }, true);
  },

  veto_memory_store: ({ args }) => {
    const title = String(args?.title ?? '').trim();
    const content = String(args?.content ?? '').trim();
    if (!title || !content) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'title and content are required.' }) }], isError: true };
    }
    const id = storeKnowledge({
      title,
      content,
      type: args?.type ? String(args.type) as KnowledgeType : 'solution',
      tags: Array.isArray(args?.tags) ? args.tags.map(String) : undefined,
      project_dir: args?.project_dir ? String(args.project_dir) : (getActiveProjectDir() ?? undefined),
      session_id: args?.session_id ? String(args.session_id) : undefined,
      relevance: typeof args?.relevance === 'number' ? args.relevance : 1.0,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, message: 'Knowledge stored.' }, null, 2) }] };
  },

  veto_memory_search: ({ args }) => {
    const results = searchKnowledge({
      query: args?.query ? String(args.query) : undefined,
      type: args?.type ? String(args.type) as KnowledgeType : undefined,
      project_dir: args?.project_dir ? String(args.project_dir) : (getActiveProjectDir() ?? undefined),
      limit: typeof args?.limit === 'number' ? args.limit : 10,
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: results.length,
          results: results.map(r => ({
            id: r.id,
            type: r.type,
            title: r.title,
            content: r.content,
            tags: r.tags ? JSON.parse(r.tags) : [],
            project_dir: r.project_dir,
            relevance: r.relevance,
            accessed_count: r.accessed_count,
            created_at: r.created_at,
          })),
        }, null, 2),
      }],
    };
  },

  veto_memory_delete: ({ args }) => {
    const id = String(args?.id ?? '').trim();
    if (!id) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'id is required.' }) }], isError: true };
    }
    const deleted = deleteKnowledge(id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: deleted, message: deleted ? 'Entry deleted.' : 'Entry not found.' }, null, 2) }] };
  },

  veto_project_map_update: ({ args }) => {
    const project_dir = String(args?.project_dir ?? '').trim();
    if (!project_dir) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    }

    // auto_compute: build live repo-map instead of requiring manual structure
    if (args?.auto_compute === true) {
      try {
        const computed = buildRepoMap({ projectDir: project_dir, maxTopModules: 30 });
        const id = updateProjectMap({
          project_dir,
          structure: {
            auto_computed: true,
            generated_at: computed.generated_at,
            total_files: computed.total_files,
            symbol_count: computed.symbol_count,
            top_modules: computed.top_modules.slice(0, 20).map(m => ({
              file: m.file, rank: m.rank, refs: m.ref_count,
              exports: m.symbols.slice(0, 5).map(s => s.name),
            })),
          },
          key_modules: computed.top_modules.slice(0, 15).map(m => m.file),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, auto_computed: true, total_files: computed.total_files, symbol_count: computed.symbol_count, top_modules_count: computed.top_modules.length }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Repo-map failed: ${err instanceof Error ? err.message : String(err)}` }) }], isError: true };
      }
    }

    const structure = String(args?.structure ?? '').trim();
    if (!structure) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Provide structure or set auto_compute: true to compute it automatically.' }) }], isError: true };
    }
    const id = updateProjectMap({
      project_dir,
      structure,
      key_modules: Array.isArray(args?.key_modules) ? args.key_modules.map(String) : undefined,
      tech_stack: Array.isArray(args?.tech_stack) ? args.tech_stack.map(String) : undefined,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, message: 'Project map updated.' }, null, 2) }] };
  },

  veto_project_map_get: ({ args }) => {
    const project_dir = String(args?.project_dir ?? '').trim();
    if (!project_dir) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    }
    const row = getProjectMap(project_dir);
    if (!row) {
      return { content: [{ type: 'text', text: JSON.stringify({ found: false, message: 'No project map found. Call veto_project_map_update to create one.' }, null, 2) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: true,
          project_dir: row.project_dir,
          structure: JSON.parse(row.structure),
          key_modules: row.key_modules ? JSON.parse(row.key_modules) : [],
          tech_stack: row.tech_stack ? JSON.parse(row.tech_stack) : [],
          updated_at: row.updated_at,
        }, null, 2),
      }],
    };
  },

  veto_pattern_store: ({ args }) => {
    const pattern_key = String(args?.pattern_key ?? '').trim();
    const pattern_val = String(args?.pattern_val ?? '').trim();
    if (!pattern_key || !pattern_val) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'pattern_key and pattern_val are required.' }) }], isError: true };
    }
    upsertPattern({
      pattern_key,
      pattern_val,
      confidence: typeof args?.confidence === 'number' ? args.confidence : 1.0,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Pattern stored.' }, null, 2) }] };
  },

  veto_patterns_list: ({ args }) => {
    const prefix = args?.prefix ? String(args.prefix) : undefined;
    const limit = typeof args?.limit === 'number' ? args.limit : 20;
    const patterns = getPatterns(prefix, limit);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: patterns.length,
          patterns: patterns.map(p => ({
            key: p.pattern_key,
            val: p.pattern_val,
            confidence: p.confidence,
            seen_count: p.seen_count,
            updated_at: p.updated_at,
          })),
        }, null, 2),
      }],
    };
  },

  veto_memory_export: ({ args }) => {
    const format = args?.format === 'markdown' ? 'markdown' : 'json';
    if (format === 'markdown') {
      const projectDir = args?.project_dir ? String(args.project_dir) : undefined;
      const outputPath = args?.output_path ? String(args.output_path) : undefined;
      const result = exportMemoryMarkdown(projectDir, outputPath);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    const result = exportMemory(args?.output_path ? String(args.output_path) : undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  veto_memory_import: ({ args }) => {
    const format = args?.format === 'markdown' ? 'markdown' : 'json';
    if (format === 'markdown') {
      const inputPath = String(args?.input_path ?? '').trim();
      if (!inputPath) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'input_path is required for markdown import.' }) }], isError: true };
      const result = importMemoryMarkdown(inputPath);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    const result = importMemory(args?.input_path ? String(args.input_path) : undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
