import { createStore } from '../../shared/state/store';
import {
  INITIAL_PIPELINE_STATE,
  type PhaseState,
  type PipelineState,
  type SettingsUpdateState,
} from '../../shared/types/status';
import { clampFraction } from '../../shared/util/numbers';

/** The two server-side steps, by the name `PipelineState` keys them under. */
export type PipelinePhase = 'index' | 'queue';

export interface PipelineTracker {
  readonly get: () => PipelineState;
  readonly running: (phase: PipelinePhase, progress: number, message: string) => void;
  readonly done: (phase: PipelinePhase, message: string) => void;
  readonly fail: (phase: PipelinePhase, message: string, error?: unknown) => void;
  readonly setAutoQueue: (enabled: boolean) => void;
  readonly setAutoPlay: (enabled: boolean) => void;
  readonly setUpdate: (update: SettingsUpdateState | null) => void;
  readonly subscribe: (listener: (state: PipelineState) => void) => () => void;
}

/**
 * Places an inner 0..1 progress inside the slice of a bar that a step owns,
 * e.g. `scaleProgress(0.1, 0.9, 0.5)` is halfway through a step that starts a
 * tenth of the way along. The legacy servers did this arithmetic inline against
 * a 0..100 scale, which is why their bar jumped backwards whenever two of those
 * expressions disagreed.
 */
export const scaleProgress = (base: number, span: number, inner: number): number =>
  clampFraction(base + span * clampFraction(inner));

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The index and queue steps, as a value clients can render.
 *
 * Listeners fire on every transition rather than on a timer, so a transport can
 * push each step to the start screen as it happens. Nothing here decides when a
 * step runs; the session does that, and this only records what it reports.
 */
export const createPipelineTracker = (): PipelineTracker => {
  const state = createStore<PipelineState>(INITIAL_PIPELINE_STATE);

  const setPhase = (phase: PipelinePhase, next: PhaseState): void => {
    state.update((previous) =>
      phase === 'index' ? { ...previous, index: next } : { ...previous, queue: next },
    );
  };

  return {
    get: state.get,

    running: (phase, progress, message) => {
      setPhase(phase, {
        status: 'running',
        progress: clampFraction(progress),
        message,
        error: null,
      });
    },

    done: (phase, message) => {
      setPhase(phase, { status: 'done', progress: 1, message, error: null });
    },

    fail: (phase, message, error) => {
      setPhase(phase, {
        status: 'error',
        progress: 0,
        // The message says what failed in words a user can act on; the error
        // field carries the detail, which is null when there is no exception
        // behind the failure.
        message,
        error: error === undefined ? null : describeError(error),
      });
    },

    setAutoQueue: (enabled) => {
      state.update((previous) =>
        previous.autoQueue === enabled ? previous : { ...previous, autoQueue: enabled },
      );
    },

    setAutoPlay: (enabled) => {
      state.update((previous) =>
        previous.autoPlay === enabled ? previous : { ...previous, autoPlay: enabled },
      );
    },

    setUpdate: (update) => {
      state.update((previous) => ({ ...previous, update }));
    },

    subscribe: (listener) => state.subscribe((next) => listener(next)),
  };
};
