import type { MemoryFrontmatter, MemoryParseResult, MemorySection } from './types.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function normalizeMarkdown(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * The guide `veto init` used to write over ~/.gemini/GEMINI.md and
 * ~/.codex/AGENTS.override.md. It is Veto's own text, not a host's memory.
 * Every version of it has exactly one heading, so it is always exactly one
 * section, and a host that later appended its own memories below it keeps them.
 */
function isVetoGuideSection(section: MemorySection): boolean {
  return section.title === 'Veto MCP Server' && /\bVeto is active\b/.test(section.text);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Just enough YAML for memory frontmatter: top-level `name`/`description`, and
 * `type` either top-level (older entries) or nested under `metadata:` (current
 * Claude entries). Block scalars are ignored rather than guessed at.
 */
function readFrontmatter(yaml: string): MemoryFrontmatter {
  const out: MemoryFrontmatter = {};
  let parent: string | null = null;
  for (const line of yaml.split('\n')) {
    const m = /^(\s*)([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, rawValue] = m;
    const value = rawValue.trim();
    if (indent.length === 0) {
      parent = value === '' ? key : null;
      if (value === '' || value === '|' || value === '>') continue;
      if (key === 'name') out.name = unquote(value);
      else if (key === 'description') out.description = unquote(value);
      else if (key === 'type') out.type = unquote(value).toLowerCase();
    } else if (parent === 'metadata' && key === 'type' && value) {
      out.type = unquote(value).toLowerCase();
    }
  }
  return out;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Split a Markdown body into section-level notes. Text before the first heading
 * is a note of its own (most Claude entries have no heading at all). Headings
 * inside fenced code are not structure, and a heading with no body is only a
 * document title. Anchors are unique within the document.
 */
export function splitSections(body: string, fallbackTitle: string): MemorySection[] {
  const lines = body.split('\n');
  const headings: Array<{ index: number; title: string }> = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ index, title: m[2].trim() });
  });

  const raw: Array<{ base: string; title: string; body: string }> = [];
  const preamble = lines.slice(0, headings[0]?.index ?? lines.length).join('\n').trim();
  if (preamble) raw.push({ base: 'body', title: fallbackTitle, body: preamble });
  headings.forEach((heading, i) => {
    const text = lines.slice(heading.index + 1, headings[i + 1]?.index ?? lines.length).join('\n').trim();
    if (text) raw.push({ base: slug(heading.title) || `section-${i + 1}`, title: heading.title, body: text });
  });

  const seen = new Map<string, number>();
  return raw.map(({ base, title, body: text }) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { anchor: n === 1 ? base : `${base}-${n}`, title, text: title ? `${title}\n${text}` : text };
  });
}

/**
 * Native memory documents are Markdown, optionally with YAML frontmatter.
 * Only shapes that cannot be Markdown count as drift and fail closed; a
 * headingless entry is the normal Claude shape, not drift.
 */
export function parseMarkdownMemory(raw: string, fallbackTitle = ''): MemoryParseResult {
  const text = normalizeMarkdown(raw);
  if (text.includes('\u0000')) return { ok: false, reason: 'binary content where Markdown was expected' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, skip: 'empty' };
  if (/^[[{]/.test(trimmed)) {
    try { JSON.parse(trimmed); return { ok: false, reason: 'JSON document where Markdown was expected' }; }
    catch { /* Markdown that happens to start with a bracket */ }
  }

  let frontmatter: MemoryFrontmatter = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const fm = FRONTMATTER_RE.exec(text);
    if (!fm) return { ok: false, reason: 'frontmatter is not terminated' };
    frontmatter = readFrontmatter(fm[1]);
    body = text.slice(fm[0].length);
  }

  const title = frontmatter.description || frontmatter.name || fallbackTitle;
  const all = splitSections(body, title);
  const sections = all.filter(section => !isVetoGuideSection(section));
  if (sections.length) return { ok: true, frontmatter, sections };
  return { ok: true, skip: all.length ? 'veto-authored' : 'empty' };
}
