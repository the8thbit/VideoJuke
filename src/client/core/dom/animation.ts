import { clampFraction, easeInOut } from '../../../shared/util/numbers';

/**
 * A single requestAnimationFrame tween.
 *
 * Blur ramps and crossfades were each driving their own hand-rolled rAF loop
 * with their own copy of the easing curve and their own cancellation
 * bookkeeping. They now share this one, which is also the only place the player
 * touches the animation clock.
 */
export interface AnimationHandle {
  /** Stops the animation; the completion promise resolves as cancelled. */
  readonly cancel: () => void;
  /** Resolves true when the tween ran to completion, false when cancelled. */
  readonly finished: Promise<boolean>;
}

export interface AnimationOptions {
  readonly durationMs: number;
  /** Receives eased progress in 0..1, called at least once with 1 on completion. */
  readonly onFrame: (progress: number) => void;
  /** Defaults to {@link easeInOut}; pass a linear function to opt out. */
  readonly easing?: (progress: number) => number;
}

/**
 * How long past the nominal duration to wait before finishing the tween without
 * the animation clock.
 *
 * Browsers stop firing requestAnimationFrame entirely while a tab is hidden, so
 * an rAF-only loop simply stops mid-fade and never resolves. Whatever awaits it
 * then hangs, which for the player means playback halts the first time a
 * crossfade begins in a backgrounded tab. Timers keep firing (throttled) in that
 * state, so one acts as the backstop: nobody is watching a fade they cannot see,
 * and jumping to the final frame is the right answer.
 */
const STALL_MARGIN_MS = 500;

const requestFrame = (callback: () => void): void => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 16);
};

/** Runs `onFrame` every animation frame until the duration elapses. */
export const animate = ({
  durationMs,
  onFrame,
  easing = easeInOut,
}: AnimationOptions): AnimationHandle => {
  let settled = false;
  let resolveFinished: (completed: boolean) => void = () => undefined;
  const finished = new Promise<boolean>((resolve) => {
    resolveFinished = resolve;
  });

  const settle = (completed: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(stallTimer);
    resolveFinished(completed);
  };

  const startedAt = Date.now();

  const step = (): void => {
    if (settled) return;

    const elapsed = Date.now() - startedAt;
    const progress = durationMs <= 0 ? 1 : clampFraction(elapsed / durationMs);
    onFrame(easing(progress));

    if (progress >= 1) {
      settle(true);
      return;
    }

    requestFrame(step);
  };

  const stallTimer = setTimeout(() => {
    if (settled) return;
    onFrame(easing(1));
    settle(true);
  }, durationMs + STALL_MARGIN_MS);

  requestFrame(step);

  return {
    cancel: () => settle(false),
    finished,
  };
};

/** Cancels a handle if there is one, and returns null so callers can reassign. */
export const cancelAnimation = (handle: AnimationHandle | null): null => {
  handle?.cancel();
  return null;
};
