import {
  EMPTY_HISTORY,
  historyGauges,
  recordPlayed as applyPlayed,
  takePrevious as popPrevious,
  trimHistory,
  type HistoryLimits,
} from '../../shared/queue/history';
import { createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import type { HistoryGauge } from '../../shared/types/status';
import type { PreprocessedVideo } from '../../shared/types/video';
import { readField } from '../../shared/util/decode';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';
import { ensureCacheDirectory } from './queuePersistence';
import { withUncheckedProcessed, type VideoPathGuard } from './videoPaths';
import { decodePreprocessedVideoList } from './videoRecords';

export interface HistoryStoreDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Read on every transition so a reloaded config changes the limits at once. */
  readonly config: () => AppConfig;
  /** The saved file is untrusted input, exactly as the queue state file is. */
  readonly videoPaths: VideoPathGuard;
}

export interface HistoryStore {
  readonly load: () => Promise<void>;
  readonly save: () => Promise<void>;
  readonly recordPlayed: (video: PreprocessedVideo) => void;
  readonly takePrevious: () => PreprocessedVideo | null;
  readonly recent: () => readonly PreprocessedVideo[];
  readonly gauges: () => HistoryGauge;
  readonly restoreRecent: (videos: readonly PreprocessedVideo[]) => void;
}

/** The on-disk shape, unchanged from the legacy file so existing caches load. */
interface PersistedHistoryFile {
  readonly savedAt: string;
  readonly persistedHistory: readonly PreprocessedVideo[];
}

export const createHistoryStore = (deps: HistoryStoreDeps): HistoryStore => {
  const { fileSystem, paths, clock, logger, config } = deps;

  const history = createStore(EMPTY_HISTORY);

  /**
   * What the last successful write put on disk. Every transition returns fresh
   * arrays, so comparing identity with the live list is an exact "has anything
   * happened since?" test and needs no dirty flag of its own.
   */
  const written = createStore<readonly PreprocessedVideo[]>(EMPTY_HISTORY.persisted);

  const limits = (): HistoryLimits => {
    const video = config().video;
    return {
      recentLimit: video.playbackHistorySize,
      persistedLimit: video.persistedHistorySize,
    };
  };

  const load = async (): Promise<void> => {
    if (!(await ensureCacheDirectory(deps))) return;

    if (!(await fileSystem.exists(paths.historyFile))) {
      logger.info('No persisted history found, starting fresh');
      return;
    }

    const contents = await fileSystem.readJson(paths.historyFile);
    if (!contents.ok) {
      logger.warn(`Ignoring unreadable history file: ${contents.error.message}`);
      return;
    }

    const persisted = decodePreprocessedVideoList(
      readField(contents.value, 'persistedHistory'),
      // Lenient about the transcode: a history entry whose temp file has moved
      // or gone is still a video the user watched, and `ensurePlayable` rebuilds
      // the transcode from the source when they step back to it.
      withUncheckedProcessed(deps.videoPaths),
    );
    const restored = history.update((previous) =>
      trimHistory({ recent: previous.recent, persisted }, limits()),
    );
    // The file and the state now agree, so an immediate save has nothing to do.
    written.set(restored.persisted);
    logger.info(`Loaded ${restored.persisted.length} persisted history entries`);
  };

  const save = async (): Promise<void> => {
    const persisted = history.get().persisted;
    if (persisted === written.get()) return;
    if (!(await ensureCacheDirectory(deps))) return;

    const file: PersistedHistoryFile = { savedAt: clock.nowIso(), persistedHistory: persisted };
    const result = await fileSystem.writeJsonAtomically(paths.historyFile, file);
    if (!result.ok) {
      logger.error('Failed to save persisted history', result.error);
      return;
    }

    written.set(persisted);
    logger.debug(`Saved ${persisted.length} persisted history entries`);
  };

  return {
    load,
    save,

    /**
     * Marks the state dirty without touching the disk. The legacy manager fired
     * `setImmediate(save)` here, which meant a full rewrite of a 5000-entry
     * file every time a video started; the session now saves on a timer and at
     * shutdown instead.
     */
    recordPlayed: (video) => {
      history.update((previous) => applyPlayed(previous, video, limits()));
      logger.debug(`Recorded in history: ${video.filename}`);
    },

    takePrevious: () => {
      const { video, state } = popPrevious(history.get());
      history.set(state);
      if (video === null) {
        logger.debug('No previous video in history');
        return null;
      }
      logger.debug(`Took previous from history: ${video.filename}`);
      return video;
    },

    recent: () => history.get().recent,

    gauges: () => historyGauges(history.get(), limits()),

    restoreRecent: (videos) => {
      const restored = history.update((previous) =>
        trimHistory({ recent: videos, persisted: previous.persisted }, limits()),
      );
      logger.info(`Restored ${restored.recent.length} recent history entries`);
    },
  };
};
