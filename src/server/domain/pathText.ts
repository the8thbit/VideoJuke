/**
 * Path text, split and joined by hand rather than with `node:path`.
 *
 * Only `server/infra` may import node built-ins, and a domain module could not
 * trust the platform separator anyway: a directory typed into config.json on
 * Windows may use `/` while the filesystem hands back `\`, so a single path can
 * carry both. Every function here therefore treats the two separators alike and
 * takes the separator to insert from the string it was given.
 */

const lastSeparatorIndex = (path: string): number =>
  Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

/** The last segment: `X:\videos\a.mp4` and `X:/videos/a.mp4` both give `a.mp4`. */
export const fileNameOf = (path: string): string => {
  const index = lastSeparatorIndex(path);
  return index === -1 ? path : path.slice(index + 1);
};

/** Everything before the last segment; `.` when the path names no directory. */
export const directoryOf = (path: string): string => {
  const index = lastSeparatorIndex(path);
  if (index === -1) return '.';
  // A file directly under a root keeps the separator, so the directory of
  // `/movie.mp4` is `/` rather than the empty string.
  return index === 0 ? path.slice(0, 1) : path.slice(0, index);
};

/** Appends a segment to an already-resolved directory. */
export const joinPath = (directory: string, fileName: string): string => {
  const lastCharacter = directory.slice(-1);
  if (lastCharacter === '/' || lastCharacter === '\\') return `${directory}${fileName}`;
  return `${directory}${directory.includes('\\') ? '\\' : '/'}${fileName}`;
};
