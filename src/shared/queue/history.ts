import type { HistoryGauge } from '../types/status';
import type { PreprocessedVideo } from '../types/video';
import { prependBounded, removeWhere, takeFirst } from '../util/arrays';

export interface HistoryLimits {
  /** How far back the "previous" command can reach. */
  readonly recentLimit: number;
  /** How much history survives a restart. */
  readonly persistedLimit: number;
}

/**
 * Both halves of playback history. `recent` is the short list the user walks
 * backwards through; `persisted` is the long tail written to the cache. A video
 * normally appears in both, at the same position from the front.
 */
export interface HistoryState {
  readonly recent: readonly PreprocessedVideo[];
  readonly persisted: readonly PreprocessedVideo[];
}

export const EMPTY_HISTORY: HistoryState = { recent: [], persisted: [] };

const withoutPath = (
  videos: readonly PreprocessedVideo[],
  originalPath: string,
): readonly PreprocessedVideo[] =>
  removeWhere(videos, (video) => video.originalPath === originalPath);

/**
 * Records a video as played. Replaying a file moves it to the front rather than
 * adding a second entry, so "previous" never returns the same file twice.
 */
export const recordPlayed = (
  state: HistoryState,
  video: PreprocessedVideo,
  limits: HistoryLimits,
): HistoryState => ({
  recent: prependBounded(withoutPath(state.recent, video.originalPath), video, limits.recentLimit),
  persisted: prependBounded(
    withoutPath(state.persisted, video.originalPath),
    video,
    limits.persistedLimit,
  ),
});

/**
 * Pops the most recently played video. Taking from `recent` also drops the
 * video from `persisted`, so that stepping backwards and then forwards again
 * re-adds it at the front instead of leaving a stale duplicate behind.
 */
export const takePrevious = (
  state: HistoryState,
): { readonly video: PreprocessedVideo | null; readonly state: HistoryState } => {
  const [fromRecent, ...remainingRecent] = state.recent;
  if (fromRecent !== undefined) {
    return {
      video: fromRecent,
      state: {
        recent: remainingRecent,
        persisted: withoutPath(state.persisted, fromRecent.originalPath),
      },
    };
  }

  const [fromPersisted, ...remainingPersisted] = state.persisted;
  if (fromPersisted !== undefined) {
    return { video: fromPersisted, state: { recent: state.recent, persisted: remainingPersisted } };
  }

  return { video: null, state };
};

/** Applies the limits to state assembled elsewhere, such as a restored cache file. */
export const trimHistory = (state: HistoryState, limits: HistoryLimits): HistoryState => ({
  recent: takeFirst(state.recent, limits.recentLimit),
  persisted: takeFirst(state.persisted, limits.persistedLimit),
});

export const historyGauges = (state: HistoryState, limits: HistoryLimits): HistoryGauge => ({
  playback: { current: state.recent.length, target: limits.recentLimit },
  persisted: { current: state.persisted.length, target: limits.persistedLimit },
});
