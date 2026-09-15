import { mask } from '../transcripts/mask.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// A home directory in every spelling a note can carry it: C:\Users\x (also
// JSON-escaped), C:/Users/x, Git Bash /c/Users/x, /Users/x and /home/x. The
// lookbehind keeps a URL path like example.com/home/x from matching.
const WINDOWS_HOME_RE = /\b[A-Z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\\/\s"'`)]+/gi;
const POSIX_HOME_RE = /(?<![\w.:\/~-])(?:\/[a-z](?=\/Users\/))?\/(?:Users|home)\/[^\/\s"'`)]+/gi;
// Claude's project-folder slug of a home path: C--Users-<name>-...
const HOME_SLUG_RE = /\b([A-Z])--Users-[^-\s/\\]+/gi;

/** Remove data that must not leave the originating native-memory document. */
export function maskLessonText(input: string): { text: string; secrets: number } {
  const masked = mask(input);
  return {
    secrets: masked.count,
    text: masked.text
      .replace(EMAIL_RE, '[email redacted]')
      .replace(WINDOWS_HOME_RE, '~')
      .replace(POSIX_HOME_RE, '~')
      .replace(HOME_SLUG_RE, '$1--Users-[user]'),
  };
}
