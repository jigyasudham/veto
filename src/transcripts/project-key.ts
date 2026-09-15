// One spelling per project folder, for matching only (stored values keep the
// spelling their host reported, so listings still read naturally).
//
// Hosts disagree on how they spell the same folder: Gemini records
// `d:\veto`, a save from the same place stores `d:\Veto`, Claude's slug keeps
// whatever case its cwd had, and a model may pass `D:/Veto/`. On Windows all of
// these are one folder, so every comparison goes through this key: separators
// unified, trailing separators dropped, and ASCII letters folded (SQLite's core
// lower() folds ASCII only, and both sides must agree).

const win32 = process.platform === 'win32';

export function projectKey(dir: string): string {
  let key = dir.trim();
  if (win32) key = key.replace(/\//g, '\\').replace(/[A-Z]/g, ch => ch.toLowerCase());
  const trimmed = key.replace(/[\\/]+$/, '');
  return trimmed || key;
}

/** The same key as a SQL expression over a column, using core SQLite functions only. */
export function projectKeySql(column: string): string {
  return win32 ? `rtrim(replace(lower(${column}), '/', '\\'), '\\')` : `rtrim(${column}, '/\\')`;
}
