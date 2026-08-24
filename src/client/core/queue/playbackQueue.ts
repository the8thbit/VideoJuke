import { createExclusiveTask, createStore } from '../../../shared/state/store';
import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type { PlayerApi } from '../../../shared/types/protocol';
import { attemptAsync } from '../../../shared/types/result';
import type { PlayableVideo, PreprocessedVideo, QueuedVideo } from '../../../shared/types/video';
import { toCrossfadeSettings, withCrossfadeTiming } from '../../../shared/video/crossfadeTiming';
import { resolveVideoUrl } from '../../../shared/video/videoLocation';

/** How far a fill has got, in the units the loading screen displays. */
export interface QueueProgress {
  readonly current: number;
  readonly target: number;
}

export interface PlaybackQueueDeps {
  readonly api: Pick<PlayerApi, 'takeNextVideo' | 'recordVideoError'>;
  readonly config: ClientConfig;
  readonly logger: Logger;
  /** The page's own origin, or null in Electron where files are read directly. */
  readonly origin: string | null;
  readonly document: Document;
}

export interface PlaybackQueue {
  /** Fills to the initialization threshold; false when nothing is playable. */
  readonly buildInitial: (onProgress?: (progress: QueueProgress) => void) => Promise<boolean>;
  readonly fill: (target?: number) => Promise<void>;
  readonly takeNext: () => QueuedVideo | null;
  /** Returns false when the video is already queued. */
  readonly pushFront: (video: QueuedVideo) => boolean;
  readonly size: () => number;
  /** The queue as the server stores it, for resuming after a restart. */
  readonly snapshot: () => readonly PreprocessedVideo[];
  /** Arms the periodic top-up and returns the function that stops it. */
  readonly startMonitoring: () => () => void;
  readonly cleanup: () => void;
}

/** Empty answers in a row that mean the server has nothing left to give. */
const MAX_CONSECUTIVE_EMPTY = 3;

/**
 * Unplayable videos in a row that mean the fill is wasting its time. The legacy
 * loop had no such limit: a temp directory of broken files spun it forever.
 */
const MAX_CONSECUTIVE_UNPLAYABLE = 3;

/** Build attempts that may add nothing at all before the queue gives up. */
const MAX_BARREN_ATTEMPTS = 2;

/** How far over capacity the queue may run before the tail is trimmed. */
const OVER_CAPACITY_FRACTION = 0.2;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), milliseconds);
  });

const containsPath = (videos: readonly QueuedVideo[], path: string): boolean => {
  for (let index = 0; index < videos.length; index += 1) {
    const entry = videos[index];
    if (entry !== undefined && entry.video.originalPath === path) return true;
  }
  return false;
};

/**
 * The client's own queue of videos to play, kept ahead of the player.
 *
 * The legacy version reached for `window.electronAPI` directly, built video
 * URLs itself, and published its contents by assigning a function to `window`
 * for the main process to evaluate. It talks to the injected `PlayerApi` now,
 * and the contents are handed over by {@link PlaybackQueue.snapshot}.
 */
export const createPlaybackQueue = (deps: PlaybackQueueDeps): PlaybackQueue => {
  const { api, config, logger, origin } = deps;
  const root = deps.document;

  const state = createStore<readonly QueuedVideo[]>([]);
  // Fills come from four directions (startup, a dequeue, the monitor, the
  // shell); only one may be talking to the server at a time.
  const fillTask = createExclusiveTask();
  const crossfadeSettings = toCrossfadeSettings(config);
  const capacity = config.video.playbackQueueSize;

  let probeElement: HTMLVideoElement | null = null;
  let pendingFill: ReturnType<typeof setTimeout> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const size = (): number => state.get().length;

  /**
   * One hidden element for every probe. Creating one per video left a decoder
   * alive for each of them, which the TV runs out of long before the queue is
   * full.
   */
  const ensureProbeElement = (): HTMLVideoElement | null => {
    if (disposed) return null;
    if (probeElement !== null) return probeElement;

    const element = root.createElement('video');
    element.style.display = 'none';
    element.muted = true;
    element.volume = 0;
    element.preload = 'auto';
    root.body.appendChild(element);

    probeElement = element;
    return element;
  };

  /**
   * Whether the browser can actually decode this file. `canplay` is the verdict:
   * the muted playback attempt only exists to make the browser fetch enough of
   * the file to answer, and a refused autoplay says nothing about the video.
   */
  const probe = (video: PlayableVideo): Promise<boolean> =>
    new Promise((resolve) => {
      const element = ensureProbeElement();
      if (element === null) {
        resolve(false);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const onCanPlay = (): void => {
        finish(true);
      };
      const onError = (): void => {
        finish(false);
      };

      const finish = (playable: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        element.removeEventListener('canplay', onCanPlay);
        element.removeEventListener('error', onError);
        element.pause();
        // Dropping the attribute rather than assigning an empty string is what
        // actually releases the temp file; `src = ''` resolves against the page
        // URL and leaves the element loading something.
        element.removeAttribute('src');
        element.load();
        resolve(playable);
      };

      element.addEventListener('canplay', onCanPlay);
      element.addEventListener('error', onError);

      element.src = resolveVideoUrl(video.location, origin);
      element.muted = true;
      element.volume = 0;

      void attemptAsync(() => element.play());

      timer = setTimeout(() => {
        finish(false);
      }, config.timeouts.videoTestTimeout);
    });

  const fillTo = async (
    target: number,
    onProgress: ((progress: QueueProgress) => void) | null,
  ): Promise<void> => {
    let consecutiveEmpty = 0;
    let consecutiveUnplayable = 0;

    while (size() < target) {
      if (disposed) return;
      if (onProgress !== null) onProgress({ current: size(), target });

      const taken = await attemptAsync(() => api.takeNextVideo());
      if (!taken.ok) {
        logger.warn(`could not take a video from the server - ${taken.error.message}`);
        return;
      }

      const video = taken.value;
      if (video === null) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          logger.debug(`the server had nothing to give after ${consecutiveEmpty} requests`);
          break;
        }
        // The server is probably still transcoding; asking again at once only
        // burns requests.
        await delay(config.timeouts.errorRecoveryDelay);
        continue;
      }
      consecutiveEmpty = 0;

      if (!(await probe(video))) {
        consecutiveUnplayable += 1;
        logger.debug(`dropping unplayable video: ${video.filename}`);
        await attemptAsync(() => api.recordVideoError(`unplayable video: ${video.filename}`));
        if (consecutiveUnplayable >= MAX_CONSECUTIVE_UNPLAYABLE) {
          logger.warn(`stopped filling after ${consecutiveUnplayable} unplayable videos in a row`);
          break;
        }
        continue;
      }
      consecutiveUnplayable = 0;

      // Timing is normally computed while transcoding; this fills it in for
      // entries that were cached before the server started doing so.
      const queued: QueuedVideo = {
        video: withCrossfadeTiming(video, crossfadeSettings),
        origin: 'queue',
      };
      state.update((previous) => previous.concat([queued]));
      logger.debug(`queued ${video.filename} (${size()}/${target})`);
    }

    if (onProgress !== null) onProgress({ current: size(), target });
  };

  const fill = async (target?: number): Promise<void> => {
    await fillTask.runExclusive(() => fillTo(target ?? capacity, null));
  };

  const scheduleFill = (delayMs: number): void => {
    if (disposed || pendingFill !== null) return;
    pendingFill = setTimeout(() => {
      pendingFill = null;
      void fill();
    }, delayMs);
  };

  const stopMonitoring = (): void => {
    if (monitorTimer === null) return;
    clearInterval(monitorTimer);
    monitorTimer = null;
  };

  return {
    buildInitial: async (onProgress) => {
      const threshold = config.video.playbackQueueInitializationThreshold;
      const maxAttempts = Math.max(1, config.retries.maxQueueBuildAttempts);
      const report = onProgress ?? null;

      logger.info(`building the playback queue (target ${threshold})`);

      let barren = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const before = size();
        await fillTask.runExclusive(() => fillTo(threshold, report));
        const after = size();

        if (after >= threshold) break;

        // Two fruitless attempts in a row mean there is nothing to wait for,
        // rather than a server that is still warming up.
        barren = after === before ? barren + 1 : 0;
        if (barren >= MAX_BARREN_ATTEMPTS) {
          logger.warn(`no videos arrived in ${barren} attempts; starting with what there is`);
          break;
        }

        if (attempt < maxAttempts) {
          // Each retry waits longer, because the usual cause is a transcode
          // that has not finished yet.
          await delay(config.timeouts.backgroundFillRetryDelay * attempt);
        }
      }

      const ready = size();
      if (ready === 0) {
        logger.error('the playback queue is empty; there is nothing to play');
        return false;
      }

      logger.info(`playback queue ready with ${ready} video${ready === 1 ? '' : 's'}`);
      // The rest of the queue is built behind the first video.
      if (ready < capacity) scheduleFill(config.timeouts.backgroundFillDelay);
      return true;
    },

    fill,

    takeNext: () => {
      const current = state.get();
      const head = current[0];
      if (head === undefined) {
        logger.debug('the playback queue is empty');
        return null;
      }

      state.set(current.slice(1));
      const remaining = size();
      logger.debug(`dequeued ${head.video.filename} (${remaining} left)`);

      if (remaining < capacity) scheduleFill(config.timeouts.queueRefillDelay);
      return head;
    },

    pushFront: (video) => {
      const current = state.get();
      if (containsPath(current, video.video.originalPath)) {
        logger.debug(`${video.video.filename} is already queued`);
        return false;
      }

      // A little slack over capacity is fine; a queue that keeps growing every
      // time the viewer goes back is not.
      const maximum = capacity + Math.floor(capacity * OVER_CAPACITY_FRACTION);
      const next = [video, ...current];
      state.set(next.length > maximum ? next.slice(0, maximum) : next);
      logger.debug(`re-queued ${video.video.filename} (${size()} total)`);
      return true;
    },

    size,

    snapshot: () => state.get().map((entry) => entry.video),

    startMonitoring: () => {
      // A second call replaces the first interval rather than adding one.
      stopMonitoring();
      monitorTimer = setInterval(() => {
        const current = size();
        if (current >= capacity) return;
        logger.debug(`playback queue below target (${current}/${capacity})`);
        void fill();
      }, config.timeouts.queueMonitorInterval);
      return stopMonitoring;
    },

    cleanup: () => {
      if (disposed) return;
      disposed = true;

      stopMonitoring();
      if (pendingFill !== null) {
        clearTimeout(pendingFill);
        pendingFill = null;
      }

      if (probeElement !== null) {
        probeElement.pause();
        probeElement.removeAttribute('src');
        probeElement.load();
        if (probeElement.parentNode !== null) probeElement.parentNode.removeChild(probeElement);
        probeElement = null;
      }

      logger.debug('playback queue stopped');
    },
  };
};
