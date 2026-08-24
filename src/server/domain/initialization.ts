import { createStore } from '../../shared/state/store';
import {
  INITIAL_INITIALIZATION_STATE,
  type InitializationStage,
  type InitializationState,
} from '../../shared/types/status';
import { clampFraction } from '../../shared/util/numbers';

export interface InitializationTracker {
  readonly get: () => InitializationState;
  readonly set: (stage: InitializationStage, progress: number, message: string) => void;
  readonly fail: (message: string, error?: unknown) => void;
  readonly ready: (message?: string) => void;
  readonly subscribe: (listener: (state: InitializationState) => void) => () => void;
}

const READY_MESSAGE = 'Ready';

/**
 * Places an inner 0..1 progress inside the slice of the overall bar that a
 * phase owns, e.g. `scaleProgress(0.3, 0.3, 0.5)` is halfway through the
 * scanning phase and so 0.45 overall. Every phase in the legacy servers did
 * this arithmetic inline against a 0..100 scale, which is why the bar jumped
 * backwards whenever two of those expressions disagreed.
 */
export const scaleProgress = (base: number, span: number, inner: number): number =>
  clampFraction(base + span * clampFraction(inner));

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The startup state machine, as a value clients can render.
 *
 * Listeners fire on every transition rather than on a timer, so a transport
 * can push each step to the loading screen as it happens. The legacy web
 * server polled its own state every five seconds and rewrote it to `complete`
 * when it looked wrong, because nothing else guaranteed the client ever saw
 * the final transition.
 */
export const createInitializationTracker = (): InitializationTracker => {
  const state = createStore<InitializationState>(INITIAL_INITIALIZATION_STATE);

  return {
    get: state.get,

    set: (stage, progress, message) => {
      state.set({ stage, progress: clampFraction(progress), message, error: null });
    },

    fail: (message, error) => {
      state.set({
        stage: 'error',
        progress: 0,
        message,
        // The message says what failed in words a user can act on; the error
        // field carries the detail, which is null when there is no exception
        // behind the failure.
        error: error === undefined ? null : describeError(error),
      });
    },

    ready: (message = READY_MESSAGE) => {
      state.set({ stage: 'ready', progress: 1, message, error: null });
    },

    subscribe: (listener) => state.subscribe((next) => listener(next)),
  };
};
