import type { AppConfig } from '../types/config';
import type { CrossfadeTiming, PreprocessedVideo } from '../types/video';
import { isFiniteNumber } from '../util/numbers';

/**
 * Crossfade parameters in the units the timing arithmetic works in.
 *
 * The legacy code recomputed this rule in three places from three different
 * sources — two of them with hard-coded 0.2s/0.5s constants — so a change to
 * `crossfade.duration` moved the player's fade but not the timing baked into
 * queued videos. Deriving one settings value from the config keeps them equal.
 */
export interface CrossfadeSettings {
  readonly durationMs: number;
  readonly minDurationMs: number;
  /** Gap left between the end of the fade and the end of the video. */
  readonly bufferSeconds: number;
}

export const toCrossfadeSettings = (
  config: Pick<AppConfig, 'crossfade' | 'timeouts'>,
): CrossfadeSettings => ({
  durationMs: config.crossfade.duration,
  minDurationMs: config.timeouts.crossfadeMinDuration,
  bufferSeconds: config.timeouts.crossfadeBufferTime / 1000,
});

/**
 * How long the blend should last for a video of the given length.
 *
 * A clip shorter than two nominal crossfades gets half its own length, so that
 * the fade never occupies the whole video; anything longer is capped at 80% of
 * the clip as a second guard.
 */
export const computeCrossfadeDurationSeconds = (
  videoDurationSeconds: number,
  settings: CrossfadeSettings,
): number => {
  const configured = settings.durationMs / 1000;
  const minimum = settings.minDurationMs / 1000;

  if (videoDurationSeconds < configured * 2) {
    return Math.max(videoDurationSeconds / 2, minimum);
  }
  return Math.min(configured, videoDurationSeconds * 0.8, Math.max(configured, minimum));
};

/** Null when the container reported no usable duration, so nothing can be scheduled. */
export const computeCrossfadeTiming = (
  videoDurationSeconds: number | null,
  settings: CrossfadeSettings,
): CrossfadeTiming | null => {
  if (!isFiniteNumber(videoDurationSeconds) || videoDurationSeconds <= 0) return null;

  const duration = computeCrossfadeDurationSeconds(videoDurationSeconds, settings);
  return {
    duration,
    startTime: Math.max(0, videoDurationSeconds - duration - settings.bufferSeconds),
  };
};

/**
 * Fills in timing that an older cache entry or an upstream stage left unset.
 * Existing timing is kept rather than recomputed: it was derived from the
 * duration the file actually had when it was transcoded.
 */
export const withCrossfadeTiming = <T extends PreprocessedVideo>(
  video: T,
  settings: CrossfadeSettings,
): T => {
  if (video.crossfadeTiming !== null) return video;
  return { ...video, crossfadeTiming: computeCrossfadeTiming(video.metadata.duration, settings) };
};
