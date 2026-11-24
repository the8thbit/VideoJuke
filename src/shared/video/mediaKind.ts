import type { AppConfig } from '../types/config';

/**
 * The extension of the last path segment, lower-cased with its dot, or null
 * for a name without one. A leading dot alone - `.keep` - is a dotfile with a
 * name and no extension.
 */
export const extensionOf = (path: string): string | null => {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return name.slice(dot).toLowerCase();
};

const hasExtension = (path: string, extensions: readonly string[]): boolean => {
  const extension = extensionOf(path);
  return extension !== null && extensions.some((entry) => entry.toLowerCase() === extension);
};

/**
 * Whether an indexed file is a still image rather than a video.
 *
 * Decided by extension against the current settings, which is also how the
 * scan decided to index it. A video extension wins when an extension is in
 * both lists, so listing one twice cannot turn a video into a still.
 */
export const isImagePath = (
  path: string,
  config: Pick<AppConfig, 'files' | 'images'>,
): boolean =>
  config.images.enabled &&
  !hasExtension(path, config.files.supportedVideoExtensions) &&
  hasExtension(path, config.images.extensions);

/** Every extension the scan indexes under the given settings. */
export const indexedExtensions = (
  config: Pick<AppConfig, 'files' | 'images'>,
): readonly string[] =>
  config.images.enabled
    ? config.files.supportedVideoExtensions.concat(config.images.extensions)
    : config.files.supportedVideoExtensions;
