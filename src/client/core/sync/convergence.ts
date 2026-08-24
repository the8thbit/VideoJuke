import type { LeaderState } from '../../../shared/types/protocol';
import { clamp } from '../../../shared/util/numbers';

/**
 * One round trip's worth of evidence about how far this device's clock is from
 * the server's.
 */
export interface ClockSample {
  /** Add this to a local timestamp to get a server timestamp. */
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

/** How many samples are kept; the best of them is the one that is used. */
export const CLOCK_SAMPLE_LIMIT = 8;

export const addClockSample = (
  samples: readonly ClockSample[],
  sample: ClockSample,
): readonly ClockSample[] => [...samples, sample].slice(-CLOCK_SAMPLE_LIMIT);

/**
 * Estimates the offset from one poll: `serverNow - midpoint(sent, received)`.
 *
 * Assumes the request and the response took the same time, which is exactly the
 * assumption that fails - and the shorter the round trip, the less room there is
 * for it to fail by. That is why {@link bestOffsetMs} keeps the fastest sample
 * rather than averaging: an average is dragged around by the slow trips, which
 * are precisely the least trustworthy ones.
 */
export const sampleFrom = (
  sentAtMs: number,
  serverNowMs: number,
  receivedAtMs: number,
): ClockSample => ({
  offsetMs: serverNowMs - (sentAtMs + receivedAtMs) / 2,
  roundTripMs: Math.max(0, receivedAtMs - sentAtMs),
});

/** The offset from the fastest round trip seen, or zero with nothing to go on. */
export const bestOffsetMs = (samples: readonly ClockSample[]): number => {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (best === null || sample.roundTripMs < best.roundTripMs) best = sample;
  }
  return best?.offsetMs ?? 0;
};

/**
 * Where the leader has got to by now, in its own video's timeline.
 *
 * A paused leader is simply where it stopped. A playing one has advanced by the
 * elapsed server time multiplied by its rate - which is why the leader publishes
 * its rate rather than assuming 1.
 */
export const leaderPositionAt = (state: LeaderState, serverNowMs: number): number => {
  if (state.paused) return state.positionSeconds;
  const elapsedSeconds = Math.max(0, (serverNowMs - state.anchorMs) / 1000);
  return state.positionSeconds + elapsedSeconds * state.rate;
};

export type Correction =
  /** Close enough; stop correcting and let it run. */
  | { readonly kind: 'hold' }
  /** Multiply the leader's rate by this to close the gap gradually. */
  | { readonly kind: 'trim'; readonly trim: number }
  /** Too far out to nudge; jump. */
  | { readonly kind: 'seek'; readonly seconds: number };

export interface ConvergenceSettings {
  /** Inside this, doing nothing is better than fidgeting. */
  readonly deadbandSeconds: number;
  /** Beyond this a nudge would take too long to matter, so jump instead. */
  readonly seekThresholdSeconds: number;
  /** The most the rate may be bent, as a fraction. */
  readonly maxTrim: number;
  /** Seconds of error that would call for the full trim. */
  readonly gainSeconds: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceSettings = {
  // 40ms is under two frames at 50fps - past the point anyone can see a
  // difference between two screens, and well inside what a nudge could hold.
  deadbandSeconds: 0.04,
  // A second of error would take 20 seconds to remove at the maximum trim, so
  // past that a jump is both quicker and less strange to watch.
  seekThresholdSeconds: 1,
  // 5% is audible as pitch drift on some material even with preservesPitch, and
  // more than enough to close a realistic error within a few seconds.
  maxTrim: 0.05,
  gainSeconds: 5,
};

/**
 * What a follower should do about being `errorSeconds` behind the leader.
 *
 * Proportional only. The thing being controlled is a position, and rate is its
 * derivative, so the loop already integrates; adding an integral term to that is
 * the classic way to make a controller overshoot and hunt.
 */
export const decideCorrection = (
  errorSeconds: number,
  settings: ConvergenceSettings = DEFAULT_CONVERGENCE,
): Correction => {
  if (!Number.isFinite(errorSeconds)) return { kind: 'hold' };

  const magnitude = Math.abs(errorSeconds);
  if (magnitude >= settings.seekThresholdSeconds) {
    return { kind: 'seek', seconds: errorSeconds };
  }
  if (magnitude <= settings.deadbandSeconds) return { kind: 'hold' };

  const bend = clamp(errorSeconds / settings.gainSeconds, -settings.maxTrim, settings.maxTrim);
  return { kind: 'trim', trim: 1 + bend };
};
