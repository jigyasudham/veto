// Reading and merging a host's JSON config without ever damaging it.
//
// Three shapes of file broke the old writer, each silently:
//   • 0 bytes. Antigravity creates ~/.gemini/config/mcp_config.json empty.
//     JSON.parse('') throws, the writer reported "config unreadable, skipped",
//     and the one file the host actually reads never got a Veto entry.
//   • Comments. Zed's settings.json is JSONC and ships with `//` comments, so it
//     was always "unreadable" too — and writing it back through JSON.stringify
//     would delete every comment the user wrote. Veto reads such a file (to
//     report on it) but will not rewrite it; the user gets the exact snippet.
//   • Invalid JSON. Left alone, as before, but now reported as what it is.
// Every write keeps a one-deep backup (`<file>.veto-bak`) of what was there.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonKey } from './hosts.js';

export type ConfigRead =
  | { state: 'missing' }
  | { state: 'empty' }
  | { state: 'ok'; data: Record<string, unknown>; hasComments: false }
  | { state: 'ok'; data: Record<string, unknown>; hasComments: true }
  | { state: 'invalid'; error: string };

/**
 * Strip `//` and `/* *\/` comments and trailing commas outside strings, so a
 * JSONC file can be read. Used for reading only.
 */
export function stripJsonComments(text: string): { json: string; hadComments: boolean } {
  let out = '';
  let hadComments = false;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      // A trailing comma (JSONC allows one before } or ]; JSON.parse does not).
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { hadComments = true; continue; }
    }
    if (ch === '/' && next === '/') {
      hadComments = true;
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      hadComments = true;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return { json: out, hadComments };
}

export function readJsonConfig(path: string): ConfigRead {
  if (!existsSync(path)) return { state: 'missing' };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (err) { return { state: 'invalid', error: err instanceof Error ? err.message : String(err) }; }
  if (text.replace(/^﻿/, '').trim() === '') return { state: 'empty' };
  const { json, hadComments } = stripJsonComments(text.replace(/^﻿/, ''));
  try {
    const data = JSON.parse(json) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'invalid', error: 'top level is not an object' };
    return hadComments
      ? { state: 'ok', data: data as Record<string, unknown>, hasComments: true }
      : { state: 'ok', data: data as Record<string, unknown>, hasComments: false };
  } catch (err) {
    return { state: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
}

/** The Veto entry as it sits in a config file, or undefined. */
export function vetoEntry(read: ConfigRead, key: JsonKey): unknown {
  if (read.state !== 'ok') return undefined;
  const servers = read.data[key];
  return servers && typeof servers === 'object' ? (servers as Record<string, unknown>).veto : undefined;
}

export type MergeResult =
  | { result: 'created' | 'updated' | 'unchanged'; backup: string | null }
  | { result: 'manual'; reason: string; snippet: string };

/**
 * Put `entry` under `key.veto`, keeping every other server and setting. Empty
 * or missing files start from `{}`. Files with comments or invalid JSON are not
 * touched: the caller gets a snippet to paste instead.
 */
export function mergeServerEntry(path: string, key: JsonKey, entry: Record<string, unknown>): MergeResult {
  const read = readJsonConfig(path);
  const snippet = JSON.stringify({ [key]: { veto: entry } }, null, 2);
  if (read.state === 'invalid') return { result: 'manual', reason: `not valid JSON (${read.error})`, snippet };
  if (read.state === 'ok' && read.hasComments) return { result: 'manual', reason: 'it contains comments or trailing commas, which rewriting would delete', snippet };

  const data: Record<string, unknown> = read.state === 'ok' ? { ...read.data } : {};
  const servers = data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])
    ? { ...(data[key] as Record<string, unknown>) }
    : {};
  if (JSON.stringify(servers.veto) === JSON.stringify(entry)) return { result: 'unchanged', backup: null };
  const existed = read.state === 'ok';
  servers.veto = entry;
  data[key] = servers;

  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.veto-bak`;
    copyFileSync(path, backup);
  }
  // Write-then-rename so a crash mid-write cannot leave the host a half file.
  const tmp = `${path}.veto-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return { result: existed ? 'updated' : 'created', backup };
}
