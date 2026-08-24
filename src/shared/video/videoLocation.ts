import type { ProcessedVideoPath } from '../types/brand';
import type { VideoLocation } from '../types/video';

export const fileLocation = (path: ProcessedVideoPath): VideoLocation => ({ kind: 'file', path });

export const httpLocation = (url: string): VideoLocation => ({ kind: 'http', url });

const isAbsoluteHttpUrl = (url: string): boolean =>
  url.startsWith('http://') || url.startsWith('https://');

/** Joins an origin and a path with exactly one slash, whichever side carries it. */
const joinOrigin = (origin: string, url: string): string => {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${base}${path}`;
};

/**
 * Escapes one path segment for a URL, keeping the drive-letter colon readable.
 *
 * A filesystem path is not a URL, and pasting one after `file://` worked only
 * for as long as every path happened to be plain ASCII. It is not: the temp
 * directory lives under the working directory, so a path like
 * `C:\Users\Ann Smith\My #1 Videos\temp` is an ordinary place for it to be, and
 * a `#` there truncates the URL at the fragment - the element then tries to load
 * a directory and every single video fails. A `%` is worse, because it turns the
 * rest of the path into a percent-escape.
 *
 * `encodeURI` is not the tool for this: it leaves `#` and `?` alone by design.
 * Escaping per segment is what `pathToFileURL` does, and this has to work in a
 * browser, where that is not available.
 */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/%3A/gi, ':');

/**
 * Builds a `file:` URL from an absolute path, Windows spellings included.
 *
 * `file://` is followed by an empty host, which is where the third slash comes
 * from; a Windows path carries no leading separator of its own, so one is added.
 * Backslashes become forward slashes because a backslash in a URL path is not a
 * separator at all.
 */
export const toFileUrl = (path: string): string => {
  const encoded = path.split(/[\\/]/).map(encodeSegment).join('/');
  return encoded.charAt(0) === '/' ? `file://${encoded}` : `file:///${encoded}`;
};

/**
 * Turns a location into something a `<video>` element can load.
 *
 * `origin` is the page's own origin (null outside a browser, and unnecessary
 * when the server already handed us an absolute URL). This replaces the
 * "does videoData.serverUrl start with http?" branch that was written three
 * times in the client, twice without the leading-slash handling.
 */
export const resolveVideoUrl = (location: VideoLocation, origin: string | null): string => {
  if (location.kind === 'file') return toFileUrl(location.path);
  if (isAbsoluteHttpUrl(location.url) || origin === null) return location.url;
  return joinOrigin(origin, location.url);
};
