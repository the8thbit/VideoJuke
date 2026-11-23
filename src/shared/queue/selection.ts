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

/** One regular directory, already indexed, with its share of the picks. */
export interface DirectoryCandidate {
  readonly directory: string;
  /** Relative weight against the other directories; see `DirectoryConfig.bias`. */
  readonly bias: number;
  readonly videos: readonly IndexedVideo[];
}

export interface SelectionRequest {
  readonly regular: readonly DirectoryCandidate[];
  readonly seasonal: readonly SeasonalCandidate[];
  /** Source paths already queued or preprocessed, which must not be picked again. */
  readonly excludedPaths: ReadonlySet<string>;
  readonly facts: LocalTimeFacts;
  readonly random: RandomSource;
  /**
   * The weight of one video within its directory, which is where the length
   * bias comes in. Omitted, every video in a directory is equally likely.
   */
  readonly weightOf?: (video: IndexedVideo) => number;
  /**
   * Whether a directory's share grows with what it holds; see
   * `SelectionConfig.scaleBiasByDirectorySize`. Omitted, it does, which is the
   * shipped default and the behaviour from before biases existed.
   */
  readonly scaleBiasByDirectorySize?: boolean;
}

export type SelectionOutcome =
  | { readonly kind: 'seasonal'; readonly video: IndexedVideo; readonly directory: string }
  | { readonly kind: 'regular'; readonly video: IndexedVideo; readonly directory: string }
  | { readonly kind: 'none'; readonly reason: 'no-videos' | 'all-excluded' };

/** Total pool size, ignoring exclusions and time conditions. */
export const countSelectableVideos = (
  request: Pick<SelectionRequest, 'regular' | 'seasonal'>,
): number =>
  sumBy(request.regular, (candidate) => candidate.videos.length) +
  sumBy(request.seasonal, (candidate) => candidate.videos.length);

const isUsableWeight = (weight: number): boolean => weight > 0 && weight < Number.POSITIVE_INFINITY;

/**
 * Picks one element with probability proportional to its weight, using a
 * single draw from `random`.
 *
 * When every weight is equal this lands on exactly the element `pickRandom`
 * would for the same draw, which is what keeps a seeded source reproducing the
 * sequences it produced before weights existed. When no element has a usable
 * weight - every directory biased to zero - it falls back to an even pick:
 * a zero bias means "last", not "never", so the player never runs dry while a
 * video is still available.
 */
export const pickWeighted = <T>(
  values: readonly T[],
  weightOf: (value: T) => number,
  random: RandomSource,
): T | null => {
  if (values.length === 0) return null;

  const weights = values.map((value) => {
    const weight = weightOf(value);
    return isUsableWeight(weight) ? weight : 0;
  });
  const total = sumBy(weights, (weight) => weight);
  if (!isUsableWeight(total)) return pickRandom(values, random);

  const target = random() * total;
  let cumulative = 0;
  let lastUsable: T | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const weight = weights[index] ?? 0;
    if (weight === 0) continue;
    const value = values[index] as T;
    cumulative += weight;
    lastUsable = value;
    if (target < cumulative) return value;
  }
  // Only reachable through rounding at the very top of the range.
  return lastUsable;
};

const EVEN_WEIGHT = (): number => 1;

/** A weight `pickWeighted` would count, or zero for one it would ignore. */
const usableWeight = (weight: number): number => (isUsableWeight(weight) ? weight : 0);

/** A regular directory with something left to pick, and what that is. */
interface OpenDirectory {
  readonly candidate: DirectoryCandidate;
  readonly videos: readonly IndexedVideo[];
}

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
 * Otherwise a regular directory is chosen, among those with anything left to
 * give, and then a video within it by `weightOf`. What a directory weighs
 * depends on `scaleBiasByDirectorySize`:
 *
 * - scaled, its bias times the summed weight of its available videos. A video's
 *   overall chance then comes out as its directory's bias times its own weight,
 *   exactly as if every video were drawn from one pool: with equal biases and
 *   no length bias every video is equally likely, and with the length bias on
 *   the shortest video in the library is `maxRatio` times as likely as the
 *   longest, whichever directories they sit in.
 * - unscaled, its bias alone. With every bias equal a folder of ten videos then
 *   comes round as often as a folder of ten thousand, and the length bias
 *   orders videos within each directory's share without moving the share.
 *
 * Directories biased to zero only take part once no other directory has
 * anything left, and then as if every bias were 1.
 *
 * Randomness is consumed in the legacy order - one draw per likelihood roll,
 * then one for the directory when there is more than one to choose between,
 * then one for the video - so a seeded source with a single regular directory
 * reproduces old sequences.
 */
export const selectVideo = (request: SelectionRequest): SelectionOutcome => {
  const weightOf = request.weightOf ?? EVEN_WEIGHT;
  const available = (videos: readonly IndexedVideo[]): readonly IndexedVideo[] =>
    videos.filter((video) => !request.excludedPaths.has(video.originalPath));

  for (const candidate of request.seasonal) {
    if (!matchesTimeCondition(candidate.conditions, request.facts)) continue;
    if (request.random() >= candidate.likelihood) continue;

    const video = pickWeighted(available(candidate.videos), weightOf, request.random);
    if (video === null) continue;
    return { kind: 'seasonal', video, directory: candidate.directory };
  }

  const open: OpenDirectory[] = [];
  for (const candidate of request.regular) {
    const videos = available(candidate.videos);
    if (videos.length > 0) open.push({ candidate, videos });
  }

  // A zero bias means "last", not "never": those directories are only the pool
  // once nothing else is left, and then they share it as if unbiased.
  const biased = open.filter((entry) => isUsableWeight(entry.candidate.bias));
  const pool = biased.length > 0 ? biased : open;
  const biasOf = (entry: OpenDirectory): number => (biased.length > 0 ? entry.candidate.bias : 1);
  const scaled = request.scaleBiasByDirectorySize ?? true;
  const shareOf = (entry: OpenDirectory): number =>
    scaled
      ? biasOf(entry) * sumBy(entry.videos, (video) => usableWeight(weightOf(video)))
      : biasOf(entry);

  const chosen =
    pool.length === 1 ? (pool[0] ?? null) : pickWeighted(pool, shareOf, request.random);
  if (chosen !== null) {
    const video = pickWeighted(chosen.videos, weightOf, request.random);
    if (video !== null) return { kind: 'regular', video, directory: chosen.candidate.directory };
  }

  // An empty pool is a configuration problem; a full-but-exhausted one only
  // means the queue is already holding everything there is.
  const reason = countSelectableVideos(request) === 0 ? 'no-videos' : 'all-excluded';
  return { kind: 'none', reason };
};
