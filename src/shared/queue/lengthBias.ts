import type { LengthBiasConfig } from '../types/config';

/**
 * Turns a video's length into a selection weight.
 *
 * `null` is a video whose length is unknown: never measured, or one ffprobe
 * could not read.
 */
export type LengthWeight = (durationSeconds: number | null) => number;

/**
 * The floor every length is raised to before the arithmetic.
 *
 * The weight is a power of a ratio of lengths, so a zero-length file would make
 * that ratio infinite. A second is shorter than anything worth queueing, so
 * nothing real is moved by it.
 */
const SHORTEST_MEANINGFUL_SECONDS = 1;

const NEUTRAL: LengthWeight = () => 1;

export interface LengthRange {
  readonly shortest: number;
  readonly longest: number;
}

/** The shortest and longest known lengths, or null when none is known. */
export const toLengthRange = (durations: readonly (number | null)[]): LengthRange | null => {
  let shortest = Number.POSITIVE_INFINITY;
  let longest = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index];
    if (duration === undefined || duration === null) continue;
    if (!(duration >= 0) || duration === Number.POSITIVE_INFINITY) continue;
    const seconds = Math.max(duration, SHORTEST_MEANINGFUL_SECONDS);
    if (seconds < shortest) shortest = seconds;
    if (seconds > longest) longest = seconds;
  }
  return shortest === Number.POSITIVE_INFINITY ? null : { shortest, longest };
};

/**
 * Builds the weighting for one library.
 *
 * The weight is `(longest / length) ^ k` when shorter videos are favoured and
 * `(length / shortest) ^ k` when longer ones are, with `k` chosen so that the
 * two ends of the library come out exactly `maxRatio` apart. That is a straight
 * line on a log scale: a two-minute video is favoured over a four-minute one by
 * the same factor as a thirty-minute video over an hour-long one, which is how
 * people compare lengths. A straight line on the plain scale would let a single
 * three-hour film squash every ordinary video into the same weight.
 *
 * A video of unknown length gets the geometric middle of the range, so it is
 * neither favoured nor punished for a probe that failed.
 */
export const createLengthWeight = (
  config: LengthBiasConfig,
  range: LengthRange | null,
): LengthWeight => {
  if (!config.enabled || config.maxRatio <= 1 || range === null) return NEUTRAL;

  const spread = Math.log(range.longest / range.shortest);
  // Every known video is the same length, so there is nothing to tilt towards.
  if (!(spread > 0)) return NEUTRAL;

  const exponent = Math.log(config.maxRatio) / spread;
  const middle = Math.sqrt(config.maxRatio);

  return (durationSeconds) => {
    if (durationSeconds === null || !(durationSeconds >= 0)) return middle;
    const seconds = Math.min(
      Math.max(durationSeconds, range.shortest, SHORTEST_MEANINGFUL_SECONDS),
      range.longest,
    );
    const ratio =
      config.favor === 'shorter' ? range.longest / seconds : seconds / range.shortest;
    return Math.pow(ratio, exponent);
  };
};
