import { createExclusiveTask, createSerialTask, createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import type { AppConfig } from '../../shared/types/config';
import { attemptAsync, err, ok, type Result } from '../../shared/types/result';
import type { LeaderPublication, LeaderState } from '../../shared/types/protocol';
import type { DetailedStats, InitializationState, ServiceStatus } from '../../shared/types/status';
import type { PreprocessedVideo } from '../../shared/types/video';
import { prependBounded, removeWhere } from '../../shared/util/arrays';
import { isFiniteNumber, ratio } from '../../shared/util/numbers';
import type { MediaToolkit } from '../infra/ffmpeg';
import type { FileSystem } from '../infra/fileSystem';
import type { ServerLogging } from '../infra/logger';
import type { AppPaths } from '../infra/paths';
import type { SystemServices } from '../infra/system';
import { createArchiveFlagsStore } from './archiveFlags';
import type { ConfigService } from './configService';
import { createHistoryStore } from './historyStore';
import { createInitializationTracker, scaleProgress } from './initialization';
import { createPreprocessedQueue } from './preprocessedQueue';
import { createPreprocessor } from './preprocessor';
import { createQueuePersistence } from './queuePersistence';
import { createSessionStatsStore } from './sessionStats';
import { createVideoIndex, type ScanProgress } from './videoIndex';
import { createVideoPathGuard, type VideoPathGuard } from './videoPaths';

export interface SessionDeps {
  readonly fileSystem: FileSystem;
  readonly media: MediaToolkit;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logging: ServerLogging;
  readonly system: SystemServices;
  readonly configService: ConfigService;
}

/**
 * Everything the two transports do with the server, and nothing about how they
 * talk to a client. Electron and the web server differ only in how they carry
 * these calls; the legacy build expressed that difference by duplicating the
 * entire server around it.
 */
export interface Session {
  readonly config: () => AppConfig;
  /**
   * The gate every transport must put a client-supplied video record through.
   * It lives here because it is derived from the temp directory and the
   * configured libraries, which is knowledge the session already holds.
   */
  readonly videoPaths: VideoPathGuard;
  readonly status: () => ServiceStatus;
  readonly detailedStats: () => DetailedStats;
  readonly initialization: () => InitializationState;
  readonly onInitializationChange: (listener: (state: InitializationState) => void) => () => void;
  readonly takeNextVideo: () => PreprocessedVideo | null;
  readonly takePreviousVideo: () => PreprocessedVideo | null;
  readonly ensurePlayable: (video: PreprocessedVideo) => Promise<PreprocessedVideo | null>;
  readonly recordVideoEnded: (video: PreprocessedVideo) => void;
  readonly recordVideoError: (message: string) => void;
  readonly recordManualSkip: (video: PreprocessedVideo | null) => void;
  readonly recordReturnToPrevious: (video: PreprocessedVideo | null) => void;
  readonly syncPlaybackQueue: (videos: readonly PreprocessedVideo[]) => void;
  /** Flags or unflags a video for archiving; resolves to its new state. */
  readonly toggleArchiveFlag: (video: PreprocessedVideo) => Promise<boolean>;

  /** Records what the leading screen is playing, stamped with this server's clock. */
  readonly publishLeaderState: (state: LeaderPublication) => void;
  readonly leaderState: () => LeaderState | null;
  readonly onLeaderStateChange: (listener: (state: LeaderState) => void) => () => void;
  /**
   * A fresh location for a video a follower was told about, or null when its
   * transcode is gone. Never transcodes - a follower asking repeatedly must not
   * be able to put the server to work.
   */
  readonly locatePlayable: (video: PreprocessedVideo) => Promise<PreprocessedVideo | null>;
  readonly start: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/**
 * Where each startup phase sits on the 0..1 bar. The numbers are the legacy
 * percentages divided by 100, so the loading screen fills at the same pace it
 * always did.
 */
const CONFIG_PROGRESS = 0.05;
const INDEX_PROGRESS = 0.25;
const SCAN_PROGRESS_BASE = 0.3;
const SCAN_PROGRESS_SPAN = 0.3;
const INDEX_LOADED_PROGRESS = 0.6;
const RESTORE_PROGRESS = 0.65;
const PREPROCESS_PROGRESS_BASE = 0.7;
const PREPROCESS_PROGRESS_SPAN = 0.25;
const RETRY_PROGRESS = 0.2;

/** Enough to start playing; the top-up timer fills the rest in the background. */
const MINIMUM_STARTUP_VIDEOS = 1;

/**
 * How far the indexed count may move on a re-scan before the queue is thrown
 * away. A handful of added or removed files is normal churn, but a large jump
 * means a directory appeared or vanished and the queue no longer represents
 * what the user is asking to watch.
 */
const INDEX_CHANGE_THRESHOLD = 5;

/**
 * How long a leader's last publication is still believed.
 *
 * A leader reports once a second, so anything older than this means the screen
 * that was leading has gone: a closed tab, a TV switched off, a laptop asleep.
 * Nothing tells the server that happened - a follower polls the same value
 * regardless - so without a lifetime the state simply stands, and a follower
 * goes on extrapolating from it: `leaderPositionAt` adds the elapsed time to a
 * position recorded ten minutes ago, decides it is 600 seconds behind, and seeks
 * to the end of the video four times a second, indefinitely.
 *
 * Ten intervals, rather than two or three, because it is only reached when the
 * leader has genuinely stopped: a slow network costs a follower nothing here,
 * since the position is extrapolated between publications anyway.
 */
const LEADER_STATE_LIFETIME_MS = 10000;

/**
 * How many videos beyond its own queue a client can be holding: the one on
 * screen and the one it is about to fade into. Added to `playbackQueueSize` to
 * bound the set of handed-out videos the temp sweep must spare.
 */
const HANDED_OUT_MARGIN = 2;

/**
 * How long an initialization attempt waits for a fill another timer is already
 * running, expressed as polls rather than a deadline so an injected clock
 * cannot leave the loop spinning. `queue.fill` is exclusive, so an attempt that
 * lands on the same tick as the queue monitor has its own fill skipped, and
 * reading the still-empty queue straight afterwards condemns a recovery that
 * was about to succeed.
 */
const RUNNING_FILL_POLL_INTERVAL = 500;
const RUNNING_FILL_POLL_LIMIT = 240;

type TimerHandle = ReturnType<typeof setInterval>;

/**
 * A failed attempt. `retryable` separates "try again in a moment" from a state
 * only the user can resolve, which is the distinction the legacy retry loop
 * lacked: it kept re-scanning an empty directory list three times over.
 */
interface InitializationFailure {
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export const createSession = (deps: SessionDeps): Session => {
  const { fileSystem, media, paths, clock, logging, system, configService } = deps;
  const logger = logging.logger.child('session');
  const config = (): AppConfig => configService.current();

  const stats = createSessionStatsStore();
  const initialization = createInitializationTracker();
  const videoPaths = createVideoPathGuard({ tempDirectory: paths.tempDirectory, config });

  const videoIndex = createVideoIndex({
    fileSystem,
    paths,
    clock,
    logger: logging.logger.child('videoIndex'),
    random: system.random,
    digest: system.digest,
    config,
    videoPaths,
  });

  const preprocessor = createPreprocessor({
    fileSystem,
    media,
    paths,
    clock,
    logger: logging.logger.child('preprocessor'),
    newVideoId: system.newVideoId,
    delay: system.delay,
    config,
  });

  const queue = createPreprocessedQueue({
    fileSystem,
    preprocessor,
    videoIndex,
    logger: logging.logger.child('queue'),
    config,
    videoPaths,
    onStatsChange: (change) => {
      if (change.preprocessed !== undefined) {
        stats.increment('preprocessedVideos', change.preprocessed);
      }
      if (change.errors !== undefined) {
        stats.increment('preprocessingErrors', change.errors);
      }
    },
  });

  const history = createHistoryStore({
    fileSystem,
    paths,
    clock,
    logger: logging.logger.child('history'),
    config,
    videoPaths,
  });

  const archiveFlags = createArchiveFlagsStore({
    fileSystem,
    paths,
    clock,
    logger: logging.logger.child('archive'),
    videoPaths,
  });

  const persistence = createQueuePersistence({
    fileSystem,
    paths,
    clock,
    logger: logging.logger.child('persistence'),
    config,
    digest: system.digest,
    videoPaths,
  });

  /**
   * The client's own queue, mirrored here by `syncPlaybackQueue`. Those videos
   * are already spoken for, so they belong in the saved state and must survive
   * a temp sweep. The legacy Electron server obtained them by evaluating a
   * script inside the renderer, and the web server simply had no way to.
   */
  const mirroredQueue = createStore<readonly PreprocessedVideo[]>([]);

  /**
   * Videos already handed to a client. `takeNext` removes one from the server
   * queue at once, the client's mirror only arrives on the next sync tick, and
   * history only hears about it when it ends, so for that whole window nothing
   * else names its transcode and the temp sweep would delete the file being
   * watched. Kept bounded, because a client that never mirrors must not turn
   * this into a set that grows for as long as the session runs.
   */
  const handedOut = createStore<readonly PreprocessedVideo[]>([]);
  /**
   * What the leading screen last reported, if there is one.
   *
   * Held here rather than per-connection because there is exactly one leader by
   * definition, and because the Electron host has no connections at all - it
   * forwards the same value over IPC.
   */
  const leaderState = createStore<LeaderState | null>(null);
  const timers = createStore<readonly TimerHandle[]>([]);
  /**
   * How many videos the last scan that read *everything* found.
   *
   * `videoIndex.count()` is not that number: a scan that could not read a
   * directory still replaces the in-memory index, because playing the videos we
   * did find beats playing none of them. Comparing the next scan against that
   * partial count is how a share that blinked for a single tick came back and
   * cleared the queue on the tick after - `refreshIndex` declines to act on the
   * incomplete scan itself and then acts on the rebound instead. Null until a
   * complete scan has happened, which is "no basis for comparison yet".
   */
  const lastCompleteIndexCount = createStore<number | null>(null);
  const recoveryScheduled = createStore(false);
  const unwatchConfig = createStore<(() => void) | null>(null);

  /** Serialises initialization: the recovery timer and the config watcher both drive it. */
  const initializing = createExclusiveTask();
  /**
   * Serialises the state files. The periodic save and the shutdown save write
   * the same two files, and an overlapping pair could leave the newer queue on
   * disk beside the older history.
   */
  const saving = createSerialTask();

  const addTimer = (handle: TimerHandle): void => {
    timers.update((previous) => [...previous, handle]);
  };

  const clearTimers = (): void => {
    for (const handle of timers.get()) {
      clearInterval(handle);
    }
    timers.set([]);
  };

  /** Returns false when a directory could not be read, so the count is partial. */
  const rebuildIndex = async (
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<boolean> => {
    const outcome = await videoIndex.rebuild(onProgress);
    stats.setIndexed(videoIndex.count(), outcome.snapshot.builtAt);
    if (outcome.complete) lastCompleteIndexCount.set(videoIndex.count());
    return outcome.complete;
  };

  const rememberHandedOut = (video: PreprocessedVideo): void => {
    // The whole client queue plus what it can be showing: that is the most a
    // client can be holding that no mirror has reported yet.
    const limit = config().video.playbackQueueSize + HANDED_OUT_MARGIN;
    handedOut.update((previous) =>
      prependBounded(
        removeWhere(previous, (entry) => entry.processedPath === video.processedPath),
        video,
        limit,
      ),
    );
  };

  /** Every transcode a client or the queue still expects to be able to play. */
  const protectedPaths = (): ReadonlySet<string> => {
    const referenced = new Set<string>();
    for (const video of mirroredQueue.get()) referenced.add(video.processedPath);
    for (const video of handedOut.get()) referenced.add(video.processedPath);
    for (const video of queue.snapshot()) referenced.add(video.processedPath);
    for (const video of history.recent()) referenced.add(video.processedPath);
    return referenced;
  };

  const cleanupTempDirectory = async (): Promise<void> => {
    await persistence.cleanupTempDirectory(protectedPaths());
  };

  const persistState = (): Promise<void> =>
    saving.run(async () => {
      // There is nothing worth writing until the session has actually come up.
      // A quit - or a periodic tick - during a long first scan would otherwise
      // replace a perfectly good saved queue with the empty one this process
      // has not filled yet, and the next start would re-transcode a library it
      // had already prepared.
      if (initialization.get().stage !== 'ready') {
        logger.debug('skipping the state save: the session is not ready');
        return;
      }

      await persistence.save({
        // The client's queue first: those videos are nearest to being played, so
        // a restart that can only restore part of the state restores that part.
        queued: [...mirroredQueue.get(), ...queue.snapshot()],
        recentHistory: history.recent(),
      });
      await history.save();
    });

  const fillInBackground = (): void => {
    void queue.fill().catch((thrown: unknown) => {
      logger.error('background queue fill failed', thrown);
    });
  };

  /**
   * Gives a fill that is already running the chance to produce the one video
   * startup needs. Returns as soon as the queue is no longer empty, or as soon
   * as no fill is running, so a genuinely failed fill is still reported at once.
   */
  const waitForRunningFill = async (): Promise<void> => {
    for (let poll = 0; poll < RUNNING_FILL_POLL_LIMIT; poll += 1) {
      if (queue.size() >= MINIMUM_STARTUP_VIDEOS || !queue.isFilling()) return;
      if (poll === 0) logger.info('a queue fill is already running, waiting for it');
      await system.delay(RUNNING_FILL_POLL_INTERVAL);
    }
    logger.warn('gave up waiting for the running queue fill');
  };

  const attemptInitialization = async (): Promise<Result<void, InitializationFailure>> => {
    initialization.set('loading-config', CONFIG_PROGRESS, 'Loading configuration');

    // ffmpeg writes straight into the temp directory, so it has to exist before
    // the first transcode rather than after the first failure.
    const temp = await fileSystem.ensureDirectory(paths.tempDirectory);
    if (!temp.ok) {
      return err({
        message: `Cannot create the temp directory ${paths.tempDirectory}`,
        retryable: true,
        cause: temp.error,
      });
    }

    initialization.set('building-index', INDEX_PROGRESS, 'Building the video index');
    const loaded = await videoIndex.load();
    // True unless a scan ran and could not read everything it was asked to.
    let scanComplete = true;
    if (!loaded || videoIndex.needsRebuild()) {
      scanComplete = await rebuildIndex((progress) => {
        initialization.set(
          'building-index',
          scaleProgress(SCAN_PROGRESS_BASE, SCAN_PROGRESS_SPAN, progress.progress),
          progress.message,
        );
      });
    } else {
      // The cache records when it was built, so the debug overlay reports the
      // real age of the index instead of the moment this process started. It is
      // only ever written by a complete scan, so it is a fair basis for the
      // comparison `refreshIndex` makes.
      stats.setIndexed(videoIndex.count(), videoIndex.snapshot().builtAt);
      lastCompleteIndexCount.set(videoIndex.count());
      initialization.set(
        'building-index',
        INDEX_LOADED_PROGRESS,
        `Loaded an index of ${videoIndex.count()} videos`,
      );
    }

    if (videoIndex.count() === 0) {
      // A scan that could not read a directory found nothing *yet*. That is the
      // machine starting before its network share has mounted, and it is exactly
      // what the retry loop is for - so it must not be reported as the terminal
      // "your configuration is wrong" failure, which waits for the periodic
      // re-index instead and leaves the viewer on an error screen for a quarter
      // of an hour.
      if (!scanComplete) {
        return err({
          message:
            'No videos found yet; some directories could not be read. Check that ' +
            `${paths.configFile} points at drives that are available.`,
          retryable: true,
        });
      }

      // Retrying cannot conjure up videos: either the directories are wrong or
      // they are empty, and both are answered by editing the config file.
      return err({
        message: `No videos found. Check the directories listed in ${paths.configFile}`,
        retryable: false,
      });
    }

    initialization.set('restoring-queue', RESTORE_PROGRESS, 'Restoring the saved queue');
    await history.load();
    await archiveFlags.load();
    const saved = await persistence.load();
    if (saved !== null) {
      queue.restore(saved.queued);
      history.restoreRecent(saved.recentHistory);
    }
    // After the restore, not before it: the protected set is only meaningful
    // once the queue that references those temp files is back.
    await cleanupTempDirectory();

    if (queue.size() < MINIMUM_STARTUP_VIDEOS) {
      initialization.set('preprocessing', PREPROCESS_PROGRESS_BASE, 'Preprocessing videos');
      await queue.fill(MINIMUM_STARTUP_VIDEOS, (progress) => {
        initialization.set(
          'preprocessing',
          scaleProgress(
            PREPROCESS_PROGRESS_BASE,
            PREPROCESS_PROGRESS_SPAN,
            ratio(progress.current, progress.target),
          ),
          `Preprocessing videos: ${progress.current}/${progress.target}`,
        );
      });
      // `fill` is exclusive, so the call above adds nothing when the top-up
      // timer is mid-fill. That is a skipped fill, not a failed one.
      await waitForRunningFill();
    }

    if (queue.size() < MINIMUM_STARTUP_VIDEOS) {
      return err({ message: 'Could not preprocess any videos', retryable: true });
    }

    initialization.ready(`Ready with ${queue.size()} videos prepared`);
    return ok(undefined);
  };

  /** Converts an unexpected throw into the same failure value as a clean one. */
  const runAttempt = async (): Promise<Result<void, InitializationFailure>> => {
    const outcome = await attemptAsync(attemptInitialization);
    if (outcome.ok) return outcome.value;
    return err({ message: 'Initialization failed', retryable: true, cause: outcome.error });
  };

  const refreshIndex = async (): Promise<void> => {
    const before = lastCompleteIndexCount.get();
    const complete = await rebuildIndex();
    const after = videoIndex.count();

    // A session that failed for want of videos is not retried by anything else:
    // the periodic re-index is the only thing that ever notices a share that has
    // finally mounted, so it has to be what re-drives startup too.
    if (initialization.get().stage === 'error' && after > 0) {
      await reinitialize('recovery after the index found videos');
      return;
    }

    // A drive that was briefly unavailable reads as "every video is gone", and
    // answering that by deleting the queue throws away hours of transcoding to
    // match a count that was never true.
    if (!complete) {
      logger.warn(`the scan was incomplete (${after} videos found); keeping the queue`);
      return;
    }

    // Nothing complete has been scanned yet this session, so there is no honest
    // "before" to compare against and nothing to conclude from the difference.
    if (before === null) return;
    if (Math.abs(after - before) <= INDEX_CHANGE_THRESHOLD) return;

    logger.info(`indexed videos went from ${before} to ${after}, clearing the queue`);
    await queue.clear();
    await persistence.clear();
  };

  const topUpQueue = async (): Promise<void> => {
    await queue.removeMissingFiles();
    // Nothing to draw from, and `fill` would only log that on every tick.
    if (videoIndex.count() === 0) return;
    await queue.fill();
  };

  /**
   * One timer per background job, and one job per timer. The legacy queue ran
   * two overlapping refill intervals, a 30 second one and a 5 second one, which
   * meant the "critical" timer could start a fill the slower one was already
   * running.
   */
  const startTimers = (): void => {
    const { timeouts, video } = config();

    addTimer(
      setInterval(() => {
        void refreshIndex();
      }, video.updateInterval),
    );
    addTimer(
      setInterval(() => {
        void cleanupTempDirectory();
      }, timeouts.periodicCleanupInterval),
    );
    addTimer(
      setInterval(() => {
        void persistState();
      }, timeouts.periodicSaveInterval),
    );
    addTimer(
      setInterval(() => {
        void topUpQueue();
      }, timeouts.queueMonitorInterval),
    );

    logger.info('background timers started');
  };

  /**
   * Drives initialization again from a background trigger and reports how it
   * went. Exclusive, because the recovery timer and the config watcher can each
   * decide to re-drive startup and two of them at once would fight over the
   * same queue and the same progress bar.
   */
  const reinitialize = async (reason: string): Promise<void> => {
    const outcome = await initializing.runExclusive(runAttempt);
    if (outcome === null) {
      logger.info(`${reason} skipped: initialization is already running`);
      return;
    }
    if (outcome.ok) {
      logger.info(`${reason} succeeded`);
      return;
    }
    logger.error(`${reason} failed: ${outcome.error.message}`, outcome.error.cause);
    initialization.fail(outcome.error.message, outcome.error.cause);
  };

  /**
   * What a config change did, so the caller can report it after the lock is
   * released. `runExclusive` answers `null` for "skipped", so the work itself
   * must never return `null` or the two would be indistinguishable.
   */
  type ConfigChangeOutcome =
    | { readonly kind: 'rebuilt' }
    | { readonly kind: 'recovered'; readonly result: Result<void, InitializationFailure> };

  const handleConfigChange = async (): Promise<void> => {
    // `needsRebuild` compares the index against exactly the settings that
    // decide what it contains, so editing a timeout or a colour does not cost
    // the user a full re-scan.
    if (!videoIndex.needsRebuild()) {
      logger.debug('configuration changed, but the video index is unaffected');
      return;
    }

    logger.info('index-relevant configuration changed, rebuilding the video index');

    // Under the same lock as startup and background recovery. The watcher goes
    // live before the first initialization finishes, so a config saved during a
    // long first scan used to clear the queue that scan was in the middle of
    // filling and rebuild the index underneath it - two writers on the same
    // state, with the loser's work silently discarded.
    const outcome = await initializing.runExclusive(async (): Promise<ConfigChangeOutcome> => {
      // The derived queues go before the file that records them, as in
      // `refreshIndex`: dropping only the file leaves the periodic save free to
      // write the stale queue straight back out under the new fingerprint.
      mirroredQueue.set([]);
      await queue.clear();
      await persistence.clear();
      await rebuildIndex();

      // A fresh install ships no directories, so the first initialization ends
      // in the terminal error state. Pointing config.json at real videos is the
      // fix for exactly that, and it must not also require a restart. Driven
      // directly rather than through `reinitialize`, which would try to take
      // the lock this already holds and skip itself.
      if (initialization.get().stage === 'error' && videoIndex.count() > 0) {
        return { kind: 'recovered', result: await runAttempt() };
      }
      return { kind: 'rebuilt' };
    });

    if (outcome === null) {
      // The initialization that is running reads `config()` per call, so it is
      // already working from the new settings; the periodic re-index picks the
      // stale fingerprint up within one `video.updateInterval`.
      logger.info('configuration change deferred: initialization is already running');
      return;
    }

    if (outcome.kind === 'rebuilt') return;
    if (outcome.result.ok) {
      logger.info('recovery after a configuration change succeeded');
      return;
    }
    const failure = outcome.result.error;
    logger.error(`recovery after a configuration change failed: ${failure.message}`, failure.cause);
    initialization.fail(failure.message, failure.cause);
  };

  /**
   * A single late attempt, for the case where a network share was merely not
   * mounted yet. The legacy Electron server re-entered its whole retry loop
   * here, so a genuinely broken configuration retried forever, and each pass
   * installed another full set of background intervals.
   */
  const scheduleBackgroundRecovery = (): void => {
    if (recoveryScheduled.get()) return;
    recoveryScheduled.set(true);

    const delay = config().timeouts.backgroundRecoveryDelay;
    logger.info(`scheduling one background recovery attempt in ${delay}ms`);
    addTimer(
      setTimeout(() => {
        void reinitialize('background recovery');
      }, delay),
    );
  };

  const runStartupAttempts = async (): Promise<void> => {
    const maxAttempts = Math.max(1, config().retries.maxInitializationAttempts);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await runAttempt();

      if (outcome.ok) {
        logger.info(`session ready after ${attempt} attempt(s)`);
        break;
      }

      const failure = outcome.error;
      logger.error(`initialization attempt ${attempt} failed: ${failure.message}`, failure.cause);

      if (!failure.retryable) {
        initialization.fail(failure.message, failure.cause);
        break;
      }

      if (attempt < maxAttempts) {
        initialization.set(
          'retrying',
          RETRY_PROGRESS,
          `Retrying initialization, attempt ${attempt + 1} of ${maxAttempts}`,
        );
        await system.delay(config().timeouts.initializationRetryDelay);
        continue;
      }

      initialization.fail(failure.message, failure.cause);
      scheduleBackgroundRecovery();
    }
  };

  const start = async (): Promise<void> => {
    logger.info('starting session');
    unwatchConfig.set(
      configService.watch(async () => {
        await handleConfigChange();
      }),
    );

    // The watcher is live from here on, so startup takes the same lock as the
    // background re-drives rather than racing a config change through them.
    await initializing.runExclusive(runStartupAttempts);

    // Started even after a failure: the periodic re-index and the config
    // watcher are how a session that began with no videos ever finds any.
    startTimers();
  };

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down session');

    // Timers first, so nothing writes the state files behind the final save.
    clearTimers();
    unwatchConfig.get()?.();
    unwatchConfig.set(null);

    // Then the children. Both hosts end in an immediate `exit`, which does not
    // reap a running ffmpeg, so a quit during a fill used to leave one behind
    // burning CPU on a transcode nothing would ever collect.
    media.shutdown();

    // Deliberately no queue.clear(): the state just saved points at those temp
    // files, and the legacy Electron path deleted them on quit and so threw
    // away every transcode it had just promised to restore.
    await persistState();
    logger.info('session state saved');
  };

  const timeUntilNextIndexUpdate = (): number | null => {
    const lastUpdate = stats.get().lastIndexUpdate;
    if (lastUpdate === null) return null;

    const dueAt = new Date(lastUpdate).getTime() + config().video.updateInterval;
    if (!isFiniteNumber(dueAt)) return null;
    return Math.max(0, dueAt - clock.now());
  };

  /** The last publication, or null once it has aged past its lifetime. */
  const currentLeaderState = (): LeaderState | null => {
    const state = leaderState.get();
    if (state === null) return null;
    return clock.now() - state.anchorMs > LEADER_STATE_LIFETIME_MS ? null : state;
  };

  const takeNextVideo = (): PreprocessedVideo | null => {
    const video = queue.takeNext();
    if (video === null) return null;

    rememberHandedOut(video);
    stats.increment('videosPlayed');
    if (queue.size() < config().video.preprocessedQueueSize) {
      fillInBackground();
    }
    return video;
  };

  /** Stepping back also removes the video from history, so it needs the same cover. */
  const takePreviousVideo = (): PreprocessedVideo | null => {
    const video = history.takePrevious();
    if (video === null) return null;

    rememberHandedOut(video);
    return video;
  };

  return {
    config,
    videoPaths,

    status: () => ({
      initialization: initialization.get(),
      preprocessedQueue: {
        current: queue.size(),
        target: config().video.preprocessedQueueSize,
      },
      isPreprocessing: queue.isFilling(),
      totalVideos: stats.get().totalVideosIndexed,
    }),

    detailedStats: () => {
      const video = config().video;
      return {
        preprocessedQueue: { current: queue.size(), target: video.preprocessedQueueSize },
        playbackQueueTarget: video.playbackQueueSize,
        playbackQueueInitializationThreshold: video.playbackQueueInitializationThreshold,
        history: history.gauges(),
        indexUpdateInterval: video.updateInterval,
        lastIndexUpdate: stats.get().lastIndexUpdate,
        timeUntilNextUpdate: timeUntilNextIndexUpdate(),
        isPreprocessing: queue.isFilling(),
        session: stats.get(),
      };
    },

    initialization: () => initialization.get(),
    onInitializationChange: (listener) => initialization.subscribe(listener),

    takeNextVideo,
    takePreviousVideo,
    ensurePlayable: (video) => queue.ensurePlayable(video),

    recordVideoEnded: (video) => {
      history.recordPlayed(video);
    },

    recordVideoError: (message) => {
      // A failed video is skipped, not fatal, so this is a warning however
      // loudly the client shouted about it.
      logger.warn(`client reported a playback error: ${message}`);
      stats.increment('videosSkippedByError');
    },

    /**
     * The outgoing video is recorded here rather than by a separate call from
     * the client, which is what the legacy `addToHistory` request was for: two
     * round trips that had to arrive in order to leave history consistent.
     */
    recordManualSkip: (video) => {
      if (video !== null) history.recordPlayed(video);
      stats.increment('videosSkippedManually');
    },

    recordReturnToPrevious: (video) => {
      if (video !== null) history.recordPlayed(video);
      stats.increment('videosReturnedToPrevious');
    },

    syncPlaybackQueue: (videos) => {
      mirroredQueue.set([...videos]);
      logger.debug(`client mirrored ${videos.length} queued videos`);
    },

    toggleArchiveFlag: (video) => archiveFlags.toggle(video),

    publishLeaderState: (published) => {
      // Stamped with the server's clock, never the leader's. That single
      // rewrite is what lets a follower whose own clock is hours out still
      // converge: every screen measures against the one clock they share.
      leaderState.set({
        ...published,
        sequence: (leaderState.get()?.sequence ?? 0) + 1,
        anchorMs: clock.now(),
      });
    },

    leaderState: () => currentLeaderState(),
    onLeaderStateChange: (listener) =>
      leaderState.subscribe((state) => {
        if (state !== null) listener(state);
      }),

    locatePlayable: async (video) =>
      (await fileSystem.exists(video.processedPath)) ? video : null,

    start,
    shutdown,
  };
};
