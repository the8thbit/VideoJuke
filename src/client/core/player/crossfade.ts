import type { CrossfadeTiming } from '../../../shared/types/video';
import { clampFraction } from '../../../shared/util/numbers';
import { animate } from '../dom/animation';

/**
 * The blend between the outgoing and the incoming video element.
 *
 * The legacy module carried two independent implementations of this: a
 * scheduled path and a second "legacy perform" path that the normal transition
 * actually used. They drove the same properties on the same curve but disagreed
 * about the starting state, and each one also built the next video's URL and
 * called play() itself. There is one animation here, it owns nothing but the
 * blend, and the caller keeps the job of loading and playing the elements.
 */
export interface CrossfadeVisuals {
  readonly blurEnabled: boolean;
  readonly maxBlurRadius: number;
}

export interface CrossfadeRequest {
  /** On screen at the start; ends the fade transparent and silent. */
  readonly from: HTMLVideoElement;
  /** Must already be playing; ends the fade opaque and at full volume. */
  readonly to: HTMLVideoElement;
  readonly durationMs: number;
  readonly visuals: CrossfadeVisuals;
}

export interface RunningCrossfade {
  readonly cancel: () => void;
  /** Resolves true when the fade ran to completion, false when cancelled. */
  readonly finished: Promise<boolean>;
}

export interface ScheduledCrossfade {
  readonly cancel: () => void;
}

/** At or below this much delay the fade is already due and simply starts now. */
const IMMEDIATE_THRESHOLD_MS = 100;

const setOpacity = (element: HTMLVideoElement, value: number): void => {
  element.style.opacity = String(value);
};

const setVolume = (element: HTMLVideoElement, value: number): void => {
  // A media element throws for a volume outside 0..1, and an eased value can
  // land a hair outside the range once floating point has had its say.
  element.volume = clampFraction(value);
};

const setBlur = (element: HTMLVideoElement, radiusPx: number): void => {
  element.style.filter = `blur(${radiusPx}px)`;
};

/** One frame of the blend at eased progress 0..1, `from` giving way to `to`. */
const paint = (request: CrossfadeRequest, progress: number): void => {
  const { from, to, visuals } = request;
  setOpacity(from, 1 - progress);
  setOpacity(to, progress);
  setVolume(from, 1 - progress);
  setVolume(to, progress);

  // Sharpening the incoming video as it arrives, in the same pass, is what keeps
  // blur and opacity on one curve; a separate ramp used to race this one.
  if (!visuals.blurEnabled) return;
  setBlur(from, progress * visuals.maxBlurRadius);
  setBlur(to, (1 - progress) * visuals.maxBlurRadius);
};

/**
 * Runs the blend. It never loads, plays, pauses or reassigns a source: the
 * caller owns the elements, and clears the inline opacity and filter this
 * leaves behind by showing and hiding them through the video stage.
 */
export const runCrossfade = (request: CrossfadeRequest): RunningCrossfade => {
  // Paint frame zero synchronously. The first animation frame is up to 16ms
  // away, and the legacy transition path spent that time with the incoming
  // element already opaque and at full volume, which was audible as a blip.
  paint(request, 0);

  const handle = animate({
    durationMs: request.durationMs,
    onFrame: (progress) => paint(request, progress),
  });

  const finished = handle.finished.then((completed) => {
    // Settle on the exact endpoint rather than on whatever the last frame
    // computed, so the caller inherits a clean state to reset from.
    if (completed) paint(request, 1);
    return completed;
  });

  return { cancel: handle.cancel, finished };
};

/**
 * Arms `onDue` for the moment the video reaches its crossfade start time.
 * A fade that is already due fires synchronously, because waiting even one more
 * timer tick would eat into the blend the timing was computed to allow.
 */
export const scheduleCrossfade = (options: {
  readonly video: HTMLVideoElement;
  readonly timing: CrossfadeTiming;
  readonly onDue: () => void;
}): ScheduledCrossfade => {
  const { video, timing, onDue } = options;
  const delayMs = Math.max(0, timing.startTime - video.currentTime) * 1000;

  if (delayMs <= IMMEDIATE_THRESHOLD_MS) {
    onDue();
    return { cancel: () => undefined };
  }

  const timer = setTimeout(onDue, delayMs);
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
};
