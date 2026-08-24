import { createStore } from '../../../shared/state/store';
import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type {
  LeaderState,
  PlayerApi,
  ServerEvent,
  Unsubscribe,
} from '../../../shared/types/protocol';
import { attemptAsync, err, ok, type Result } from '../../../shared/types/result';
import type { ServiceStatus } from '../../../shared/types/status';
import type { PreprocessedVideo, QueuedVideo } from '../../../shared/types/video';
import { roundTo } from '../../../shared/util/numbers';
import type { PlayerElements } from '../dom/elements';
import type { CommandDispatcher, PlayerCommand } from '../input/commands';
import {
  createVideoPlayer,
  isTransitionBusyError,
  type VideoPlayer,
  type VideoPlayerEvents,
} from '../player/videoPlayer';
import { createVideoStage } from '../player/videoStage';
import { createPlaybackQueue, type PlaybackQueue } from '../queue/playbackQueue';
import { createConnectionIndicator, type ConnectionState } from '../ui/connectionIndicator';
import { createDebugPanel, type DebugPanel, type DebugSnapshot } from '../ui/debugPanel';
import { createLoadingScreen, type LoadingScreen } from '../ui/loadingScreen';
import { createOverlayAnchor, type OverlayAnchor } from '../ui/overlayAnchor';
import { createOverlays, type Overlays } from '../ui/overlays';
import {
  addClockSample,
  bestOffsetMs,
  decideCorrection,
  leaderPositionAt,
  sampleFrom,
  type ClockSample,
} from '../sync/convergence';

/**
 * What this screen is, for multi-screen mirroring.
 *
 * Per client rather than per server: `ClientConfig` is shared by everything that
 * connects, so it cannot say that one particular screen leads. The browser takes
 * it from the URL, Electron from a command-line flag, the TV from its setup
 * screen.
 */
export type ScreenRole = 'independent' | 'leader' | 'follower';

export const SCREEN_ROLES: readonly ScreenRole[] = ['independent', 'leader', 'follower'];

/** Reads a role name from wherever a client keeps it; anything else is a lone screen. */
export const toScreenRole = (value: string | null | undefined): ScreenRole => {
  const name = (value ?? '').trim().toLowerCase();
  return SCREEN_ROLES.indexOf(name as ScreenRole) === -1 ? 'independent' : (name as ScreenRole);
};

export interface PlayerAppOptions {
  readonly api: PlayerApi;
  readonly logger: Logger;
  readonly elements: PlayerElements;
  /** The page's own origin, or null in Electron where files are read directly. */
  readonly origin: string | null;
  readonly startMode: 'immediate' | 'await-gesture';
  /** Defaults to `independent`, which is the behaviour of a lone screen. */
  readonly role?: ScreenRole;
  readonly onExit: () => void;
  /** Provided only where there is a settings screen to return to, i.e. the TV. */
  readonly onShowSettings?: () => void;
  readonly onConnectionChange?: (state: ConnectionState) => void;
}

export interface PlayerApp {
  readonly start: () => Promise<Result<void, Error>>;
  readonly dispatch: CommandDispatcher;
  readonly stop: () => void;
}

/**
 * How long the client waits for the server to report itself ready.
 *
 * Only the web client had a deadline; the other two polled forever behind a
 * spinner that never said anything had gone wrong. All three have one now.
 */
const STARTUP_TIMEOUT_MS = 60000;

/**
 * Transcoded videos the server should have ready before the queue is built.
 * Starting against a nearly empty server queue means the first video plays and
 * the second one is not there yet.
 */
const MINIMUM_READY_VIDEOS = 3;

/**
 * Videos that failed to start, in a row, before the app stops advancing on its
 * own. The legacy clients retried from a timer with no counter, so a temp
 * directory full of broken files produced an endless loop of error toasts.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

const STARTUP_TIMEOUT_MESSAGE =
  `The server did not finish starting within ${STARTUP_TIMEOUT_MS / 1000} seconds. ` +
  'Check the server log, then restart VideoJuke.';

const EMPTY_QUEUE_MESSAGE = 'No videos are available to play. Check the configured directories.';

/**
 * How far the recovery delay is allowed to stretch when nothing is working.
 *
 * A server that goes away mid-session leaves `advance` failing every time, and a
 * flat retry meant a request per `errorRecoveryDelay` - one a second by default -
 * for as long as the page stayed open. The delay now grows with the run of
 * failures so a dead server is polled at a sane rate.
 */
const MAX_RECOVERY_BACKOFF = 15;

/** How often a leader reports where it is, and a follower asks. */
const LEADER_PUBLISH_INTERVAL_MS = 1000;
const FOLLOWER_POLL_INTERVAL_MS = 1000;
/** How often a follower re-checks its position between polls. */
const FOLLOWER_CORRECT_INTERVAL_MS = 250;

const REPEATED_FAILURE_MESSAGE =
  `${MAX_CONSECUTIVE_FAILURES} videos in a row failed to start. ` +
  'Check the server log, then restart VideoJuke.';

/** Everything that can only be built once the configuration has arrived. */
interface Session {
  readonly config: ClientConfig;
  readonly anchor: OverlayAnchor;
  readonly loadingScreen: LoadingScreen;
  readonly overlays: Overlays;
  readonly debugPanel: DebugPanel;
  readonly player: VideoPlayer;
  readonly queue: PlaybackQueue;
}

interface AppState {
  readonly playing: QueuedVideo | null;
  /** Whether {@link playing} has already been reported to the server. */
  readonly settled: boolean;
  readonly failures: number;
  /** True between the first video loading paused and the viewer's gesture. */
  readonly awaitingGesture: boolean;
}

const INITIAL_STATE: AppState = {
  playing: null,
  settled: true,
  failures: 0,
  awaitingGesture: false,
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), milliseconds);
  });

const formatSpeed = (speed: number): string => `${roundTo(speed, 2)}x`;

const formatSkip = (seconds: number): string => `${seconds < 0 ? '-' : '+'}${Math.abs(seconds)}s`;

/**
 * Whether there is enough on the server to be worth building a queue against.
 * A server that has stopped transcoding will not produce more by being waited
 * for, so the count it has reached is the count we start with.
 */
const hasEnoughVideos = (status: ServiceStatus): boolean => {
  if (status.totalVideos === 0) return false;
  if (status.preprocessedQueue.current >= MINIMUM_READY_VIDEOS) return true;
  return !status.isPreprocessing;
};

/**
 * The whole client, minus the three lines of platform glue around it.
 *
 * `electron/client.js`, `web/client.js` and `webos/client.js` were 1862 lines of
 * near-identical orchestration: the same initialization poll, the same queue
 * build, the same manual-skip dance and the same recovery timers, each copy
 * having drifted its own way. The only genuine difference between them was
 * whether playback may begin without a user gesture, which is now `startMode`.
 */
export const createPlayerApp = (options: PlayerAppOptions): PlayerApp => {
  const { api, logger, elements, origin, startMode, onExit, onShowSettings } = options;
  const role = options.role ?? 'independent';
  const isFollower = role === 'follower';

  const state = createStore<AppState>(INITIAL_STATE);
  // Null until something has been reported, so the first report always fires.
  const connection = createStore<ConnectionState | null>(null);
  const indicator = createConnectionIndicator(elements.connectionStatus);

  // Handles for work in flight rather than observable state: nothing outside
  // this module can see them, and every one of them is cleared by `stop`.
  let session: Session | null = null;
  let unsubscribeEvents: Unsubscribe | null = null;
  let detachStartButton: (() => void) | null = null;
  let stopQueueMonitor: (() => void) | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let commandBusy = false;
  let startCalled = false;
  let stopped = false;
  /**
   * Set once startup has ended in a message on the loading screen. Server events
   * keep arriving afterwards, and `applyInitialization` would paint progress
   * straight over the reason the viewer is being shown.
   */
  let startFailed = false;
  /** Consecutive recoveries with nothing to show for them; drives the backoff. */
  let recoveryAttempts = 0;

  // Multi-screen mirroring. A leader reports where it is; a follower asks, and
  // corrects towards the answer. Both are inert when the role is `independent`,
  // which is what a single screen is.
  let leaderTimer: ReturnType<typeof setInterval> | null = null;
  let followerPollTimer: ReturnType<typeof setInterval> | null = null;
  let followerCorrectTimer: ReturnType<typeof setInterval> | null = null;
  let clockSamples: readonly ClockSample[] = [];
  let followed: LeaderState | null = null;
  /** Guards the async hand-off so two polls cannot both start the same video. */
  let switchingTo: string | null = null;

  const reportConnection = (next: ConnectionState): void => {
    if (connection.get() === next) return;
    connection.set(next);
    indicator.set(next);
    logger.debug(`server connection ${next}`);
    if (options.onConnectionChange !== undefined) options.onConnectionChange(next);
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };

  /**
   * Disarms the pending recovery.
   *
   * Recovery exists to advance a queue that has stopped moving. Once something
   * else has moved it - a manual skip, a video that ended, a fade that landed -
   * the timer would advance it a second time, and the viewer who pressed next
   * once watched two videos go by.
   */
  const cancelRecovery = (): void => {
    recoveryTimer = clearTimer(recoveryTimer);
    recoveryAttempts = 0;
  };

  /** Marks the current video as accounted for, so it is not reported twice. */
  const settle = (): void => {
    state.update((previous) => (previous.settled ? previous : { ...previous, settled: true }));
  };

  const mirrorQueue = (videos: readonly PreprocessedVideo[]): void => {
    void attemptAsync(() => api.syncPlaybackQueue(videos)).then((synced) => {
      // A mirror exists so a restart can resume; failing to write one costs
      // nothing that is happening now.
      if (!synced.ok) logger.debug(`could not mirror the playback queue - ${synced.error.message}`);
    });
  };

  /**
   * What the server must not sweep out of the temp directory: the video on
   * screen as well as the ones still waiting. `takeNext` removes a video from
   * the queue before it is played and the server only hears of it again when it
   * ends, so without the head the file being decoded belongs to no protected
   * set at all and a sweep can delete it out from under the player.
   */
  const toMirroredQueue = (current: Session): readonly PreprocessedVideo[] => {
    const pending = current.queue.snapshot();
    const playing = state.get().playing;
    return playing === null ? pending : [playing.video, ...pending];
  };

  /**
   * Records a video as played, unless it came back out of history: recording it
   * again would move it to the front and the viewer could never step past it.
   * The legacy clients tracked this by writing a `_fromHistory` flag onto the
   * video object and deleting it again from three different places.
   */
  const reportEnded = async (video: QueuedVideo): Promise<void> => {
    if (video.origin === 'history') {
      logger.debug(`${video.video.filename} came from history; not recording it again`);
      return;
    }
    const name = video.video.filename;
    const recorded = await attemptAsync(() => api.recordVideoEnded(video.video));
    if (!recorded.ok) logger.warn(`could not report ${name} as played - ${recorded.error.message}`);
  };

  const toDebugSnapshot = (player: VideoPlayer, queue: PlaybackQueue): DebugSnapshot => {
    const snapshot = player.snapshot();
    return {
      playbackQueueSize: queue.size(),
      currentVideoName: snapshot.current === null ? '' : snapshot.current.video.filename,
      speed: snapshot.speed,
      paused: snapshot.paused,
      looping: snapshot.looping,
      crossfadeEnabled: snapshot.crossfadeEnabled,
      blurEnabled: snapshot.blurEnabled,
      connection: connection.get(),
    };
  };

  const scheduleRecovery = (current: Session): void => {
    // One recovery at a time: a media error and a failed start can both arrive
    // for the same video, and two timers would advance the queue twice.
    if (recoveryTimer !== null || stopped) return;

    recoveryAttempts = Math.min(recoveryAttempts + 1, MAX_RECOVERY_BACKOFF);
    const delay = current.config.timeouts.errorRecoveryDelay * recoveryAttempts;

    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (stopped || session !== current) return;
      void advance(current);
    }, delay);
  };

  const playVideo = async (
    current: Session,
    video: QueuedVideo,
    manual: boolean,
  ): Promise<void> => {
    // Nothing has played yet only at startup, and a first video that failed is
    // retried as the first one: the loading screen and the gesture prompt are
    // still up, and only an `isFirst` start takes them down.
    const isFirst = state.get().playing === null;
    const played = await current.player.play(video, { manual, isFirst });
    if (played.ok) return;

    if (isTransitionBusyError(played.error)) {
      // Refused, not failed: the transition already running will finish on its
      // own. The video has to go back or it is dropped without ever playing.
      logger.debug(`deferring ${video.video.filename}: a transition is already running`);
      current.queue.pushFront(video);
      // And the attempt has to be re-armed. This is the only exit from `advance`
      // that leaves the queue where it was, so a recovery that lands on a busy
      // guard used to end the chain here: if the transition it deferred to then
      // failed, nothing was left to advance anything. Re-arming is free when it
      // succeeds instead, because `handleStarted` cancels the timer.
      scheduleRecovery(current);
      return;
    }

    const failures = state.update((previous) => ({
      ...previous,
      failures: previous.failures + 1,
    })).failures;

    logger.error(`could not play ${video.video.filename}`, played.error);
    current.overlays.showError(`Could not play ${video.video.filename}`);
    await attemptAsync(() => api.recordVideoError(played.error.message));

    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error(`stopping after ${failures} videos in a row failed to start`);
      // `handleStarted` hid the loading screen when the last good video began,
      // so the message has to bring it back or it is written out of sight.
      current.loadingScreen.show();
      current.loadingScreen.showError(REPEATED_FAILURE_MESSAGE);
      // Nothing is advancing any more, so a progress frame arriving from the
      // server must not paint over the explanation. A later successful start -
      // the viewer pressing next - clears both in `handleStarted`.
      startFailed = true;
      return;
    }
    scheduleRecovery(current);
  };

  /**
   * Moves to the next queued video. An empty queue is refilled and retried once
   * immediately, and after that from the recovery timer rather than by
   * recursing, which is what made the legacy clients spin on an empty server.
   */
  const advance = async (current: Session, manual = false): Promise<void> => {
    const next = current.queue.takeNext();
    if (next !== null) {
      await playVideo(current, next, manual);
      return;
    }

    logger.debug('the playback queue is empty; refilling before advancing');
    await current.queue.fill();
    if (stopped || session !== current) return;

    const retry = current.queue.takeNext();
    if (retry === null) {
      logger.warn('the playback queue is still empty after a refill; will try again');
      current.overlays.showError('No videos are available');
      // Nothing else calls `advance`, so returning here would leave the last
      // frame frozen until the viewer pressed next, however many videos the
      // monitor went on to queue up. One timer at a time, and `stop` clears it.
      scheduleRecovery(current);
      return;
    }
    await playVideo(current, retry, manual);
  };

  const handleEnded = async (current: Session, video: QueuedVideo): Promise<void> => {
    settle();
    // A follower shows what the leader shows. Reporting the end would put the
    // video into the shared history a second time, and advancing would pick a
    // video of its own - which is precisely the divergence mirroring exists to
    // prevent. It waits to be told what comes next.
    if (isFollower) return;

    await reportEnded(video);
    if (stopped || session !== current) return;
    await advance(current);
  };

  const handleError = async (current: Session, error: Error): Promise<void> => {
    // The video that broke will never end normally, so nothing else is going to
    // account for it.
    settle();
    await attemptAsync(() => api.recordVideoError(error.message));
    if (stopped || session !== current) return;

    current.overlays.showError(`Playback error: ${error.message}`);
    scheduleRecovery(current);
  };

  const handleStarted = (current: Session, video: QueuedVideo, isFirst: boolean): void => {
    // Something is playing, so nothing needs recovering and nothing has failed.
    cancelRecovery();
    startFailed = false;
    const previous = state.get();
    // A scheduled crossfade hands over without ending the outgoing video, so
    // this is the only place that video gets reported.
    if (previous.playing !== null && !previous.settled) void reportEnded(previous.playing);

    state.set({ ...previous, playing: video, settled: false, failures: 0 });
    // Immediately, not on the next heartbeat: a video change is the one moment
    // a follower cannot extrapolate its way through.
    if (role === 'leader') publishLeaderState(current);

    // The repeated-failure message put the loading screen back up over the
    // stage. A video is playing again now, so it has to come down, or the
    // viewer is left reading "playback stopped" over a video that is playing.
    if (!isFirst && !previous.awaitingGesture) {
      current.loadingScreen.hide();
      return;
    }
    if (!isFirst) return;

    if (previous.awaitingGesture) {
      // The frame is loaded and visible behind the loading screen; the browser
      // will not let it make a sound until the viewer asks for it.
      current.loadingScreen.setMessage('Ready to play');
      current.loadingScreen.setStartEnabled(true);
      logger.info('the first video is ready and waiting for a gesture');
      return;
    }

    current.loadingScreen.hide();
    indicator.hide();
  };

  const handleGesture = (): void => {
    const current = session;
    if (current === null || !state.get().awaitingGesture) return;

    state.update((previous) => ({ ...previous, awaitingGesture: false }));
    current.loadingScreen.hide();
    indicator.hide();
    logger.info('playback started by the viewer');
    void current.player.resumeWithSound();
  };

  const manualNext = async (current: Session): Promise<void> => {
    if (!current.player.beginManualTransition()) {
      logger.debug('ignoring next: a transition is already running');
      return;
    }

    // The viewer is advancing the queue by hand; a timer about to do the same
    // would skip a second video the moment this one started.
    cancelRecovery();

    const playing = state.get().playing;
    settle();
    // The server writes the outgoing video into history as part of the skip.
    // The legacy clients sent that as a separate `addToHistory` request, so two
    // round trips had to arrive in order for history to stay consistent.
    const skipped = playing === null || playing.origin === 'history' ? null : playing.video;
    const recorded = await attemptAsync(() => api.recordManualSkip(skipped));
    if (!recorded.ok) logger.warn(`could not report the skip - ${recorded.error.message}`);
    if (stopped || session !== current) return;

    await advance(current, true);
  };

  const manualPrevious = async (current: Session): Promise<void> => {
    const previous = await attemptAsync(() => api.takePreviousVideo());
    if (!previous.ok) {
      logger.error('could not ask the server for the previous video', previous.error);
      current.overlays.showError('Could not reach the previous video');
      return;
    }
    const wanted = previous.value;
    if (wanted === null) {
      logger.debug('there is no previous video');
      current.overlays.showError('No previous video available');
      return;
    }

    // The temp file may have been cleaned up since it was played, in which case
    // the server transcodes it again before handing it back.
    const ensured = await attemptAsync(() => api.ensurePlayable(wanted));
    const playable = ensured.ok ? ensured.value : null;
    if (playable === null) {
      logger.warn(`${wanted.filename} could not be made playable again`);
      current.overlays.showError('The previous video is no longer available');
      return;
    }
    if (stopped || session !== current) return;

    // Claimed late, as the legacy clients did: giving up after cancelling the
    // scheduled crossfade would leave the current video with no handover.
    if (!current.player.beginManualTransition()) {
      // The server has already popped this entry off its history and, if the
      // transcode was gone, spent a full ffmpeg run rebuilding it. Dropping it
      // here would throw both away and leave "previous" looking like it did
      // nothing; queueing it plays it as soon as the transition finishes.
      logger.debug('deferring previous: a transition is already running');
      current.queue.pushFront({ video: playable, origin: 'history' });
      return;
    }

    cancelRecovery();

    const playing = state.get().playing;
    if (playing !== null) {
      // Back to the front of the queue as a queue entry, so playing it again
      // records it in history normally.
      current.queue.pushFront({ video: playing.video, origin: 'queue' });
    }
    settle();

    // Deliberately null: the outgoing video went back to the queue rather than
    // into history, and recording it there would let "previous" return the
    // video the viewer just stepped away from.
    const recorded = await attemptAsync(() => api.recordReturnToPrevious(null));
    if (!recorded.ok) logger.warn(`could not report the step back - ${recorded.error.message}`);
    if (stopped || session !== current) return;

    await playVideo(current, { video: playable, origin: 'history' }, true);
  };

  /**
   * Marks the video on screen for archiving, or clears the mark.
   *
   * The server owns the list, so the answer to "is it flagged now?" comes back
   * from it rather than being guessed here; that keeps the indicator honest even
   * if the same video was flagged from another client or by hand.
   */
  const toggleArchive = async (current: Session): Promise<void> => {
    const playing = current.player.snapshot().current;
    if (playing === null) {
      logger.debug('ignoring archive toggle: nothing is playing');
      return;
    }

    const toggled = await attemptAsync(() => api.toggleArchiveFlag(playing.video));
    if (!toggled.ok) {
      logger.error(`could not change the archive flag for ${playing.video.filename}`, toggled.error);
      current.overlays.showError('Could not update the archive list');
      return;
    }

    logger.info(`${playing.video.filename} ${toggled.value ? 'flagged' : 'unflagged'}`);
    current.overlays.showStatus(
      toggled.value ? 'Flagged for archive' : 'Removed from archive list',
    );
  };

  const runCommand = async (current: Session, command: PlayerCommand): Promise<void> => {
    const { player, overlays, config } = current;

    switch (command) {
      case 'next':
        await manualNext(current);
        return;

      case 'previous':
        await manualPrevious(current);
        return;

      case 'play-pause':
        player.togglePlayPause();
        overlays.showStatus(player.snapshot().paused ? 'Paused' : 'Playing');
        return;

      case 'restart':
        player.restart();
        overlays.showStatus('Restarted');
        return;

      case 'toggle-loop':
        overlays.showStatus(player.toggleLoop() ? 'Loop on' : 'Loop off');
        return;

      case 'toggle-mute':
        overlays.showStatus(player.toggleMute() ? 'Muted' : 'Sound on');
        return;

      case 'toggle-crossfade':
        overlays.showStatus(player.toggleCrossfade() ? 'Crossfade on' : 'Crossfade off');
        return;

      case 'toggle-blur':
        overlays.showStatus(player.toggleBlur() ? 'Blur on' : 'Blur off');
        return;

      case 'speed-up':
        overlays.showStatus(formatSpeed(player.adjustSpeed(config.playback.speedIncrement)));
        return;

      case 'speed-down':
        overlays.showStatus(formatSpeed(player.adjustSpeed(-config.playback.speedIncrement)));
        return;

      case 'reset-speed':
        overlays.showStatus(formatSpeed(player.setSpeed(1)));
        return;

      case 'skip-forward':
        player.seekBy(config.playback.skipSeconds);
        overlays.showStatus(formatSkip(config.playback.skipSeconds));
        return;

      case 'skip-backward':
        player.seekBy(-config.playback.skipSeconds);
        overlays.showStatus(formatSkip(-config.playback.skipSeconds));
        return;

      case 'show-info': {
        const playing = player.snapshot().current;
        if (playing !== null) overlays.showVideoInfo(playing.video);
        return;
      }

      case 'show-title': {
        const playing = player.snapshot().current;
        if (playing !== null) overlays.showVideoInfo(playing.video, { titleOnly: true });
        return;
      }

      case 'toggle-archive':
        await toggleArchive(current);
        return;

      case 'toggle-debug':
        current.debugPanel.toggle();
        return;

      case 'toggle-controls':
        overlays.toggleControls();
        return;

      case 'stop':
        player.setPaused(true);
        // Seeking rather than `restart`, which resumes a video that is paused.
        player.seekBy(Number.NEGATIVE_INFINITY);
        overlays.showStatus('Stopped');
        return;

      case 'show-settings':
        if (onShowSettings === undefined) {
          logger.debug('this platform has no settings screen');
          return;
        }
        logger.info('settings requested');
        onShowSettings();
        return;

      case 'exit':
        logger.info('exit requested');
        onExit();
        return;
    }
  };

  /**
   * Only the commands that change which video is playing are rate-limited.
   * They load a file and swap the stage, so a held-down button would otherwise
   * queue up transitions faster than they can finish. Toggles and nudges are
   * cheap and local, and gating them made holding the speed key feel broken.
   */
  const RATE_LIMITED: readonly PlayerCommand[] = ['next', 'previous'];

  const isRateLimited = (command: PlayerCommand): boolean =>
    RATE_LIMITED.indexOf(command) !== -1;

  const dispatch: CommandDispatcher = (command) => {
    const current = session;
    if (current === null || stopped) {
      logger.debug(`ignoring ${command}: the player is not running`);
      return;
    }

    // Nothing has been allowed to make a sound yet, so there is no playback to
    // command. Letting keys through here advanced the queue behind a loading
    // screen that was still waiting for a click: the start button then resumed
    // a video the viewer had already skipped past, and the prompt stayed up
    // over whatever was playing.
    if (state.get().awaitingGesture) {
      logger.debug(`ignoring ${command}: playback has not been started yet`);
      return;
    }

    const limited = isRateLimited(command);
    if (limited && commandBusy) {
      logger.debug(`ignoring ${command}: a transition is still running`);
      return;
    }

    if (limited) commandBusy = true;

    void attemptAsync(() => runCommand(current, command)).then((outcome) => {
      if (!outcome.ok) logger.error(`the ${command} command failed`, outcome.error);
      if (!limited) return;
      // A command still in flight when the app stops must not arm a timer that
      // outlives it; `dispatch` already refuses everything once stopped.
      if (stopped) {
        commandBusy = false;
        return;
      }
      cooldownTimer = setTimeout(() => {
        cooldownTimer = null;
        commandBusy = false;
      }, current.config.timeouts.commandCooldown);
    });
  };

  /**
   * The player's four callbacks. They read `session` when they fire rather than
   * closing over it, because the player has to exist before the queue it asks
   * for videos from.
   */
  const playerEvents: VideoPlayerEvents = {
    onEnded: (video) => {
      const current = session;
      if (current === null || stopped) return;
      void handleEnded(current, video);
    },
    onError: (error) => {
      const current = session;
      if (current === null || stopped) return;
      void handleError(current, error);
    },
    onStarted: (video, isFirst) => {
      const current = session;
      if (current === null || stopped) return;
      handleStarted(current, video, isFirst);
    },
    requestNext: () => {
      const current = session;
      // A follower holds no queue to draw from; its next video arrives from the
      // leader, so a scheduled crossfade simply lets the current one play out.
      if (current === null || stopped || isFollower) return Promise.resolve(null);
      return Promise.resolve(current.queue.takeNext());
    },
    returnNext: (video) => {
      const current = session;
      // Nothing to put it back into once the app has stopped; `stop` has
      // already mirrored the queue it is going to persist.
      if (current === null || stopped) return;
      current.queue.pushFront(video);
    },
  };

  /**
   * Reports what this screen is playing, for the others to mirror.
   *
   * `PreprocessedVideo`, never the playable one: `location` holds a signed,
   * expiring stream URL minted for this client, and handing it to another screen
   * would give it a credential that stops working part-way through the video.
   */
  const publishLeaderState = (current: Session): void => {
    const playing = state.get().playing;
    if (playing === null) return;

    const snapshot = current.player.snapshot();
    void attemptAsync(() =>
      api.publishLeaderState({
        video: playing.video,
        positionSeconds: current.player.position(),
        paused: snapshot.paused,
        rate: snapshot.speed,
      }),
    ).then((published) => {
      if (!published.ok) logger.debug(`could not publish leader state - ${published.error.message}`);
    });
  };

  /** The server's clock as this screen best understands it. */
  const serverNow = (): number => Date.now() + bestOffsetMs(clockSamples);

  /**
   * Starts playing whatever the leader is playing.
   *
   * The follower mints its own stream URL through `locatePlayable`, which never
   * transcodes - so a follower asking about a video whose transcode has been
   * swept simply waits rather than putting the server to work.
   */
  const followLeaderVideo = async (current: Session, leader: LeaderState): Promise<void> => {
    const wanted = String(leader.video.processedPath);
    if (switchingTo === wanted) return;
    switchingTo = wanted;

    const located = await attemptAsync(() => api.locatePlayable(leader.video));
    if (stopped || session !== current) return;

    const playable = located.ok ? located.value : null;
    if (playable === null) {
      logger.debug(`waiting: ${leader.video.filename} is not playable here yet`);
      switchingTo = null;
      return;
    }

    // `manual` so the change is a cut rather than a fade: a follower is trying
    // to match a position, and a crossfade would spend a second not matching it.
    const played = await current.player.play(
      { video: playable, origin: 'history' },
      { manual: true, isFirst: state.get().playing === null },
    );
    if (!played.ok && !isTransitionBusyError(played.error)) {
      logger.warn(`could not mirror ${leader.video.filename} - ${played.error.message}`);
    }
    switchingTo = null;
  };

  const applyLeaderState = async (current: Session, leader: LeaderState): Promise<void> => {
    // Out of order: a poll and a push can cross, and the older one must not
    // rewind the newer.
    if (followed !== null && leader.sequence < followed.sequence) return;
    followed = leader;

    const playing = state.get().playing;
    if (playing === null || playing.video.processedPath !== leader.video.processedPath) {
      await followLeaderVideo(current, leader);
      return;
    }

    // Not while the viewer has yet to start playback. The video is loaded and
    // paused behind the start button on purpose, and un-pausing it here only
    // hands the autoplay policy a refusal to log once a second.
    if (state.get().awaitingGesture) return;

    // Match the transport before worrying about the position: correcting the
    // rate of a paused element does nothing at all.
    const snapshot = current.player.snapshot();
    if (snapshot.paused !== leader.paused) current.player.setPaused(leader.paused);

    // And match the speed, which nothing did. A follower playing at 1x behind a
    // leader at 1.25x falls behind a fifth of a second every second, while the
    // convergence trim can bend the rate by at most 5% - so the error grew until
    // it crossed the seek threshold, the follower jumped, and it began again.
    // The trim corrects around this rate rather than standing in for it.
    if (snapshot.speed !== leader.rate) {
      logger.debug(`matching the leader's ${leader.rate}x playback rate`);
      current.player.setSpeed(leader.rate);
    }
  };

  /** One correction step: measure the gap to the leader and close it. */
  const correctTowardsLeader = (current: Session): void => {
    const leader = followed;
    if (leader === null || leader.paused) return;
    if (state.get().awaitingGesture) return;

    const playing = state.get().playing;
    if (playing === null || playing.video.processedPath !== leader.video.processedPath) return;
    if (current.player.snapshot().paused) return;

    const error = leaderPositionAt(leader, serverNow()) - current.player.position();
    const correction = decideCorrection(error);

    if (correction.kind === 'hold') {
      current.player.setSyncTrim(1);
      return;
    }
    if (correction.kind === 'trim') {
      current.player.setSyncTrim(correction.trim);
      return;
    }

    logger.debug(`sync seek of ${roundTo(correction.seconds, 2)}s`);
    current.player.setSyncTrim(1);
    current.player.syncSeek(current.player.position() + correction.seconds);
  };

  const pollLeaderState = async (current: Session): Promise<void> => {
    const sentAt = Date.now();
    const polled = await attemptAsync(() => api.getLeaderState());
    if (stopped || session !== current || !polled.ok) return;

    // The round trip that carried the state also measures the clock offset,
    // which is why polling is the baseline rather than a fallback.
    clockSamples = addClockSample(
      clockSamples,
      sampleFrom(sentAt, polled.value.serverNowMs, Date.now()),
    );

    if (polled.value.state === null) {
      // The server forgets a leader that has stopped publishing, and a follower
      // that kept its last copy would go on extrapolating a screen that is no
      // longer there - seeking to the end of a video the leader stopped playing
      // minutes ago, four times a second, for ever.
      if (followed !== null) {
        logger.info('the leading screen has gone; holding at the current position');
        followed = null;
        current.player.setSyncTrim(1);
      }
      return;
    }
    await applyLeaderState(current, polled.value.state);
  };

  const startMirroring = (current: Session): void => {
    if (role === 'leader') {
      publishLeaderState(current);
      leaderTimer = setInterval(() => {
        if (!stopped && session === current) publishLeaderState(current);
      }, LEADER_PUBLISH_INTERVAL_MS);
      logger.info('this screen is leading');
      return;
    }

    if (!isFollower) return;

    void pollLeaderState(current);
    followerPollTimer = setInterval(() => {
      if (!stopped && session === current) void pollLeaderState(current);
    }, FOLLOWER_POLL_INTERVAL_MS);
    followerCorrectTimer = setInterval(() => {
      if (!stopped && session === current) correctTowardsLeader(current);
    }, FOLLOWER_CORRECT_INTERVAL_MS);
    logger.info('this screen is following');
  };

  const handleServerEvent = (event: ServerEvent): void => {
    const current = session;
    if (current === null || stopped) return;

    if (event.type === 'leader-state') {
      // Only ever an early wake-up: the poll below is the real transport, and
      // the webOS client never receives this at all.
      if (isFollower) void applyLeaderState(current, event.state);
      return;
    }

    if (event.type === 'initialization') {
      // Not once startup has given up. The subscription outlives a failed
      // start, and the next progress frame from a server that is still working
      // away used to replace the message explaining why nothing will play with
      // a progress bar that leads nowhere.
      if (startFailed) return;
      // Only while nothing is playing: once there is a video on screen the
      // viewer is watching it, not a progress bar.
      if (state.get().playing === null) current.loadingScreen.applyInitialization(event.state);
      return;
    }

    // Server log lines used to be printed onto the loading screen a line at a
    // time. They are per-item detail, so they go to the debug log instead.
    logger.debug(`server ${event.entry.level} ${event.entry.scope}: ${event.entry.message}`);
  };

  /**
   * Ends startup with something the viewer can read, and hands the caller an
   * error it can still classify.
   *
   * `cause` is what makes the second half true. Entry points tell "the token was
   * rejected" apart from "the server is down" by the error's `name`, and
   * re-wrapping the message in a bare `Error` dropped it - so the browser
   * client's "forget this token and ask for a new one" branch could never run,
   * and a stale token failed the same way on every reload for ever.
   */
  const fail = (
    loadingScreen: LoadingScreen,
    message: string,
    cause?: Error,
  ): Result<void, Error> => {
    logger.error(message);
    startFailed = true;
    loadingScreen.showError(message);
    const error = new Error(message);
    if (cause !== undefined) error.name = cause.name;
    return err(error);
  };

  /**
   * Polls the server until it reports itself ready, or gives up with something
   * the viewer can act on. The stage is reported straight onto the loading
   * screen, so a slow index looks like progress rather than a hang.
   */
  const waitForServer = async (
    loadingScreen: LoadingScreen,
    config: ClientConfig,
  ): Promise<Result<ServiceStatus, Error>> => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    for (;;) {
      if (stopped) return err(new Error('the player was stopped during startup'));

      const status = await attemptAsync(() => api.getStatus());
      if (status.ok) {
        reportConnection('connected');
        const initialization = status.value.initialization;
        loadingScreen.applyInitialization(initialization);

        if (initialization.stage === 'error') {
          return err(new Error(initialization.error ?? initialization.message));
        }
        if (initialization.stage === 'ready') {
          if (hasEnoughVideos(status.value)) return ok(status.value);
          loadingScreen.setMessage(
            status.value.totalVideos === 0
              ? 'No videos found. Check the directories in the server configuration.'
              : 'Waiting for the server to transcode a few videos...',
          );
        }
      } else {
        reportConnection('disconnected');
        logger.warn(`could not read the server status - ${status.error.message}`);
      }

      if (Date.now() >= deadline) {
        reportConnection('failed');
        return err(new Error(STARTUP_TIMEOUT_MESSAGE));
      }
      await delay(config.timeouts.initializationRetryDelay);
    }
  };

  const start = async (): Promise<Result<void, Error>> => {
    if (startCalled) return err(new Error('the player has already been started'));
    startCalled = true;
    logger.info('starting the player');

    const root = elements.loadingScreen.ownerDocument;
    const loadingScreen = createLoadingScreen({ elements, logger: logger.child('loading') });
    loadingScreen.show();
    reportConnection('connecting');

    const loaded = await attemptAsync(() => api.getConfig());
    if (!loaded.ok) {
      reportConnection('failed');
      return fail(
        loadingScreen,
        `Could not load the configuration: ${loaded.error.message}`,
        loaded.error,
      );
    }
    if (stopped) return err(new Error('the player was stopped during startup'));

    const config = loaded.value;
    reportConnection('connected');

    const anchor = createOverlayAnchor(root);
    const overlays = createOverlays({ elements, config, anchor, logger: logger.child('overlays') });
    const stage = createVideoStage(elements.videos);
    const player = createVideoPlayer({
      stage,
      config,
      logger: logger.child('player'),
      origin,
      events: playerEvents,
    });
    const queue = createPlaybackQueue({
      api,
      config,
      logger: logger.child('queue'),
      origin,
      document: root,
    });
    const debugPanel = createDebugPanel({
      elements,
      config,
      api,
      anchor,
      logger: logger.child('debug'),
      snapshot: () => toDebugSnapshot(player, queue),
    });

    const current: Session = {
      config,
      anchor,
      loadingScreen,
      overlays,
      debugPanel,
      player,
      queue,
    };
    session = current;
    unsubscribeEvents = api.subscribe(handleServerEvent);

    const status = await waitForServer(loadingScreen, config);
    if (!status.ok) return fail(loadingScreen, status.error.message, status.error);

    // Above the follower branch, not below it. A follower is still a browser
    // tab, and the autoplay policy does not care what role a screen plays: it
    // used to reach `player.play` with `paused` false, start muted - which is
    // permitted - and then be paused by the browser 100ms later when
    // `scheduleUnmute` unmuted it without a gesture. Nothing wrote that pause
    // into the player's own state, so the sync loop went on correcting a stopped
    // element, and there was no start button anywhere to rescue it.
    const awaitGesture = (): void => {
      if (startMode !== 'await-gesture') return;
      // The browser autoplay policy refuses an audible start, so the first
      // video is loaded paused and the viewer's click is what begins it. This
      // is the only behavioural difference between the three clients.
      player.setPaused(true);
      state.update((previous) => ({ ...previous, awaitingGesture: true }));
      detachStartButton = loadingScreen.onStart(handleGesture);
    };

    if (isFollower) {
      // Deliberately no queue, no monitor and no mirror timer. A follower that
      // drew from the shared pool would take videos the leader was going to
      // play, and one that mirrored its own queue would overwrite the leader's
      // protected set - letting the temp sweep delete the video on screen.
      awaitGesture();
      loadingScreen.setMessage(
        state.get().awaitingGesture
          ? 'Waiting for the leading screen. Press start when it appears.'
          : 'Waiting for the leading screen...',
      );
      startMirroring(current);
      logger.info('the player is running as a follower');
      return ok(undefined);
    }

    const built = await queue.buildInitial((progress) => {
      loadingScreen.showQueueProgress(progress.current, progress.target);
    });
    if (stopped) return err(new Error('the player was stopped during startup'));
    if (!built) return fail(loadingScreen, EMPTY_QUEUE_MESSAGE);

    const first = queue.takeNext();
    if (first === null) return fail(loadingScreen, EMPTY_QUEUE_MESSAGE);

    stopQueueMonitor = queue.startMonitoring();
    syncTimer = setInterval(() => {
      mirrorQueue(toMirroredQueue(current));
    }, config.timeouts.queueSyncInterval);

    awaitGesture();

    // Through the same path as every other video: a single unplayable file at
    // the head of the queue used to be terminal here, while every later one is
    // retried until MAX_CONSECUTIVE_FAILURES of them fail in a row.
    await playVideo(current, first, false);

    startMirroring(current);
    logger.info('the player is running');
    return ok(undefined);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;

    cooldownTimer = clearTimer(cooldownTimer);
    recoveryTimer = clearTimer(recoveryTimer);
    commandBusy = false;

    if (syncTimer !== null) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (leaderTimer !== null) {
      clearInterval(leaderTimer);
      leaderTimer = null;
    }
    if (followerPollTimer !== null) {
      clearInterval(followerPollTimer);
      followerPollTimer = null;
    }
    if (followerCorrectTimer !== null) {
      clearInterval(followerCorrectTimer);
      followerCorrectTimer = null;
    }
    followed = null;
    switchingTo = null;
    clockSamples = [];
    if (unsubscribeEvents !== null) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    if (detachStartButton !== null) {
      detachStartButton();
      detachStartButton = null;
    }
    if (stopQueueMonitor !== null) {
      stopQueueMonitor();
      stopQueueMonitor = null;
    }

    const current = session;
    session = null;

    if (current !== null) {
      // Read before the queue is torn down: this is the snapshot a restart
      // resumes from, and it replaces the main process reaching into the
      // renderer to evaluate `getQueueStateForPersistence()`. A follower has no
      // queue of its own and must not overwrite the leader's.
      if (!isFollower) mirrorQueue(current.queue.snapshot());
      current.debugPanel.cleanup();
      current.overlays.cleanup();
      current.player.cleanup();
      current.queue.cleanup();
      current.anchor.cleanup();
    }

    state.set(INITIAL_STATE);
    logger.info('player stopped');
  };

  return { start, dispatch, stop };
};
