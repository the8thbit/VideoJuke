import { createExclusiveTask, createStore } from '../../../shared/state/store';
import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import { attemptAsync, err, ok, type Result } from '../../../shared/types/result';
import type { CrossfadeTiming, QueuedVideo } from '../../../shared/types/video';
import { clamp, isFiniteNumber } from '../../../shared/util/numbers';
import { computeCrossfadeTiming, toCrossfadeSettings } from '../../../shared/video/crossfadeTiming';
import { resolveVideoUrl } from '../../../shared/video/videoLocation';
import { createBlurEffect } from './blur';
import {
  runCrossfade,
  scheduleCrossfade,
  type RunningCrossfade,
  type ScheduledCrossfade,
} from './crossfade';
import type { VideoStage } from './videoStage';

/** Everything an observer can ask about playback, in one immutable value. */
export interface PlayerSnapshot {
  readonly current: QueuedVideo | null;
  readonly speed: number;
  readonly looping: boolean;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly transitioning: boolean;
  readonly crossfadeEnabled: boolean;
  readonly blurEnabled: boolean;
}

/**
 * What the player needs from the application around it. The legacy player owned
 * four nullable `onSomethingCallback` fields that were assigned after
 * construction, so every call site had to re-check whether they were set.
 */
export interface VideoPlayerEvents {
  readonly onEnded: (video: QueuedVideo) => void;
  readonly onError: (error: Error) => void;
  readonly onStarted: (video: QueuedVideo, isFirst: boolean) => void;
  /** Supplies the video a scheduled crossfade will blend into. */
  readonly requestNext: () => Promise<QueuedVideo | null>;
  /**
   * Hands back a video `requestNext` produced but the fade never played.
   *
   * Without it a scheduled crossfade that failed to load its incoming video
   * simply dropped it: the queue had already given it up, the fade gave up too,
   * and the viewer never saw that file again this session.
   */
  readonly returnNext: (video: QueuedVideo) => void;
}

export interface VideoPlayerDeps {
  readonly stage: VideoStage;
  readonly config: ClientConfig;
  readonly logger: Logger;
  /** The page's own origin, or null in Electron where files are read directly. */
  readonly origin: string | null;
  readonly events: VideoPlayerEvents;
}

export interface VideoPlayer {
  readonly play: (
    video: QueuedVideo,
    options?: { readonly isFirst?: boolean; readonly manual?: boolean },
  ) => Promise<Result<void, Error>>;
  readonly snapshot: () => PlayerSnapshot;
  /** Claims the transition slot for a manual skip; false when one is running. */
  readonly beginManualTransition: () => boolean;
  readonly togglePlayPause: () => void;
  readonly restart: () => void;
  readonly toggleLoop: () => boolean;
  readonly toggleMute: () => boolean;
  readonly toggleCrossfade: () => boolean;
  readonly toggleBlur: () => boolean;
  /** Clamps into the configured range and returns the speed actually applied. */
  readonly setSpeed: (speed: number) => number;
  readonly adjustSpeed: (delta: number) => number;
  readonly seekBy: (seconds: number) => void;
  readonly setPaused: (paused: boolean) => void;
  /** Unmutes and plays the active element, in answer to a user gesture. */
  readonly resumeWithSound: () => Promise<void>;

  /** Where the video on screen has got to, in seconds. */
  readonly position: () => number;
  /**
   * Multiplies the viewer's chosen speed, for a follower converging on a leader.
   *
   * Deliberately not folded into `speed`. That value is what the viewer asked
   * for: it is printed in the debug panel and the status overlay, and
   * `adjustSpeed` steps from it. A correction of a percent or two arriving four
   * times a second would make the display flicker and every nudge would
   * compound into the next one.
   */
  readonly setSyncTrim: (trim: number) => void;
  /** Jumps to a position, staying clear of the end so the watchdog is not tripped. */
  readonly syncSeek: (seconds: number) => void;
  readonly cleanup: () => void;
}

/**
 * Playback starts muted and the sound follows shortly after, because browsers
 * refuse an audible autoplay outright.
 */
const UNMUTE_DELAY_MS = 100;

/**
 * How close to the end counts as ended. Some files never fire `ended` at all,
 * so the legacy player watched `timeupdate` for the last tenth of a second and
 * finished the video itself; that watchdog is kept.
 */
const END_WATCHDOG_SECONDS = 0.1;

/** A seek stops short of the very end, so seeking forward is not an ending. */
const SEEK_END_MARGIN_SECONDS = 0.1;

/**
 * How far a sync seek stays clear of the end.
 *
 * Wider than a manual seek because the end watchdog fires within 0.1s of the
 * duration: a follower told to jump to a leader position inside that window
 * would end its video early and every time.
 */
const SYNC_SEEK_END_MARGIN_SECONDS = 0.25;

/** The bounds a media element accepts for `playbackRate`. */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

const INTERACTION_REQUIRED = 'user interaction is required before playback can start';

type Disposer = () => void;

/**
 * Registers one listener and hands back the matching removal, so attach and
 * detach can never drift apart. The legacy player kept its handlers in a
 * WeakMap keyed by element and rebuilt the same pairing by hand.
 */
const listen = <TType extends keyof HTMLVideoElementEventMap>(
  element: HTMLVideoElement,
  type: TType,
  handler: (event: HTMLVideoElementEventMap[TType]) => void,
): Disposer => {
  element.addEventListener(type, handler);
  return () => {
    element.removeEventListener(type, handler);
  };
};

const disposeAll = (disposers: readonly Disposer[]): Disposer => () => {
  disposers.forEach((dispose) => dispose());
};

/** `release` removes the attribute, so an empty `src` means "nothing loaded". */
const hasSource = (element: HTMLVideoElement): boolean => element.src !== '';

const MEDIA_ERROR_LABELS: Readonly<Record<number, string>> = {
  1: 'loading was aborted',
  2: 'a network error',
  3: 'a decoding error',
  4: 'an unsupported source',
};

const describeMediaError = (error: MediaError | null): string => {
  if (error === null) return 'an unknown media error';
  const label = MEDIA_ERROR_LABELS[error.code] ?? `media error ${error.code}`;
  return error.message === '' ? label : `${label}: ${error.message}`;
};

/** The autoplay policy reports itself under several names and messages. */
const AUTOPLAY_PHRASES: readonly string[] = [
  'play method is not allowed',
  "user didn't interact",
  'user denied permission',
];

const isAutoplayBlocked = (error: Error): boolean => {
  if (error.name === 'NotAllowedError') return true;
  for (let index = 0; index < AUTOPLAY_PHRASES.length; index += 1) {
    const phrase = AUTOPLAY_PHRASES[index];
    if (phrase !== undefined && error.message.indexOf(phrase) !== -1) return true;
  }
  return false;
};

/**
 * The refusal produced when the transition guard is already held. It is marked
 * so the shell can tell it apart from a load or decode failure: a skip that
 * races a natural end costs the viewer nothing, while a broken file does.
 */
const TRANSITION_BUSY_NAME = 'TransitionBusyError';

const transitionBusyError = (): Error => {
  const error = new Error('a transition is already in progress');
  error.name = TRANSITION_BUSY_NAME;
  return error;
};

/** Whether `play` was refused outright rather than failing to play the video. */
export const isTransitionBusyError = (error: Error): boolean =>
  error.name === TRANSITION_BUSY_NAME;

/** Whether an element was actually started, or refused by the autoplay policy. */
type StartOutcome = 'started' | 'blocked';

export const createVideoPlayer = (deps: VideoPlayerDeps): VideoPlayer => {
  const { stage, config, logger, origin, events } = deps;

  const state = createStore<PlayerSnapshot>({
    current: null,
    speed: 1,
    looping: false,
    paused: false,
    muted: false,
    transitioning: false,
    // The toggles start from the configuration and then live here: `config` is
    // immutable, while the legacy player wrote its answer back into it.
    crossfadeEnabled: config.crossfade.enabled,
    blurEnabled: config.blur.enabled,
  });

  /**
   * One guard for every transition, whether it was asked for or scheduled. The
   * legacy player used a boolean it cleared from a 100ms timer, which released
   * the guard while the transition it protected was still loading.
   */
  const transition = createExclusiveTask();
  const blur = createBlurEffect(config.blur);
  const crossfadeSettings = toCrossfadeSettings(config);

  // Cancellation tokens for work in flight rather than observable state: they
  // say what is running, and nothing outside this module can see them.
  let scheduled: ScheduledCrossfade | null = null;
  let running: RunningCrossfade | null = null;
  let activeListeners: Disposer | null = null;
  let unmuteTimer: ReturnType<typeof setTimeout> | null = null;
  // Latches the end of the current video, so the watchdog and a late `ended`
  // event cannot both advance the queue.
  let endReported = false;
  /**
   * The follower's correction factor, multiplied into the applied rate. One
   * means "not correcting", which is what every video starts at.
   */
  let syncTrim = 1;
  /**
   * Set by `cleanup`. A transition that was mid-`await` when the app stopped
   * still resolves afterwards, and promoting an element the stage has already
   * released re-attaches listeners to a dead player.
   */
  let disposed = false;
  // An end that arrived while the transition guard was held, held back until the
  // guard is released. Dropping it outright loses the only thing that would have
  // advanced the queue when the transition it collided with fails.
  let pendingEnd: HTMLVideoElement | null = null;
  /**
   * The same latch for a failure, and for the same reason.
   *
   * Delivering an error straight through while the guard was held was the one
   * asymmetry between the two: the shell answers `onError` by arming a single
   * recovery timer, that timer's `play` is refused by the guard the failing
   * transition still holds, and the refusal arms nothing. When the transition
   * then failed as well, both sides had deferred to the other - and the video
   * that raised the error will never fire `ended`, so nothing was left to move
   * the queue on and the screen held a dead frame until a key was pressed.
   */
  let pendingError: HTMLVideoElement | null = null;

  const patch = (change: Partial<PlayerSnapshot>): void => {
    state.update((previous) => ({ ...previous, ...change }));
  };

  /**
   * What actually gets written to an element: the viewer's speed with the sync
   * correction folded in, clamped to what a media element will take.
   */
  const effectiveRate = (): number => clamp(state.get().speed * syncTrim, MIN_RATE, MAX_RATE);

  const clearUnmuteTimer = (): void => {
    if (unmuteTimer === null) return;
    clearTimeout(unmuteTimer);
    unmuteTimer = null;
  };

  const cancelScheduled = (): void => {
    if (scheduled === null) return;
    scheduled.cancel();
    scheduled = null;
  };

  const timingFor = (video: QueuedVideo, element: HTMLVideoElement): CrossfadeTiming | null => {
    const declared = video.video.crossfadeTiming;
    if (declared !== null) return declared;
    // A video taken back out of history can arrive without timing; the
    // element's own duration is what the legacy player always measured.
    return computeCrossfadeTiming(
      isFiniteNumber(element.duration) ? element.duration : null,
      crossfadeSettings,
    );
  };

  /**
   * `scheduleCrossfade` measures its delay in media time, which only equals the
   * wall clock at 1x. Dividing the remaining media time by the playback rate is
   * what makes the fade land on time at 2x, and is why a speed change has to
   * re-arm the schedule.
   */
  const toWallClock = (
    timing: CrossfadeTiming,
    element: HTMLVideoElement,
    speed: number,
  ): CrossfadeTiming => {
    if (speed <= 0 || speed === 1) return timing;
    const position = element.currentTime;
    const remaining = Math.max(0, timing.startTime - position);
    return { duration: timing.duration, startTime: position + remaining / speed };
  };

  const scheduleNextCrossfade = (): void => {
    cancelScheduled();

    const snapshot = state.get();
    if (!snapshot.crossfadeEnabled || snapshot.paused || snapshot.current === null) return;
    // A looping video never hands over, and an armed fade would take the next
    // video out of the queue and play it anyway.
    if (snapshot.looping) return;

    const element = stage.active();
    if (!hasSource(element)) return;

    const timing = timingFor(snapshot.current, element);
    if (timing === null) return;

    // A fade that is already due fires from inside `scheduleCrossfade`, so the
    // handle it returns is stale by the time it arrives.
    let fired = false;
    const handle = scheduleCrossfade({
      video: element,
      timing: toWallClock(timing, element, snapshot.speed),
      onDue: () => {
        fired = true;
        scheduled = null;
        void beginScheduledCrossfade(timing.duration);
      },
    });
    scheduled = fired ? null : handle;
  };

  /**
   * `escalatesFailure` says whether this caller's failure reaches the shell,
   * which recovers from it by advancing the queue itself. A latched end is then
   * dropped rather than delivered, because two routes to the next video would
   * dequeue two of them; every other outcome leaves the end still owed.
   */
  const runTransition = async (
    task: () => Promise<Result<void, Error>>,
    options: { readonly escalatesFailure: boolean },
  ): Promise<Result<void, Error>> => {
    const outcome = await transition.runExclusive(async () => {
      patch({ transitioning: true });
      try {
        return await task();
      } finally {
        patch({ transitioning: false });
      }
    });
    // Refused: the guard belongs to a transition still in flight, and that one
    // owns whatever it latched.
    if (outcome === null) return err(transitionBusyError());

    // The guard is free again, so a latched end or failure can be delivered from
    // here. A failure goes first and cancels the end: both routes lead to the
    // shell advancing, and taking both would advance twice.
    if (!outcome.ok && options.escalatesFailure) {
      pendingEnd = null;
      pendingError = null;
    } else if (drainPendingError()) {
      pendingEnd = null;
    } else {
      drainPendingEnd();
    }
    return outcome;
  };

  const loadElement = (
    element: HTMLVideoElement,
    video: QueuedVideo,
  ): Promise<Result<void, Error>> =>
    new Promise((resolve) => {
      const snapshot = state.get();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dispose: Disposer = () => undefined;
      let settled = false;

      const finish = (result: Result<void, Error>): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        dispose();
        resolve(result);
      };

      // Attached before the source is assigned, so a source the browser rejects
      // outright is still reported here rather than to the previous listener.
      dispose = disposeAll([
        listen(element, 'canplaythrough', () => {
          finish(ok(undefined));
        }),
        listen(element, 'error', () => {
          finish(err(new Error(describeMediaError(element.error))));
        }),
      ]);

      element.src = resolveVideoUrl(video.video.location, origin);
      element.muted = snapshot.muted;
      element.volume = 1;
      // The load algorithm resets `playbackRate` to `defaultPlaybackRate`, so
      // setting only the former meant a video loaded at 2x played its whole
      // crossfade at 1x before the handover corrected it. `defaultPlaybackRate`
      // is the viewer's speed rather than the corrected one, so a reload lands
      // on an untrimmed video rather than inheriting somebody else's error.
      syncTrim = 1;
      element.defaultPlaybackRate = snapshot.speed;
      element.playbackRate = snapshot.speed;
      element.preservesPitch = true;
      // Looping is driven from the ended handler, so that one place decides
      // what happens when a video runs out.
      element.loop = false;
      element.currentTime = 0;
      element.load();

      timer = setTimeout(() => {
        finish(err(new Error(`load timed out after ${config.timeouts.videoLoadTimeout}ms`)));
      }, config.timeouts.videoLoadTimeout);
    });

  /**
   * Keeps an eye on an element between the moment it finishes loading and the
   * moment it becomes the active one.
   *
   * `loadElement` removes its own listeners when `canplaythrough` fires, and
   * `attachListeners` only runs at the handover, so for the whole length of a
   * crossfade the arriving video had nothing listening for `error`. A decode
   * failure in that window fired once, was heard by nobody, and left playback on
   * a frame that would never end, never error and never advance.
   */
  const watchForError = (
    element: HTMLVideoElement,
  ): { readonly failure: () => Error | null; readonly dispose: Disposer } => {
    let failure: Error | null = null;
    const dispose = listen(element, 'error', () => {
      failure = new Error(describeMediaError(element.error));
    });
    return { failure: () => failure, dispose };
  };

  const scheduleUnmute = (element: HTMLVideoElement, restoreVolume: boolean): void => {
    clearUnmuteTimer();
    if (state.get().muted) return;

    unmuteTimer = setTimeout(() => {
      unmuteTimer = null;
      // Only once the element is demonstrably running: unmuting one that never
      // started is what made the policy refuse a second time.
      if (element.paused || element.currentTime === 0) return;
      if (state.get().muted) return;
      element.muted = false;
      // During a crossfade the fade owns the volume ramp.
      if (restoreVolume) element.volume = 1;
    }, UNMUTE_DELAY_MS);
  };

  const startElement = async (
    element: HTMLVideoElement,
    options: { readonly restoreVolume: boolean },
  ): Promise<Result<StartOutcome, Error>> => {
    // Muted first: an audible autoplay is refused by every browser, and that
    // refusal would be indistinguishable from a broken file.
    element.muted = true;

    const played = await attemptAsync(() => element.play());
    if (!played.ok) {
      if (isAutoplayBlocked(played.error)) return ok('blocked');
      return err(played.error);
    }

    scheduleUnmute(element, options.restoreVolume);
    return ok('started');
  };

  const runFade = async (
    from: HTMLVideoElement,
    to: HTMLVideoElement,
    durationMs: number,
  ): Promise<boolean> => {
    const fade = runCrossfade({
      from,
      to,
      durationMs,
      visuals: { blurEnabled: state.get().blurEnabled, maxBlurRadius: blur.maxRadius() },
    });
    running = fade;
    const completed = await fade.finished;
    if (running === fade) running = null;
    return completed;
  };

  /**
   * Puts the video that is staying on screen back the way the stylesheet wants
   * it, after a fade that will not be promoted.
   *
   * `runCrossfade` paints its last frame before the caller ever looks at whether
   * the incoming video survived, so an abandoned handover left the *outgoing*
   * element - still active, still playing - at inline `opacity: 0`, `volume: 0`
   * and a full blur radius. The viewer got a black, silent screen for the rest
   * of that video with nothing on screen to say why.
   */
  const restoreAbandoned = (element: HTMLVideoElement): void => {
    if (!hasSource(element)) return;
    // Clears the inline opacity and filter the fade wrote, so the stylesheet is
    // in charge of visibility again.
    stage.show(element);
    blur.clear(element);
    // The fade owned the volume for as long as it ran; nothing owns it now.
    if (!state.get().muted) element.volume = 1;
  };

  const detachListeners = (): void => {
    if (activeListeners === null) return;
    activeListeners();
    activeListeners = null;
  };

  const attachListeners = (element: HTMLVideoElement): void => {
    detachListeners();
    activeListeners = disposeAll([
      listen(element, 'ended', () => handleEnded(element)),
      listen(element, 'error', () => handleError(element)),
      listen(element, 'timeupdate', () => handleTimeUpdate(element)),
    ]);
  };

  const finishTransition = (options: {
    readonly video: QueuedVideo;
    readonly outgoing: HTMLVideoElement;
    readonly isFirst: boolean;
    readonly rampBlur: boolean;
  }): void => {
    if (disposed) return;
    const active = stage.swap();
    // A transport change made during the handover was written to whichever
    // element was on screen at the time, which is the one now being retired.
    // The promoted element still carries what it was loaded with, so the stored
    // state wins here. The volume is left alone: the last fade frame settled it.
    const transport = state.get();
    active.playbackRate = effectiveRate();
    active.preservesPitch = true;
    // The pause landed on whichever element was on screen, which during a fade
    // is the one being retired. Without this the viewer pressed pause, watched
    // the outgoing video stop, and then watched the incoming one carry on
    // playing while every control insisted playback was paused.
    if (transport.paused) active.pause();
    if (transport.muted) active.muted = true;
    // Unmuting keeps its start-up delay rather than being written directly: an
    // element that has only just begun playing muted is refused a second time.
    else scheduleUnmute(active, false);

    // Clears the inline opacity and filter a fade leaves behind, so the
    // stylesheet is in charge of visibility again.
    stage.show(active);
    // Detached first: releasing an element makes it fire on its way down, and
    // those events are about a video that is no longer anybody's business.
    detachListeners();
    // Released, not merely hidden: the decoder holds the temp file open. The
    // legacy player only let go when the *next* transition started, which is
    // also why its fades ran from an element it had already blanked.
    stage.release(options.outgoing);

    patch({ current: options.video });
    endReported = false;
    // The outgoing video was replaced, so `onStarted` already accounts for it;
    // an end or failure latched against it would advance the queue a second time.
    if (pendingEnd === options.outgoing) pendingEnd = null;
    if (pendingError === options.outgoing) pendingError = null;
    attachListeners(active);
    scheduleNextCrossfade();
    if (options.rampBlur) blur.rampIn(active);

    if (options.isFirst) logger.info('playback started');
    logger.debug(`now playing ${options.video.video.filename}`);
    events.onStarted(options.video, options.isFirst);
  };

  const runPlay = async (
    video: QueuedVideo,
    isFirst: boolean,
    manual: boolean,
  ): Promise<Result<void, Error>> => {
    cancelScheduled();

    const outgoing = stage.active();
    const incoming = stage.idle();
    const outgoingHasSource = hasSource(outgoing);
    const filename = video.video.filename;

    logger.debug(`loading ${filename}${manual ? ' (manual)' : ''}`);

    const loaded = await loadElement(incoming, video);
    if (!loaded.ok) {
      stage.release(incoming);
      return err(new Error(`could not load ${filename}: ${loaded.error.message}`));
    }

    const watch = watchForError(incoming);
    const abandon = (reason: string): Result<void, Error> => {
      watch.dispose();
      stage.release(incoming);
      restoreAbandoned(outgoing);
      return err(new Error(reason));
    };

    const snapshot = state.get();
    // Exactly the legacy conditions: a blend needs something to blend out of,
    // and a manual skip is meant to feel immediate.
    const useCrossfade =
      !snapshot.paused && snapshot.crossfadeEnabled && !isFirst && outgoingHasSource && !manual;

    if (!snapshot.paused) {
      // A cut shows the loaded frame before playback starts so the swap does
      // not flash black; a fade has to stay invisible until `runCrossfade`
      // paints frame zero, which it does in the same tick as the show below.
      if (!useCrossfade) stage.show(incoming);

      const started = await startElement(incoming, { restoreVolume: !useCrossfade });
      if (!started.ok) {
        return abandon(`could not play ${filename}: ${started.error.message}`);
      }

      if (started.value === 'blocked') {
        // The frame is loaded and correct; only the audio gate stopped it. The
        // transition is finished anyway so the shell can resume the element the
        // viewer can now see, instead of the legacy prompt div this module used
        // to write into the document.
        patch({ paused: true });
        watch.dispose();
        finishTransition({ video, outgoing, isFirst, rampBlur: false });
        return err(new Error(INTERACTION_REQUIRED));
      }

      if (useCrossfade) {
        stage.show(incoming);
        const completed = await runFade(outgoing, incoming, config.crossfade.duration);
        // A cancelled fade means cleanup tore the stage down; promoting now
        // would re-attach listeners to an element cleanup has just released.
        if (!completed) {
          watch.dispose();
          return ok(undefined);
        }
      }

      const failed = watch.failure();
      if (failed !== null) return abandon(`${filename} failed while starting: ${failed.message}`);
    }

    watch.dispose();
    finishTransition({
      video,
      outgoing,
      isFirst,
      // The fade already blurred the arriving video on its own curve, and a
      // manual skip or the first video is not a transition to soften.
      rampBlur: state.get().blurEnabled && !isFirst && !manual && !useCrossfade,
    });
    return ok(undefined);
  };

  const runScheduledCrossfade = async (
    durationSeconds: number,
  ): Promise<Result<void, Error>> => {
    const outgoing = stage.active();
    const incoming = stage.idle();

    const next = await events.requestNext();
    if (next === null) {
      // Nothing to blend into: the video plays out and the ended handler
      // advances, which is what the legacy player did on an empty queue.
      logger.debug('no next video for the scheduled crossfade; letting this one end');
      return ok(undefined);
    }

    /**
     * The queue has already given this video up. Every way out of this function
     * that does not play it therefore has to hand it back, or it is gone: the
     * caller only logs the failure, and the video that was next in line would
     * never be offered again.
     */
    const giveBack = (result: Result<void, Error>): Result<void, Error> => {
      events.returnNext(next);
      return result;
    };

    const loaded = await loadElement(incoming, next);
    if (!loaded.ok) {
      stage.release(incoming);
      return giveBack(
        err(new Error(`could not load ${next.video.filename}: ${loaded.error.message}`)),
      );
    }

    const watch = watchForError(incoming);
    const abandon = (reason: string): Result<void, Error> => {
      watch.dispose();
      stage.release(incoming);
      restoreAbandoned(outgoing);
      return giveBack(err(new Error(reason)));
    };

    // The fade drives the volume, so the unmute must not restore it.
    const started = await startElement(incoming, { restoreVolume: false });
    if (!started.ok) {
      return abandon(`could not play ${next.video.filename}: ${started.error.message}`);
    }
    if (started.value === 'blocked') return abandon(INTERACTION_REQUIRED);

    // Checked before the blend as well as after it: a source that has already
    // failed is not worth half a second of fading into.
    const failedEarly = watch.failure();
    if (failedEarly !== null) {
      return abandon(`${next.video.filename} failed before the crossfade: ${failedEarly.message}`);
    }

    stage.show(incoming);
    const completed = await runFade(outgoing, incoming, durationSeconds * 1000);
    // A cancelled fade means cleanup tore the stage down; there is nothing left
    // to promote, and nothing left to play the video with either.
    if (!completed) {
      watch.dispose();
      return ok(undefined);
    }

    const failed = watch.failure();
    if (failed !== null) {
      return abandon(`${next.video.filename} failed during the crossfade: ${failed.message}`);
    }

    watch.dispose();
    finishTransition({ video: next, outgoing, isFirst: false, rampBlur: false });
    return ok(undefined);
  };

  const beginScheduledCrossfade = async (durationSeconds: number): Promise<void> => {
    // Nothing above this catches a failed handover, so a latched end has to be
    // delivered rather than dropped.
    const result = await runTransition(() => runScheduledCrossfade(durationSeconds), {
      escalatesFailure: false,
    });
    if (result.ok) return;
    // The current video is still on screen and will end on its own, so this is
    // a missed optimisation rather than a playback failure.
    logger.warn(`scheduled crossfade abandoned - ${result.error.message}`);
  };

  const handleEnded = (element: HTMLVideoElement): void => {
    // An element that has already been swapped out finishes off screen.
    if (element !== stage.active()) return;

    const snapshot = state.get();
    if (snapshot.looping) {
      element.currentTime = 0;
      void attemptAsync(() => element.play()).then((played) => {
        if (!played.ok) logger.error('could not restart the looping video', played.error);
      });
      return;
    }

    if (endReported) return;
    // A transition is already replacing this video, either because the shell
    // asked for one or because the scheduled crossfade is mid-handover. Latched
    // rather than dropped: a handover that then fails leaves this end as the
    // only thing that would move the queue on.
    if (transition.isRunning()) {
      pendingEnd = element;
      return;
    }

    const current = snapshot.current;
    if (current === null) return;

    endReported = true;
    logger.debug(`video ended: ${current.video.filename}`);
    events.onEnded(current);
  };

  /**
   * Delivers an end that was latched while the guard was held. Cleared before
   * the handler runs so one latch can only advance once, and skipped when the
   * transition moved past the element, whose end is then already accounted for.
   */
  const drainPendingEnd = (): void => {
    const element = pendingEnd;
    pendingEnd = null;
    if (element === null || element !== stage.active()) return;
    handleEnded(element);
  };

  const handleError = (element: HTMLVideoElement): void => {
    if (element !== stage.active()) return;

    // Latched, exactly as an end is: the shell's answer to a failure is to arm
    // one recovery timer, and a timer that fires against a held guard is
    // refused and re-arms nothing.
    if (transition.isRunning()) {
      pendingError = element;
      return;
    }

    const detail = describeMediaError(element.error);
    logger.error(`playback failed: ${detail}`);
    events.onError(new Error(detail));
  };

  /**
   * Delivers a failure that was latched while the guard was held, and reports
   * whether it did. Skipped when the transition moved past the element, whose
   * failure the video now on screen has already made irrelevant.
   */
  const drainPendingError = (): boolean => {
    const element = pendingError;
    pendingError = null;
    if (element === null || element !== stage.active()) return false;
    handleError(element);
    return true;
  };

  const handleTimeUpdate = (element: HTMLVideoElement): void => {
    if (element !== stage.active()) return;

    const snapshot = state.get();
    if (snapshot.looping || element.paused) return;

    const duration = element.duration;
    if (!isFiniteNumber(duration) || duration <= 0) return;
    if (duration - element.currentTime >= END_WATCHDOG_SECONDS) return;

    // Some files stop delivering frames without ever firing `ended`.
    element.pause();
    handleEnded(element);
  };

  const resume = (element: HTMLVideoElement): void => {
    void attemptAsync(() => element.play()).then((played) => {
      if (!played.ok) {
        logger.error('could not resume playback', played.error);
        patch({ paused: true });
        return;
      }
      patch({ paused: false });
      scheduleNextCrossfade();
    });
  };

  const setPaused = (paused: boolean): void => {
    const active = stage.active();

    if (paused) {
      patch({ paused: true });
      cancelScheduled();
      if (hasSource(active)) active.pause();
      return;
    }

    patch({ paused: false });
    if (hasSource(active)) resume(active);
  };

  const setSpeed = (speed: number): number => {
    const clamped = clamp(speed, config.playback.minSpeed, config.playback.maxSpeed);
    patch({ speed: clamped });

    const active = stage.active();
    if (hasSource(active)) {
      active.playbackRate = effectiveRate();
      active.preservesPitch = true;
      // The remaining wall-clock time just changed, so the armed fade is wrong.
      scheduleNextCrossfade();
    }
    return clamped;
  };

  const cleanup = (): void => {
    // Before anything is torn down: a transition still awaiting a load or a fade
    // resolves after this returns, and `finishTransition` checks this flag
    // rather than promoting an element the stage no longer owns.
    disposed = true;
    cancelScheduled();
    if (running !== null) {
      running.cancel();
      running = null;
    }
    clearUnmuteTimer();
    detachListeners();

    const elements = stage.both();
    stage.release(elements[0]);
    stage.release(elements[1]);
    blur.cleanup();

    endReported = false;
    pendingEnd = null;
    pendingError = null;
    syncTrim = 1;
    patch({ current: null, paused: true, transitioning: false });
    logger.info('player stopped');
  };

  return {
    play: (video, options) =>
      runTransition(() => runPlay(video, options?.isFirst === true, options?.manual === true), {
        escalatesFailure: true,
      }),

    snapshot: () => state.get(),

    beginManualTransition: () => {
      if (transition.isRunning()) return false;
      // The fade the current video was heading into is no longer wanted.
      cancelScheduled();
      const active = stage.active();
      if (hasSource(active)) blur.clear(active);
      return true;
    },

    togglePlayPause: () => {
      const active = stage.active();
      // The element is the truth about whether anything is running.
      if (!hasSource(active)) return;
      setPaused(!active.paused);
    },

    restart: () => {
      const active = stage.active();
      if (!hasSource(active)) return;

      cancelScheduled();
      active.currentTime = 0;
      endReported = false;

      if (state.get().paused) resume(active);
      else scheduleNextCrossfade();
    },

    toggleLoop: () => {
      const looping = !state.get().looping;
      patch({ looping });
      if (looping) cancelScheduled();
      else scheduleNextCrossfade();
      return looping;
    },

    toggleMute: () => {
      const muted = !state.get().muted;
      patch({ muted });
      if (muted) clearUnmuteTimer();

      const active = stage.active();
      // The volume is left alone: a fade in flight owns it.
      if (hasSource(active)) active.muted = muted;
      return muted;
    },

    toggleCrossfade: () => {
      const crossfadeEnabled = !state.get().crossfadeEnabled;
      patch({ crossfadeEnabled });
      if (crossfadeEnabled) scheduleNextCrossfade();
      else cancelScheduled();
      return crossfadeEnabled;
    },

    toggleBlur: () => {
      const blurEnabled = !state.get().blurEnabled;
      patch({ blurEnabled });
      // The effect wipes the filter off what it painted when it is turned off.
      blur.setEnabled(blurEnabled);
      return blurEnabled;
    },

    setSpeed,
    adjustSpeed: (delta) => setSpeed(state.get().speed + delta),

    seekBy: (seconds) => {
      const active = stage.active();
      if (!hasSource(active)) return;

      const duration = active.duration;
      if (!isFiniteNumber(duration) || duration <= 0) return;

      const limit = Math.max(0, duration - SEEK_END_MARGIN_SECONDS);
      active.currentTime = clamp(active.currentTime + seconds, 0, limit);
      // The armed fade was measured from the old position.
      scheduleNextCrossfade();
    },

    setPaused,

    position: () => {
      const active = stage.active();
      return hasSource(active) ? active.currentTime : 0;
    },

    setSyncTrim: (trim) => {
      const next = clamp(trim, MIN_RATE, MAX_RATE);
      if (next === syncTrim) return;
      syncTrim = next;

      const active = stage.active();
      if (!hasSource(active)) return;
      active.playbackRate = effectiveRate();
      // Through the same path a speed change takes. `scheduleCrossfade` measures
      // its delay in media time and divides by the rate held when it was armed,
      // so a rate that changes without a re-arm makes the fade land late by the
      // difference - and it recomputes from the live position, so repeated
      // re-arms do not accumulate error.
      scheduleNextCrossfade();
    },

    syncSeek: (seconds) => {
      const active = stage.active();
      if (!hasSource(active)) return;

      const duration = active.duration;
      if (!isFiniteNumber(duration) || duration <= 0) return;

      const limit = Math.max(0, duration - SYNC_SEEK_END_MARGIN_SECONDS);
      active.currentTime = clamp(seconds, 0, limit);
      scheduleNextCrossfade();
    },

    resumeWithSound: async () => {
      patch({ muted: false, paused: false });

      const active = stage.active();
      if (!hasSource(active)) {
        // Nothing is loaded yet; the first video will start unmuted.
        logger.debug('sound requested before a video was loaded');
        return;
      }

      active.muted = false;
      active.volume = 1;

      const played = await attemptAsync(() => active.play());
      if (!played.ok) {
        logger.error('could not start playback with sound', played.error);
        patch({ paused: true });
        return;
      }

      logger.info('playback resumed with sound');
      scheduleNextCrossfade();
    },

    cleanup,
  };
};
