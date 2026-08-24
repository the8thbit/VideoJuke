/**
 * A `<video>` element good enough to drive the real player with.
 *
 * The player is pure DOM manipulation around an injected `VideoStage`, so it can
 * be exercised without a browser as long as something answers the handful of
 * media properties it touches. This is that something: it records every listener
 * so a test can prove they are balanced, and it lets a test decide whether a
 * given source loads, fails, or never answers at all.
 */
export interface FakeVideoOptions {
  /** Sources that fire `error` instead of `canplaythrough`. */
  readonly broken?: ReadonlySet<string>;
  /** Sources that never answer, so the load runs into its timeout. */
  readonly silent?: ReadonlySet<string>;
  /** Makes `play()` reject the way an autoplay refusal does. */
  readonly refusePlay?: () => boolean;
}

export class FakeVideoElement extends EventTarget {
  currentTime = 0;
  duration = 60;
  paused = true;
  muted = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  loop = false;
  error: { code: number; message: string } | null = null;
  preload = '';
  parentNode: { removeChild: (child: unknown) => void } | null = null;
  readonly style: Record<string, string> = { opacity: '', filter: '', display: '' };
  readonly classes = new Set<string>();

  /** Live listener count per event type; the balance test reads this. */
  readonly listeners = new Map<string, number>();
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;

  private readonly options: FakeVideoOptions;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private source = '';

  constructor(options: FakeVideoOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Assigning a source is enough to start loading in a real element; `load()` is
   * only needed to restart one. Both routes land on the same scheduling here, and
   * the second cancels the first, so a caller that does both gets one outcome.
   */
  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    this.schedule();
  }

  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
    remove: (name: string): void => {
      this.classes.delete(name);
    },
  };

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, listener);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 0) - 1));
    super.removeEventListener(type, listener);
  }

  /** Total listeners still attached, across every event type. */
  liveListeners(): number {
    let total = 0;
    this.listeners.forEach((count) => {
      total += count;
    });
    return total;
  }

  removeAttribute(name: string): void {
    if (name !== 'src') return;
    this.source = '';
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.options.refusePlay?.() === true) {
      const refusal = new Error('play method is not allowed');
      refusal.name = 'NotAllowedError';
      throw refusal;
    }
    this.paused = false;
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  /** Mirrors the browser: the outcome of a load arrives on a later tick. */
  load(): void {
    this.loadCalls += 1;
    this.schedule();
  }

  private schedule(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;

    const source = this.source;
    if (source === '') return;
    if (this.options.silent?.has(source) === true) return;

    this.pending = setTimeout(() => {
      this.pending = null;
      if (this.source !== source) return;
      if (this.options.broken?.has(source) === true) {
        this.error = { code: 4, message: 'unsupported source' };
        this.dispatchEvent(new Event('error'));
        return;
      }
      this.error = null;
      // Real elements report readiness in stages, and different callers listen
      // for different ones: the queue's probe waits for `canplay`, the player's
      // loader for `canplaythrough`.
      this.dispatchEvent(new Event('canplay'));
      this.dispatchEvent(new Event('canplaythrough'));
    }, 0);
  }

  /** Drives the watchdog and the crossfade scheduler from a test. */
  seekTo(seconds: number): void {
    this.currentTime = seconds;
    this.dispatchEvent(new Event('timeupdate'));
  }

  endNaturally(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }

  fail(message = 'a decoding error'): void {
    this.error = { code: 3, message };
    this.dispatchEvent(new Event('error'));
  }
}

/** Lets the event loop run the timers a load or a fade is waiting on. */
export const settle = async (ticks = 6): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/**
 * Just enough `Document` for the playback queue, which creates one hidden
 * element to probe candidates with and appends it to the body.
 */
export const fakeDocument = (options: FakeVideoOptions = {}) => {
  const created: FakeVideoElement[] = [];
  const appended: FakeVideoElement[] = [];
  const body = {
    appendChild: (child: FakeVideoElement): void => {
      appended.push(child);
      child.parentNode = {
        removeChild: (removed: unknown) => {
          const index = appended.indexOf(removed as FakeVideoElement);
          if (index !== -1) appended.splice(index, 1);
        },
      };
    },
  };

  const document = {
    body,
    createElement: (tag: string): FakeVideoElement => {
      if (tag !== 'video') throw new Error(`unexpected element ${tag}`);
      const element = new FakeVideoElement(options);
      created.push(element);
      return element;
    },
  };

  return { document, created, appended };
};
