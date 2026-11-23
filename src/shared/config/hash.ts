import { directoryPaths, type AppConfig } from '../types/config';
import { stableStringify } from '../util/objects';

/**
 * A stable encoding of exactly the settings that decide what the video index
 * contains. Anything else - queue sizes, audio tuning, UI timings - can change
 * without invalidating a scan, so it is deliberately left out: including it
 * would throw away a perfectly good index every time a timeout is tweaked.
 *
 * The seasonal entries contribute only the fields that select videos; the
 * documentary `comment` is excluded so that editing a note is free. Likewise a
 * regular directory contributes its path and not its bias: the bias decides how
 * often a directory is drawn from, never which files it holds, so re-weighting a
 * directory must not cost a re-scan. Paths alone also encode exactly as the
 * plain string list did, so caches written before biases existed stay valid.
 *
 * `video.updateInterval` was in here and should not have been: it says how often
 * the index is rebuilt, never what a rebuild finds. Including it meant that
 * raising the re-scan period changed the fingerprint, which made `needsRebuild`
 * true, which made `handleConfigChange` clear the queue - deleting every
 * transcode the user had waited for - to answer a change that could not have
 * affected a single entry.
 */
export const indexRelevantConfigFingerprint = (config: AppConfig): string =>
  stableStringify({
    directories: directoryPaths(config),
    seasonalDirectories: config.seasonalDirectories.map((entry) => ({
      directory: entry.directory,
      likelihood: entry.likelihood,
      conditions: entry.conditions,
    })),
    files: { supportedVideoExtensions: config.files.supportedVideoExtensions },
  });

/**
 * Hashes the fingerprint with a caller-supplied digest, which is how this stays
 * platform-neutral: the server passes an md5 from node:crypto.
 */
export const computeConfigHash = (
  config: AppConfig,
  digest: (input: string) => string,
): string => digest(indexRelevantConfigFingerprint(config));
