import type { AppConfig } from '../types/config';
import { stableStringify } from '../util/objects';
import { indexRelevantConfigFingerprint } from './hash';

/**
 * What a settings change costs a library that is already playing.
 *
 * - `none`: nothing already prepared is affected.
 * - `requeue`: the videos already transcoded were chosen or encoded under the
 *   old settings, so a fresh batch is needed.
 * - `reindex`: the change alters what the library contains, so it is re-scanned
 *   first and then requeued.
 */
export type ConfigChangeImpact = 'none' | 'requeue' | 'reindex';

/**
 * The settings baked into a queued video: which one was picked (the directory
 * biases and the length bias) and how it was encoded (the audio chain).
 *
 * Crossfade timing is deliberately not here, although it is computed during
 * transcoding: the player derives it again from the video's length and the
 * settings in force, so a new fade length applies to the very next video.
 * Performance settings change how fast a transcode runs, not what it produces.
 */
const queueRelevantFingerprint = (config: AppConfig): string =>
  stableStringify({
    directories: config.directories,
    lengthBias: config.selection.lengthBias,
    audio: config.audio,
  });

export const classifyConfigChange = (previous: AppConfig, next: AppConfig): ConfigChangeImpact => {
  if (indexRelevantConfigFingerprint(previous) !== indexRelevantConfigFingerprint(next)) {
    return 'reindex';
  }
  if (queueRelevantFingerprint(previous) !== queueRelevantFingerprint(next)) return 'requeue';
  return 'none';
};
