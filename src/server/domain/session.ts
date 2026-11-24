import { classifyConfigChange } from '../../shared/config/changeImpact';
import { createExclusiveTask, createSerialTask, createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import type { AppConfig } from '../../shared/types/config';
import { attemptAsync, err, ok, type Result } from '../../shared/types/result';
import type { LeaderPublication, LeaderState } from '../../shared/types/protocol';
import type { DetailedStats, PipelineState, ServiceStatus } from '../../shared/types/status';
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
import { createPipelineTracker, scaleProgress } from './pipeline';
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
  readonly pipeline: () => PipelineState;
  readonly onPipelineChange: (listener: (state: PipelineState) => void) => () => void;
  /** Starts indexing, or re-scans an index that already exists. Returns at once. */
  readonly startIndex: () => void;
  /** Starts preparing the queue; refused until the index is done. Returns at once. */
  readonly startQueue: () => void;
  /** Forgets the index and the queue built from it, on disk too. Returns at once. */
  readonly clearIndex: () => void;
  /** Forgets the queue and deletes its transcodes. Returns at once. */
  readonly clearQueue: () => void;
  /** Clears the queue and prepares a fresh one. Returns at once. */
  readonly requeue: () => void;
  /** This session's choice only; `startup.autoQueueAfterIndex` is the default. */
  readonly setAutoQueue: (enabled: boolean) => void;
  /** This session's choice only; `startup.autoPlayAfterQueue` is the default. */
  readonly setAutoPlay: (enabled: boolean) => void;
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
 * Where each part of the queue step sits on its 0..1 bar. Restoring is quick
 * and transcoding is not, so the transcodes get nearly all of it.
 */
const QUEUE_RESTORE_PROGRESS = 0.05;
const QUEUE_PREPROCESS_BASE = 0.1;
const QUEUE_PREPROCESS_SPAN = 0.9;

/**
 * Transcoded videos the queue step waits for before it calls itself done, and
 * the size of the fresh batch a settings change builds.
 *
 * This is the number the client used to wait for on its own before building a
 * playback queue: starting against a nearly empty server queue means the first
 * video plays and the second one is not there yet. The rest of
 * `preprocessedQueueSize` is filled in the background.
 */
const STARTUP_READY_VIDEOS = 3;

/** Below this the queue step has failed: there is nothing at all to play. */
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
 * How long the queue step waits for a fill another timer is already running,
 * expressed as polls rather than a deadline so an injected clock cannot leave
 * the loop spinning. `queue.fill` is exclusive, so a step that lands on the
 * same tick as the queue monitor has its own fill skipped, and reading the
 * still-empty queue straight afterwards condemns a step that was about to
 * succeed.
 */
const RUNNING_FILL_POLL_INTERVAL = 500;
const RUNNING_FILL_POLL_LIMIT = 240;

/** How often a waiting settings update checks whether the step ahead of it is done. */
const UPDATE_WAIT_INTERVAL = 1000;

type TimerHandle = ReturnType<typeof setInterval>;

/**
 * A failed attempt. `retryable` separates "try again in a moment" from a state
 * only the user can resolve, which is the distinction the legacy retry loop
 * lacked: it kept re-scanning an empty directory list three times over.
 */
interface PhaseFailure {
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

/** What a settings change still has to do; a reindex always requeues as well. */
type UpdateNeed = 'requeue' | 'reindex';

const describeUpdate = (need: UpdateNeed): string =>
  need === 'reindex'
    ? 'Settings changed: re-indexing and rebuilding the queue in the background'
    : 'Settings changed: rebuilding the queue in the background';

export const createSession = (deps: SessionDeps): Session => {
  const { fileSystem, media, paths, clock, logging, system, configService } = deps;
  const logger = logging.logger.child('session');
  const config = (): AppConfig => configService.current();

  const stats = createSessionStatsStore();
  const pipeline = createPipelineTracker();
  const videoPaths = createVideoPathGuard({ tempDirectory: paths.tempDirectory, config });

  const videoIndex = createVideoIndex({
    fileSystem,
    measureDuration: async (path) => {
      const probed = await media.probe(path, config().timeouts.probeTimeout);
      return probed.ok ? probed.value.duration : null;
    },
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
   * cleared the queue on the tick after - `rescanIndex` declines to act on the
   * incomplete scan itself and then acts on the rebound instead. Null until a
   * complete scan has happened, which is "no basis for comparison yet".
   */
  const lastCompleteIndexCount = createStore<number | null>(null);
  /** Whether an index step has ever finished with videos in this process. */
  const indexed = createStore(false);
  /**
   * Whether the saved queue and history have been read back in.
   *
   * Until they have, the in-memory queue is empty only because nobody has
   * asked for it yet, and saving it would replace a perfectly good saved queue
   * with nothing. It also guards the temp sweep: before the restore, nothing
   * names the transcodes that saved queue points at.
   */
  const queueRestored = createStore(false);
  const indexTimerStarted = createStore(false);
  const queueTimersStarted = createStore(false);
  const recoveryScheduled = createStore(false);
  const unwatchConfig = createStore<(() => void) | null>(null);
  /** The configuration the next change is compared against. */
  const lastConfig = createStore<AppConfig>(config());
  /** The settings update still owed, coalesced so a burst of saves runs once. */
  const pendingUpdate = createStore<UpdateNeed | null>(null);
  const updating = createStore(false);

  /**
   * Serialises the index step, the queue step, the periodic re-scan and
   * settings updates. Each can be asked for from a button, a timer or a file
   * change, and two of them at once would fight over the same index and queue.
   */
  const busy = createExclusiveTask();
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

  const reportIndexProgress = (progress: ScanProgress): void => {
    pipeline.running('index', progress.progress, progress.message);
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
    // Before the restore the protected set is missing the saved queue, and the
    // sweep would delete every transcode it is about to be restored with.
    if (!queueRestored.get()) return;
    await persistence.cleanupTempDirectory(protectedPaths());
  };

  const persistState = (): Promise<void> =>
    saving.run(async () => {
      // There is nothing worth writing until the saved state has been read back.
      // A quit - or a periodic tick - before anyone asked for the queue would
      // otherwise replace a perfectly good saved queue with the empty one this
      // process has not filled yet, and the next start would re-transcode a
      // library it had already prepared.
      if (!queueRestored.get()) {
        logger.debug('skipping the state save: the saved queue has not been restored');
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
   * Gives a fill that is already running the chance to produce what the queue
   * step needs. Returns as soon as the queue has that many, or as soon as no
   * fill is running, so a genuinely failed fill is still reported at once.
   */
  const waitForRunningFill = async (target: number): Promise<void> => {
    for (let poll = 0; poll < RUNNING_FILL_POLL_LIMIT; poll += 1) {
      if (queue.size() >= target || !queue.isFilling()) return;
      if (poll === 0) logger.info('a queue fill is already running, waiting for it');
      await system.delay(RUNNING_FILL_POLL_INTERVAL);
    }
    logger.warn('gave up waiting for the running queue fill');
  };

  /** The failure for an index that holds nothing, which depends on why. */
  const emptyIndexFailure = (scanComplete: boolean): PhaseFailure =>
    // A scan that could not read a directory found nothing *yet*. That is the
    // machine starting before its network share has mounted, and it is exactly
    // what the retry loop is for - so it must not be reported as the terminal
    // "your configuration is wrong" failure.
    scanComplete
      ? {
          // Retrying cannot conjure up videos: either the directories are wrong
          // or they are empty, and both are answered by changing the settings.
          message: `No videos found. Check the directories listed in ${paths.configFile}`,
          retryable: false,
        }
      : {
          message:
            'No videos found yet; some directories could not be read. Check that ' +
            `${paths.configFile} points at drives that are available.`,
          retryable: true,
        };

  /** Converts an unexpected throw into the same failure value as a clean one. */
  const guarded = async (
    attempt: () => Promise<Result<void, PhaseFailure>>,
    what: string,
  ): Promise<Result<void, PhaseFailure>> => {
    const outcome = await attemptAsync(attempt);
    if (outcome.ok) return outcome.value;
    return err({ message: `${what} failed`, retryable: true, cause: outcome.error });
  };

  const finishIndex = (scanComplete: boolean): void => {
    indexed.set(true);
    const count = videoIndex.count();
    pipeline.done(
      'index',
      scanComplete
        ? `Indexed ${count} videos`
        : `Indexed ${count} videos; some directories could not be read`,
    );
  };

  /**
   * The first index of this process: the cache when it still describes the
   * configuration, a full scan when it does not.
   */
  const attemptFirstIndex = async (): Promise<Result<void, PhaseFailure>> => {
    pipeline.running('index', 0, 'Loading the video index');
    const loaded = await videoIndex.load();
    // True unless a scan ran and could not read everything it was asked to.
    let scanComplete = true;
    if (!loaded || videoIndex.needsRebuild()) {
      scanComplete = await rebuildIndex(reportIndexProgress);
    } else {
      // The cache records when it was built, so the debug overlay reports the
      // real age of the index instead of the moment this process started. It is
      // only ever written by a complete scan, so it is a fair basis for the
      // comparison `rescanIndex` makes.
      stats.setIndexed(videoIndex.count(), videoIndex.snapshot().builtAt);
      lastCompleteIndexCount.set(videoIndex.count());
      // Switching the length bias on does not change what a scan finds, so a
      // cache from before it was on is still good - it only lacks lengths.
      if (videoIndex.needsMeasurement()) await videoIndex.measure(reportIndexProgress);
    }

    if (videoIndex.count() === 0) return err(emptyIndexFailure(scanComplete));
    return ok(undefined);
  };

  /**
   * A scan of an index that already exists, from the re-index button or the
   * periodic timer. Returns whether the scan was complete.
   */
  const rescanIndex = async (): Promise<boolean> => {
    const before = lastCompleteIndexCount.get();
    const complete = await rebuildIndex(reportIndexProgress);
    const after = videoIndex.count();

    // A drive that was briefly unavailable reads as "every video is gone", and
    // answering that by deleting the queue throws away hours of transcoding to
    // match a count that was never true.
    if (!complete) {
      logger.warn(`the scan was incomplete (${after} videos found); keeping the queue`);
      return false;
    }

    // Nothing complete has been scanned yet this session, so there is no honest
    // "before" to compare against and nothing to conclude from the difference.
    if (before === null) return true;
    if (Math.abs(after - before) <= INDEX_CHANGE_THRESHOLD) return true;

    logger.info(`indexed videos went from ${before} to ${after}, clearing the queue`);
    await queue.clear();
    await persistence.clear();
    if (pipeline.get().queue.status === 'done') fillInBackground();
    return true;
  };

  /**
   * One run of the index step, with retries. Returns whether it ended with
   * videos to play, which is what the auto-queue chains on.
   */
  const runIndexStep = async (): Promise<boolean> => {
    // An index that has already succeeded is re-scanned rather than reloaded:
    // whoever asked for it again wants the library read afresh.
    if (indexed.get()) {
      pipeline.running('index', 0, 'Re-scanning the video directories');
      const rescanned = await attemptAsync(rescanIndex);
      if (!rescanned.ok) {
        logger.error('re-indexing failed', rescanned.error);
        pipeline.fail('index', 'Re-indexing failed', rescanned.error);
        return false;
      }
      if (videoIndex.count() === 0) {
        pipeline.fail('index', emptyIndexFailure(rescanned.value).message);
        return false;
      }
      finishIndex(rescanned.value);
      return true;
    }

    const maxAttempts = Math.max(1, config().retries.maxInitializationAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await guarded(attemptFirstIndex, 'Indexing');
      if (outcome.ok) {
        logger.info(`indexed after ${attempt} attempt(s)`);
        finishIndex(true);
        return true;
      }

      const failure = outcome.error;
      logger.error(`index attempt ${attempt} failed: ${failure.message}`, failure.cause);
      if (!failure.retryable) {
        pipeline.fail('index', failure.message, failure.cause);
        return false;
      }
      if (attempt < maxAttempts) {
        pipeline.running('index', 0, `Retrying, attempt ${attempt + 1} of ${maxAttempts}`);
        await system.delay(config().timeouts.initializationRetryDelay);
        continue;
      }
      pipeline.fail('index', failure.message, failure.cause);
      scheduleBackgroundRecovery();
    }
    return false;
  };

  /** Brings the saved queue and history back, once per process. */
  const restoreSavedQueue = async (): Promise<void> => {
    if (queueRestored.get()) return;
    await history.load();
    await archiveFlags.load();
    const saved = await persistence.load();
    if (saved !== null) {
      queue.restore(saved.queued);
      history.restoreRecent(saved.recentHistory);
    }
    queueRestored.set(true);
    // After the restore, not before it: the protected set is only meaningful
    // once the queue that references those temp files is back.
    await cleanupTempDirectory();
    startQueueTimers();
  };

  /**
   * One run of the queue step: bring the saved state back once, then transcode
   * until there is enough to start on. Everything past that is filled in the
   * background by the top-up timer.
   */
  const attemptQueue = async (): Promise<Result<void, PhaseFailure>> => {
    // ffmpeg writes straight into the temp directory, so it has to exist before
    // the first transcode rather than after the first failure.
    pipeline.running('queue', 0, 'Preparing the temp directory');
    const temp = await fileSystem.ensureDirectory(paths.tempDirectory);
    if (!temp.ok) {
      return err({
        message: `Cannot create the temp directory ${paths.tempDirectory}`,
        retryable: true,
        cause: temp.error,
      });
    }

    if (!queueRestored.get()) {
      pipeline.running('queue', QUEUE_RESTORE_PROGRESS, 'Restoring the saved queue');
      await restoreSavedQueue();
    }

    const target = Math.min(STARTUP_READY_VIDEOS, config().video.preprocessedQueueSize);
    if (queue.size() < target) {
      pipeline.running('queue', QUEUE_PREPROCESS_BASE, 'Preprocessing videos');
      await queue.fill(target, (progress) => {
        pipeline.running(
          'queue',
          scaleProgress(
            QUEUE_PREPROCESS_BASE,
            QUEUE_PREPROCESS_SPAN,
            ratio(progress.current, progress.target),
          ),
          `Preprocessing videos: ${progress.current}/${progress.target}`,
        );
      });
      // `fill` is exclusive, so the call above adds nothing when the top-up
      // timer is mid-fill. That is a skipped fill, not a failed one.
      await waitForRunningFill(target);
    }

    if (queue.size() < MINIMUM_STARTUP_VIDEOS) {
      return err({ message: 'Could not preprocess any videos', retryable: true });
    }
    return ok(undefined);
  };

  const runQueueStep = async (): Promise<void> => {
    if (pipeline.get().index.status !== 'done' || videoIndex.count() === 0) {
      pipeline.fail('queue', 'Index the library before preparing the queue');
      return;
    }

    const maxAttempts = Math.max(1, config().retries.maxInitializationAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await guarded(attemptQueue, 'Preparing the queue');
      if (outcome.ok) {
        pipeline.done('queue', `Ready with ${queue.size()} videos prepared`);
        // The step only waited for enough to start on; the rest of the target
        // is filled now rather than on the monitor's next tick.
        fillInBackground();
        return;
      }

      const failure = outcome.error;
      logger.error(`queue attempt ${attempt} failed: ${failure.message}`, failure.cause);
      if (!failure.retryable || attempt === maxAttempts) {
        // The top-up timer keeps trying regardless, and marks the step done if
        // it ever gets a video through.
        pipeline.fail('queue', failure.message, failure.cause);
        return;
      }
      pipeline.running('queue', 0, `Retrying, attempt ${attempt + 1} of ${maxAttempts}`);
      await system.delay(config().timeouts.initializationRetryDelay);
    }
  };

  const startQueue = (): void => {
    void busy
      .runExclusive(runQueueStep)
      .then((outcome) => {
        if (outcome === null) logger.info('queue request skipped: another step is running');
      })
      .catch((thrown: unknown) => {
        logger.error('the queue step failed', thrown);
      });
  };

  /** Chains the queue onto a finished index when this session asked for that. */
  const continueAfterIndex = (): void => {
    const state = pipeline.get();
    if (!state.autoQueue) return;
    if (state.queue.status !== 'idle' && state.queue.status !== 'error') return;
    logger.info('starting the queue automatically after indexing');
    startQueue();
  };

  /** Started once, after the first index request, whether or not it finds anything. */
  const startIndexTimer = (): void => {
    if (indexTimerStarted.get()) return;
    indexTimerStarted.set(true);
    addTimer(
      setInterval(() => {
        void refreshIndex().catch((thrown: unknown) => {
          logger.error('the periodic re-index failed', thrown);
        });
      }, config().video.updateInterval),
    );
  };

  const startIndex = (): void => {
    startIndexTimer();
    void busy
      .runExclusive(runIndexStep)
      .then((succeeded) => {
        if (succeeded === null) {
          logger.info('index request skipped: another step is running');
          return;
        }
        // After the lock is released, or the queue step would find it held.
        if (succeeded) continueAfterIndex();
      })
      .catch((thrown: unknown) => {
        logger.error('the index step failed', thrown);
      });
  };

  /** Empties the queue in memory and on disk; the transcodes go with it. */
  const forgetQueue = async (): Promise<void> => {
    await queue.clear();
    await persistence.clear();
    pipeline.reset('queue');
  };

  const runClearIndex = async (): Promise<void> => {
    await forgetQueue();
    await videoIndex.clear();
    indexed.set(false);
    lastCompleteIndexCount.set(null);
    stats.setIndexed(0, clock.nowIso());
    pipeline.reset('index');
    logger.info('index and queue cleared');
  };

  const runClearQueue = async (): Promise<void> => {
    await forgetQueue();
    logger.info('queue cleared');
  };

  const runRequeue = async (): Promise<void> => {
    await forgetQueue();
    logger.info('queue cleared; preparing a fresh one');
    await runQueueStep();
  };

  const exclusively = (what: string, step: () => Promise<void>): void => {
    void busy
      .runExclusive(step)
      .then((outcome) => {
        if (outcome === null) logger.info(`${what} skipped: another step is running`);
      })
      .catch((thrown: unknown) => {
        logger.error(`${what} failed`, thrown);
      });
  };

  /**
   * Picks up where the last run left off: the saved index, if it still matches
   * the settings, and then the saved queue. Nothing is scanned or transcoded
   * here; an index that no longer matches waits for Index as it always has.
   * Returns whether the index was loaded.
   */
  const restoreOnLaunch = async (): Promise<boolean> => {
    pipeline.running('index', 0, 'Loading the saved index');
    const loaded = await videoIndex.load();
    if (!loaded || videoIndex.needsRebuild() || videoIndex.count() === 0) {
      logger.info('no saved index matches the settings; waiting for Index');
      pipeline.reset('index');
      return false;
    }
    stats.setIndexed(videoIndex.count(), videoIndex.snapshot().builtAt);
    lastCompleteIndexCount.set(videoIndex.count());
    if (videoIndex.needsMeasurement()) await videoIndex.measure(reportIndexProgress);
    finishIndex(true);
    startIndexTimer();

    pipeline.running('queue', QUEUE_RESTORE_PROGRESS, 'Restoring the saved queue');
    const temp = await fileSystem.ensureDirectory(paths.tempDirectory);
    if (temp.ok) await restoreSavedQueue();
    if (queue.size() >= MINIMUM_STARTUP_VIDEOS) {
      pipeline.done('queue', `Restored ${queue.size()} prepared videos`);
      fillInBackground();
    } else {
      pipeline.reset('queue');
    }
    return true;
  };

  /**
   * The periodic re-scan. It also notices a share that has finally mounted:
   * a first index that failed for want of videos is retried by nothing else.
   */
  const refreshIndex = async (): Promise<void> => {
    // Cleared on purpose: the timer must not quietly build it again.
    if (pipeline.get().index.status === 'idle') return;
    const outcome = await busy.runExclusive(runIndexStep);
    if (outcome === null) {
      logger.debug('periodic re-index skipped: another step is running');
      return;
    }
    if (outcome) continueAfterIndex();
  };

  const topUpQueue = async (): Promise<void> => {
    await queue.removeMissingFiles();
    // Cleared on purpose, or never asked for: nothing to top up.
    if (pipeline.get().queue.status === 'idle') return;
    // Nothing to draw from, and `fill` would only log that on every tick.
    if (videoIndex.count() === 0) return;
    await queue.fill();
    // A queue step that gave up has nothing else retrying it; if the monitor
    // has since got something through, the queue is ready after all.
    if (pipeline.get().queue.status === 'error' && queue.size() >= MINIMUM_STARTUP_VIDEOS) {
      pipeline.done('queue', `Ready with ${queue.size()} videos prepared`);
    }
  };

  /**
   * One timer per background job, and one job per timer. The legacy queue ran
   * two overlapping refill intervals, a 30 second one and a 5 second one, which
   * meant the "critical" timer could start a fill the slower one was already
   * running. Started once the saved queue is back, because the sweep and the
   * save both need it to be.
   */
  const startQueueTimers = (): void => {
    if (queueTimersStarted.get()) return;
    queueTimersStarted.set(true);
    const { timeouts } = config();

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

    logger.info('background queue timers started');
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
    logger.info(`scheduling one background index attempt in ${delay}ms`);
    addTimer(
      setTimeout(() => {
        if (pipeline.get().index.status === 'error') startIndex();
      }, delay),
    );
  };

  /**
   * Works one settings change into a running library, without stopping it.
   *
   * Playback carries on throughout: nothing here clears the queue. The library
   * is re-scanned first when the change altered what it contains, and then a
   * fresh batch is transcoded under the new settings and swapped in for the
   * server's queue. Clients see the batch number move and keep only their next
   * two videos, so the new settings arrive two or three videos later - or a
   * few more when the re-scan had to come first.
   */
  const applyUpdate = async (need: UpdateNeed): Promise<void> => {
    if (need === 'reindex' && (videoIndex.needsRebuild() || videoIndex.needsMeasurement())) {
      pipeline.setUpdate({ reindex: true, stage: 'reindexing', message: describeUpdate(need) });
      const complete = videoIndex.needsRebuild()
        ? await rebuildIndex(reportIndexProgress)
        : (await videoIndex.measure(reportIndexProgress), true);

      // A fresh install ships no directories, so its first index ends in the
      // terminal error state. Pointing the settings at real videos is the fix
      // for exactly that, and it must not also require a restart.
      if (videoIndex.count() === 0) {
        pipeline.fail('index', emptyIndexFailure(complete).message);
        return;
      }
      finishIndex(complete);
    }

    // Nothing is queued yet, so the queue step will simply use the new settings.
    if (pipeline.get().queue.status !== 'done') return;

    pipeline.setUpdate({ reindex: need === 'reindex', stage: 'requeueing', message: describeUpdate(need) });
    const target = Math.min(STARTUP_READY_VIDEOS, config().video.preprocessedQueueSize);
    const swapped = await queue.replaceWithFresh(target, (progress) => {
      pipeline.setUpdate({
        reindex: need === 'reindex',
        stage: 'requeueing',
        message: `${describeUpdate(need)} (${progress.current}/${progress.target} ready)`,
      });
    });
    if (swapped) logger.info('the new settings are queued behind the next two videos');
    // The batch was only big enough to start on; the rest refills as usual.
    fillInBackground();
  };

  /** Runs owed updates one after another until none is left. */
  const runUpdates = async (): Promise<void> => {
    for (;;) {
      const need = pendingUpdate.get();
      if (need === null) break;

      const outcome = await busy.runExclusive(async (): Promise<true> => {
        pendingUpdate.set(null);
        await applyUpdate(need);
        return true;
      });
      // Another step holds the lock - a scan, the queue step. The update waits
      // for it rather than being dropped, since nothing else would apply it.
      if (outcome === null) await system.delay(UPDATE_WAIT_INTERVAL);
    }
    pipeline.setUpdate(null);
    // An index the update brought back from an error may have a queue to start.
    continueAfterIndex();
  };

  const requestUpdate = (need: UpdateNeed): void => {
    pendingUpdate.update((previous) => (previous === 'reindex' ? 'reindex' : need));
    const owed = pendingUpdate.get() ?? need;
    const current = pipeline.get().update;
    pipeline.setUpdate({
      reindex: owed === 'reindex' || (current !== null && current.reindex),
      stage: current === null ? 'waiting' : current.stage,
      message: describeUpdate(owed),
    });
    if (updating.get()) return;

    updating.set(true);
    void runUpdates()
      .catch((thrown: unknown) => {
        logger.error('applying the settings change failed', thrown);
        pendingUpdate.set(null);
        pipeline.setUpdate(null);
      })
      .then(() => {
        updating.set(false);
      });
  };

  const handleConfigChange = (next: AppConfig): void => {
    const previous = lastConfig.get();
    lastConfig.set(next);
    // Deliberately not touching the session's auto-queue and auto-play: those
    // are this session's own choices, made on the start screen, and the
    // `startup` settings are only the defaults a new session begins with.

    // Nobody has asked for an index yet. Whenever they do, it reads the
    // configuration as it is then, so there is nothing to bring up to date.
    if (pipeline.get().index.status === 'idle') {
      logger.debug('configuration changed before the first index');
      return;
    }

    // `needsRebuild` compares the index against exactly the settings that
    // decide what it contains, so editing a timeout or a colour does not cost
    // the user a full re-scan; switching the length bias on costs a
    // measurement only if lengths are missing.
    const impact = classifyConfigChange(previous, next);
    const reindex =
      impact === 'reindex' || videoIndex.needsRebuild() || videoIndex.needsMeasurement();
    if (reindex) {
      logger.info('the settings change needs a re-index and a fresh queue');
      requestUpdate('reindex');
      return;
    }
    if (impact === 'requeue' && pipeline.get().queue.status === 'done') {
      logger.info('the settings change needs a fresh queue');
      requestUpdate('requeue');
      return;
    }
    logger.debug('configuration changed; nothing already prepared is affected');
  };

  const start = async (): Promise<void> => {
    const current = config();
    lastConfig.set(current);
    pipeline.setAutoQueue(current.startup.autoQueueAfterIndex);
    pipeline.setAutoPlay(current.startup.autoPlayAfterQueue);

    unwatchConfig.set(
      configService.watch((next) => {
        handleConfigChange(next);
      }),
    );

    // Nothing is scanned or transcoded here. Indexing a large library and
    // transcoding the first videos takes minutes and a lot of CPU, so it waits
    // to be asked for; what the last run already did is only loaded back.
    if (!current.startup.restoreOnLaunch) {
      logger.info('session started; waiting for the index to be requested');
      return;
    }
    void busy
      .runExclusive(restoreOnLaunch)
      .then((restored) => {
        // After the lock is released, or the queue step would find it held.
        if (restored === true) continueAfterIndex();
      })
      .catch((thrown: unknown) => {
        logger.error('restoring the saved index and queue failed', thrown);
        pipeline.reset('index');
        pipeline.reset('queue');
      });
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
    if (
      queue.size() < config().video.preprocessedQueueSize &&
      pipeline.get().queue.status !== 'idle'
    ) {
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
      pipeline: pipeline.get(),
      preprocessedQueue: {
        current: queue.size(),
        target: config().video.preprocessedQueueSize,
      },
      isPreprocessing: queue.isFilling(),
      totalVideos: stats.get().totalVideosIndexed,
      queueGeneration: queue.batch(),
      configRevision: configService.revision(),
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

    pipeline: () => pipeline.get(),
    onPipelineChange: (listener) => pipeline.subscribe(listener),

    startIndex,
    startQueue,
    clearIndex: () => exclusively('clearing the index', runClearIndex),
    clearQueue: () => exclusively('clearing the queue', runClearQueue),
    requeue: () => exclusively('requeueing', runRequeue),
    setAutoQueue: (enabled) => {
      pipeline.setAutoQueue(enabled);
      // Switched on after the index had already finished: there is nothing
      // left for it to wait for.
      if (enabled && pipeline.get().index.status === 'done') continueAfterIndex();
    },
    setAutoPlay: (enabled) => {
      pipeline.setAutoPlay(enabled);
    },

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
