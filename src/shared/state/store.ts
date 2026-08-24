/**
 * The one sanctioned place for mutable state.
 *
 * Everything else in the codebase is immutable; where a long-lived, changing
 * value is genuinely required (a queue that fills in the background, the
 * player's transport state) it lives here. The only way to change a store is to
 * hand it a pure function from the old value to the new one, which keeps the
 * transition logic itself testable and free of side effects.
 */
export interface Store<TState> {
  /** The current value. Never mutate it; produce a new one instead. */
  readonly get: () => TState;
  /** Applies a pure transition and returns the resulting state. */
  readonly update: (transition: (previous: TState) => TState) => TState;
  /** Replaces the value outright. */
  readonly set: (next: TState) => TState;
  /** Registers a listener; returns a function that removes it. */
  readonly subscribe: (listener: (state: TState, previous: TState) => void) => () => void;
}

export const createStore = <TState>(initialState: TState): Store<TState> => {
  let state = initialState;
  const listeners = new Set<(state: TState, previous: TState) => void>();

  const notify = (previous: TState): void => {
    if (previous === state) return;
    // Snapshot first: a listener may subscribe or unsubscribe while being notified.
    const current: ((state: TState, previous: TState) => void)[] = [];
    listeners.forEach((listener) => current.push(listener));
    for (const listener of current) {
      listener(state, previous);
    }
  };

  const set = (next: TState): TState => {
    const previous = state;
    state = next;
    notify(previous);
    return state;
  };

  return {
    get: () => state,
    set,
    update: (transition) => set(transition(state)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * A store guarding a critical section. `runExclusive` skips the task entirely
 * when one is already in flight, which is what every `if (this.isProcessing)
 * return;` guard in the original code was reaching for.
 */
export interface ExclusiveTask {
  readonly isRunning: () => boolean;
  /** Runs `task` unless it is already running, in which case resolves to null. */
  readonly runExclusive: <T>(task: () => Promise<T>) => Promise<T | null>;
}

export const createExclusiveTask = (): ExclusiveTask => {
  let running = false;

  return {
    isRunning: () => running,
    runExclusive: async <T>(task: () => Promise<T>): Promise<T | null> => {
      if (running) return null;
      running = true;
      try {
        return await task();
      } finally {
        running = false;
      }
    },
  };
};

/**
 * Runs tasks one at a time, in the order they arrive.
 *
 * The difference from {@link ExclusiveTask} is that nothing is skipped, which is
 * what a save needs: the periodic timer and the shutdown save write the same
 * file, and dropping the second one would lose exactly the state the user just
 * asked to keep. Queuing them instead means the last writer is the last caller.
 */
export interface SerialTask {
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
}

export const createSerialTask = (): SerialTask => {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      // Chained off both arms so one failed task cannot wedge the queue, and the
      // tail holds no result, so a long-lived chain retains nothing.
      const next = tail.then(task, task);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
};
