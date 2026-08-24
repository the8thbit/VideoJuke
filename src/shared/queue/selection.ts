import { matchesTimeCondition } from '../time/timeConditions';
import type { LocalTimeFacts, NormalizedTimeCondition } from '../types/time';
import type { IndexedVideo } from '../types/video';
import { pickRandom, sumBy, type RandomSource } from '../util/arrays';

/** One seasonal directory, already indexed, with the rules that gate it. */
export interface SeasonalCandidate {
  readonly directory: string;
  /** Probability in the range 0..1 that this directory wins while it is active. */
  readonly likelihood: number;
  readonly conditions: NormalizedTimeCondition;
  readonly videos: readonly IndexedVideo[];
}

export interface SelectionRequest {
  readonly regular: readonly IndexedVideo[];
  readonly seasonal: readonly SeasonalCandidate[];
  /** Source paths already queued or preprocessed, which must not be picked again. */
  readonly excludedPaths: ReadonlySet<string>;
  readonly facts: LocalTimeFacts;
  readonly random: RandomSource;
}

export type SelectionOutcome =
  | { readonly kind: 'seasonal'; readonly video: IndexedVideo; readonly directory: string }
  | { readonly kind: 'regular'; readonly video: IndexedVideo }
  | { readonly kind: 'none'; readonly reason: 'no-videos' | 'all-excluded' };

/** Total pool size, ignoring exclusions and time conditions. */
export const countSelectableVideos = (
  request: Pick<SelectionRequest, 'regular' | 'seasonal'>,
): number =>
  request.regular.length + sumBy(request.seasonal, (candidate) => candidate.videos.length);

/**
 * Picks the next video to preprocess.
 *
 * Seasonal directories are offered the pick first, in configured order: each
 * one whose conditions currently hold rolls once against its likelihood, and
 * the first winner with something left to play takes it. A directory that wins
 * the roll but has nothing available falls through rather than aborting the
 * seasonal pass, which is what the original code did and is what keeps a
 * fully-consumed holiday directory from blocking the rest.
 *
 * Randomness is consumed in the legacy order — one draw per likelihood roll,
 * then one for the index — so a seeded source reproduces old sequences.
 */
export const selectVideo = (request: SelectionRequest): SelectionOutcome => {
  const available = (videos: readonly IndexedVideo[]): readonly IndexedVideo[] =>
    videos.filter((video) => !request.excludedPaths.has(video.originalPath));

  for (const candidate of request.seasonal) {
    if (!matchesTimeCondition(candidate.conditions, request.facts)) continue;
    if (request.random() >= candidate.likelihood) continue;

    const video = pickRandom(available(candidate.videos), request.random);
    if (video === null) continue;
    return { kind: 'seasonal', video, directory: candidate.directory };
  }

  const video = pickRandom(available(request.regular), request.random);
  if (video !== null) return { kind: 'regular', video };

  // An empty pool is a configuration problem; a full-but-exhausted one only
  // means the queue is already holding everything there is.
  const reason = countSelectableVideos(request) === 0 ? 'no-videos' : 'all-excluded';
  return { kind: 'none', reason };
};
