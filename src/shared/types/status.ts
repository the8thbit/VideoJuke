import type { IsoTimestamp } from './brand';

/**
 * Where one step of getting ready stands.
 *
 * `idle` is "nobody has asked yet", which since the start screen is where every
 * session begins: nothing is indexed until a person or the auto settings ask.
 */
export type PhaseStatus = 'idle' | 'running' | 'done' | 'error';

export interface PhaseState {
  readonly status: PhaseStatus;
  /** Completion in the range 0..1; meaningful while running. */
  readonly progress: number;
  readonly message: string;
  /** The detail behind a failure, or null when there is none. */
  readonly error: string | null;
}

/**
 * A settings change being worked into a library that is already running.
 *
 * Playback carries on throughout. The library is re-scanned first when the
 * change altered what it contains, then a fresh batch is transcoded under the
 * new settings and swapped in behind the next couple of videos.
 */
export interface SettingsUpdateState {
  /** Whether this update re-scans the library before rebuilding the queue. */
  readonly reindex: boolean;
  readonly stage: 'waiting' | 'reindexing' | 'requeueing';
  readonly message: string;
}

/**
 * The two server-side steps before anything can play, and whether each one
 * starts the next on its own.
 *
 * `index` scans the configured directories (and measures lengths when the
 * length bias is on). `queue` restores the saved queue and transcodes enough
 * videos to start. Playing is the client's own step and has no state here, but
 * whether it follows the queue automatically is shared, so every screen agrees.
 */
export interface PipelineState {
  readonly index: PhaseState;
  readonly queue: PhaseState;
  /** Start the queue as soon as indexing completes. */
  readonly autoQueue: boolean;
  /** Start playing as soon as the queue is ready. */
  readonly autoPlay: boolean;
  /** A settings change being applied in the background, or null. */
  readonly update: SettingsUpdateState | null;
}

export const IDLE_PHASE: PhaseState = {
  status: 'idle',
  progress: 0,
  message: 'Not started',
  error: null,
};

export const INITIAL_PIPELINE_STATE: PipelineState = {
  index: IDLE_PHASE,
  queue: IDLE_PHASE,
  autoQueue: false,
  autoPlay: false,
  update: null,
};

/** Counters describing what happened since the process started. */
export interface SessionStats {
  readonly totalVideosIndexed: number;
  readonly preprocessedVideos: number;
  readonly preprocessingErrors: number;
  readonly lastIndexUpdate: IsoTimestamp | null;
  readonly videosPlayed: number;
  readonly videosSkippedByError: number;
  readonly videosSkippedManually: number;
  readonly videosReturnedToPrevious: number;
}

export const EMPTY_SESSION_STATS: SessionStats = {
  totalVideosIndexed: 0,
  preprocessedVideos: 0,
  preprocessingErrors: 0,
  lastIndexUpdate: null,
  videosPlayed: 0,
  videosSkippedByError: 0,
  videosSkippedManually: 0,
  videosReturnedToPrevious: 0,
};

export interface QueueGauge {
  readonly current: number;
  readonly target: number;
}

/** The small status payload clients poll while they wait to start. */
export interface ServiceStatus {
  readonly pipeline: PipelineState;
  readonly preprocessedQueue: QueueGauge;
  readonly isPreprocessing: boolean;
  readonly totalVideos: number;
  /**
   * Bumped each time a settings change swaps a fresh batch into the queue. A
   * client that sees it move keeps its next two videos and drops the rest,
   * which were chosen and transcoded under the old settings.
   */
  readonly queueGeneration: number;
  /** Bumped on every configuration reload, so a client knows to fetch it again. */
  readonly configRevision: number;
}

export interface HistoryGauge {
  readonly playback: QueueGauge;
  readonly persisted: QueueGauge;
}

/** The full diagnostic payload behind the debug overlay. */
export interface DetailedStats {
  readonly preprocessedQueue: QueueGauge;
  readonly playbackQueueTarget: number;
  readonly playbackQueueInitializationThreshold: number;
  readonly history: HistoryGauge;
  readonly indexUpdateInterval: number;
  readonly lastIndexUpdate: IsoTimestamp | null;
  /** Milliseconds until the next scheduled re-index, or null when unknown. */
  readonly timeUntilNextUpdate: number | null;
  readonly isPreprocessing: boolean;
  readonly session: SessionStats;
}
