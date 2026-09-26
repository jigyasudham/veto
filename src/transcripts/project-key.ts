// One spelling per project folder, for matching only (stored values keep the
// spelling their host reported, so listings still read naturally).
//
// Hosts disagree on how they spell the same folder: Gemini records
// `d:\veto`, a save from the same place stores `d:\Veto`, Claude's slug keeps
// whatever case its cwd had, and a model may pass `D:/Veto/`. So every
// comparison goes through this key:
//   • everywhere: the drive letter folded (as normalizeProjectDir does for every
//     stored value) and trailing separators dropped;
//   • on Windows, where paths are case-insensitive: separators unified and
//     ASCII letters folded (SQLite's core lower() folds ASCII only, and both
//     sides of a comparison must agree).
// `platform` is a parameter so both branches are tested on either OS; the
// Linux branch was once broken by a change that only a Windows run had seen.

// The drive-letter fold normalizeProjectDir (memory/local.ts) applies, inlined so
// that module can use this one without an import cycle.
const foldDrive = (p: string): string => (/^[A-Za-z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p);

export function projectKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  let key = foldDrive(dir.trim());
  if (platform === 'win32') key = key.replace(/\//g, '\\').replace(/[A-Z]/g, ch => ch.toLowerCase());
  const trimmed = key.replace(/[\\/]+$/, '');
  return trimmed || key;
}

/** The same key as a SQL expression over a column, using core SQLite functions only. */
export function projectKeySql(column: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `rtrim(replace(lower(${column}), '/', '\\'), '\\')`;
  const driveFolded = `CASE WHEN substr(${column}, 2, 1) = ':' THEN lower(substr(${column}, 1, 1)) || substr(${column}, 2) ELSE ${column} END`;
  return `rtrim(${driveFolded}, '/\\')`;
}
