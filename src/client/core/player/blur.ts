import type { BlurConfig } from '../../../shared/types/config';
import { createStore } from '../../../shared/state/store';
import { lerp } from '../../../shared/util/numbers';
import { animate, cancelAnimation, type AnimationHandle } from '../dom/animation';

/**
 * The blur that eases in as a video starts and eases back out as it ends.
 *
 * Crossfades paint their own blur in the same pass as the opacity so that both
 * move on one curve; this effect covers the transitions that are not a
 * crossfade. The legacy version decided that for itself by sniffing for
 * `fading-in`/`fading-out` classes on the element, which meant the rule lived in
 * the DOM rather than in the code that ordered the transition. The caller now
 * decides, and simply does not ramp what the crossfade is already blurring.
 */
export interface BlurEffect {
  /** Eases from the maximum radius down to zero. */
  readonly rampIn: (element: HTMLVideoElement) => void;
  /** Eases from zero up to the maximum radius. */
  readonly rampOut: (element: HTMLVideoElement) => void;
  /** Sets one radius immediately, cancelling any ramp on that element. */
  readonly apply: (element: HTMLVideoElement, radiusPx: number) => void;
  readonly clear: (element: HTMLVideoElement) => void;
  /** Returns the resulting state, so callers can mirror it without re-reading. */
  readonly setEnabled: (enabled: boolean) => boolean;
  readonly isEnabled: () => boolean;
  readonly maxRadius: () => number;
  readonly cleanup: () => void;
}

interface TrackedElement {
  readonly element: HTMLVideoElement;
  /** The ramp driving this element, or null when nothing is in flight. */
  readonly ramp: AnimationHandle | null;
}

interface BlurState {
  readonly enabled: boolean;
  /** Only the elements this effect has actually written a filter onto. */
  readonly tracked: readonly TrackedElement[];
}

/** Matches the hand-rolled 500ms ramp the legacy effect used for both directions. */
const DEFAULT_RAMP_DURATION_MS = 500;

const writeRadius = (element: HTMLVideoElement, radiusPx: number): void => {
  element.style.filter = `blur(${radiusPx}px)`;
};

const findTracked = (
  tracked: readonly TrackedElement[],
  element: HTMLVideoElement,
): TrackedElement | null => {
  for (let index = 0; index < tracked.length; index += 1) {
    const entry = tracked[index];
    if (entry !== undefined && entry.element === element) return entry;
  }
  return null;
};

const withTracked = (
  state: BlurState,
  element: HTMLVideoElement,
  ramp: AnimationHandle | null,
): BlurState => {
  const tracked: TrackedElement[] = [];
  state.tracked.forEach((existing) => {
    if (existing.element !== element) tracked.push(existing);
  });
  tracked.push({ element, ramp });
  return { enabled: state.enabled, tracked };
};

const withoutTracked = (state: BlurState, element: HTMLVideoElement): BlurState => {
  const tracked: TrackedElement[] = [];
  state.tracked.forEach((existing) => {
    if (existing.element !== element) tracked.push(existing);
  });
  return { enabled: state.enabled, tracked };
};

export const createBlurEffect = (
  config: BlurConfig,
  options?: { readonly rampDurationMs?: number },
): BlurEffect => {
  const rampDurationMs = options?.rampDurationMs ?? DEFAULT_RAMP_DURATION_MS;
  const state = createStore<BlurState>({ enabled: config.enabled, tracked: [] });

  const stopRamp = (element: HTMLVideoElement): void => {
    const entry = findTracked(state.get().tracked, element);
    if (entry !== null) cancelAnimation(entry.ramp);
  };

  /** Cancels every ramp and wipes the filter off everything being tracked. */
  const clearAll = (): void => {
    const previous = state.get();
    // Drop the tracking first: a ramp's completion handler checks whether it is
    // still the registered one, so an in-flight ramp cannot resurrect an entry.
    state.set({ enabled: previous.enabled, tracked: [] });
    previous.tracked.forEach((entry) => {
      cancelAnimation(entry.ramp);
      entry.element.style.filter = '';
    });
  };

  const ramp = (element: HTMLVideoElement, fromRadius: number, toRadius: number): void => {
    if (!state.get().enabled) return;

    // One ramp per element: starting a second would fight the first frame by frame.
    stopRamp(element);
    writeRadius(element, fromRadius);

    const handle = animate({
      durationMs: rampDurationMs,
      onFrame: (progress) => writeRadius(element, lerp(fromRadius, toRadius, progress)),
    });
    state.update((previous) => withTracked(previous, element, handle));

    handle.finished.then((completed) => {
      if (!completed) return;
      // Forget the finished handle so a later cancel cannot reach a dead ramp.
      state.update((previous) =>
        findTracked(previous.tracked, element)?.ramp === handle
          ? withTracked(previous, element, null)
          : previous,
      );
    });
  };

  const apply = (element: HTMLVideoElement, radiusPx: number): void => {
    if (!state.get().enabled) return;
    stopRamp(element);
    writeRadius(element, radiusPx);
    state.update((previous) => withTracked(previous, element, null));
  };

  const clear = (element: HTMLVideoElement): void => {
    stopRamp(element);
    element.style.filter = '';
    state.update((previous) => withoutTracked(previous, element));
  };

  const setEnabled = (enabled: boolean): boolean => {
    state.update((previous) => ({ enabled, tracked: previous.tracked }));
    // Turning the effect off has to take effect on screen at once. The legacy
    // version did that with document.querySelectorAll('video'), which also wiped
    // the filter off elements it had never touched.
    if (!enabled) clearAll();
    return enabled;
  };

  return {
    rampIn: (element) => ramp(element, config.maxAmount, 0),
    rampOut: (element) => ramp(element, 0, config.maxAmount),
    apply,
    clear,
    setEnabled,
    isEnabled: () => state.get().enabled,
    maxRadius: () => config.maxAmount,
    cleanup: clearAll,
  };
};
