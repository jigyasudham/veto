import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNativeMemory } from '../../src/lessons/adapters/index.js';

// Fixtures copy the real shapes with synthetic content. Claude's are modelled on
// entries measured on a real install (frontmatter with `metadata.type`, most
// bodies without a single heading, a MEMORY.md index). No Codex or Gemini
// memory had been observed on a real install when these were written; those two
// follow the hosts' documented files (~/.codex/AGENTS.md; Gemini's save_memory
// appending `- fact` lines under "## Gemini Added Memories").
const FIXTURES = join(__dirname, 'fixtures');
// LF-normalized: a Windows checkout may have converted the fixtures to CRLF.
const read = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), 'utf8').replace(/\r\n/g, '\n');

function sections(result: ReturnType<typeof parseNativeMemory>) {
  if (!result.ok || 'skip' in result) throw new Error(`expected sections, got ${JSON.stringify(result)}`);
  return result;
}

describe('Claude memory adapter', () => {
  it('harvests a headingless entry as one note titled by its description', () => {
    const parsed = sections(parseNativeMemory('claude', read('claude', 'feedback_quoting_rule.md'), 'feedback_quoting_rule.md'));
    expect(parsed.frontmatter).toMatchObject({ name: 'quoting-rule', type: 'feedback' });
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].anchor).toBe('body');
    expect(parsed.sections[0].title).toMatch(/^Inline interpreter scripts lose/);
    expect(parsed.sections[0].text).toContain('**How to apply:**');
    expect(parsed.sections[0].text).not.toContain('originSessionId');
  });

  it('keeps the preamble, splits headings, and gives repeated headings unique anchors', () => {
    const parsed = sections(parseNativeMemory('claude', read('claude', 'project_release_gotchas.md'), 'project_release_gotchas.md'));
    expect(parsed.frontmatter.type).toBe('project');
    expect(parsed.sections.map(s => s.anchor)).toEqual(['body', 'console-encoding-cp1252', 'release-steps', 'notes', 'notes-2']);
  });

  it('ignores heading-like lines inside fenced code', () => {
    const parsed = sections(parseNativeMemory('claude', '# Real\nText\n```md\n# not a heading\n```\nMore', 'x.md'));
    expect(parsed.sections.map(s => s.anchor)).toEqual(['real']);
  });

  it('reads CRLF files with a byte-order mark', () => {
    const raw = '\uFEFF' + read('claude', 'user_profile.md').replace(/\n/g, '\r\n');
    const parsed = sections(parseNativeMemory('claude', raw, 'user_profile.md'));
    expect(parsed.frontmatter).toMatchObject({ name: 'user-profile', type: 'user' });
  });

  it('skips a MEMORY.md index, but not a MEMORY.md written as plain notes', () => {
    expect(parseNativeMemory('claude', read('claude', 'MEMORY.md'), 'MEMORY.md')).toEqual({ ok: true, skip: 'index' });
    expect(sections(parseNativeMemory('claude', '# Notes\nThe build needs Node 22.13.', 'MEMORY.md')).sections).toHaveLength(1);
  });

  it('treats an empty file as nothing to harvest, not as drift', () => {
    expect(parseNativeMemory('claude', '  \n', 'empty.md')).toEqual({ ok: true, skip: 'empty' });
  });

  it.each([
    ['a JSON document', '{"memories": []}'],
    ['binary content', '# Title\n\u0000\u0001'],
    ['unterminated frontmatter', '---\nname: x\n\nBody without a closing fence'],
  ])('fails closed on %s', (_label, raw) => {
    expect(parseNativeMemory('claude', raw, 'x.md').ok).toBe(false);
  });
});

describe('Gemini memory adapter', () => {
  it('splits saved memories into one note per fact and keeps the user preamble', () => {
    const parsed = sections(parseNativeMemory('gemini', read('gemini', 'GEMINI.md'), 'GEMINI.md'));
    expect(parsed.sections).toHaveLength(4);
    expect(parsed.sections[0]).toMatchObject({ anchor: 'body' });
    const facts = parsed.sections.slice(1);
    expect(facts.every(s => /^gemini-added-memories-[0-9a-f]{8}$/.test(s.anchor))).toBe(true);
    expect(facts[1].text).toBe('Release notes for patch versions are worded as bug fixes.');
  });

  it('keys each fact by its content, so inserting one re-keys nothing else', () => {
    const before = sections(parseNativeMemory('gemini', read('gemini', 'GEMINI.md'), 'GEMINI.md')).sections.map(s => s.anchor);
    const inserted = read('gemini', 'GEMINI.md').replace('## Gemini Added Memories\n', '## Gemini Added Memories\n- A newly saved fact.\n');
    const after = sections(parseNativeMemory('gemini', inserted, 'GEMINI.md')).sections.map(s => s.anchor);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toHaveLength(before.length + 1);
  });
});

describe('Codex memory adapter', () => {
  it('harvests headingless global instructions', () => {
    // The fixture is not named AGENTS.md: the repo's .gitignore ignores that name.
    const parsed = sections(parseNativeMemory('codex', read('codex', 'global-agents.md'), 'AGENTS.md'));
    expect(parsed.sections).toEqual([expect.objectContaining({ anchor: 'body', title: 'AGENTS.md' })]);
  });
});

describe('Veto-authored guide', () => {
  // Older `veto init` releases wrote this guide over ~/.gemini/GEMINI.md and
  // ~/.codex/AGENTS.override.md. It is Veto's text, never a host's memory.
  const guide = '# Veto MCP Server\n\nVeto is active. 93 tools across 6 categories:\n\n**Session & Context** — veto_status\n';

  it.each(['codex', 'gemini'] as const)('is skipped in %s files', (source) => {
    expect(parseNativeMemory(source, guide, source === 'codex' ? 'AGENTS.override.md' : 'GEMINI.md')).toEqual({ ok: true, skip: 'veto-authored' });
  });

  it('is dropped without losing memories Gemini saved below it', () => {
    const parsed = sections(parseNativeMemory('gemini', `${guide}\n## Gemini Added Memories\n- The user deploys on Fridays only.\n`, 'GEMINI.md'));
    expect(parsed.sections.map(s => s.text)).toEqual(['The user deploys on Fridays only.']);
  });
});
