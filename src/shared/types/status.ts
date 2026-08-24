import type { IsoTimestamp } from './brand';

export type InitializationStage =
  | 'idle'
  | 'loading-config'
  | 'building-index'
  | 'restoring-queue'
  | 'preprocessing'
  | 'retrying'
  | 'ready'
  | 'error';

export interface InitializationState {
  readonly stage: InitializationStage;
  /** Completion in the range 0..1. */
  readonly progress: number;
  readonly message: string;
  readonly error: string | null;
}

export const INITIAL_INITIALIZATION_STATE: InitializationState = {
  stage: 'idle',
  progress: 0,
  message: 'Waiting to start...',
  error: null,
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
  readonly initialization: InitializationState;
  readonly preprocessedQueue: QueueGauge;
  readonly isPreprocessing: boolean;
  readonly totalVideos: number;
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
