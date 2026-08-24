import { computeConfigHash } from '../../shared/config/hash';
import type { Clock } from '../../shared/time/clock';
import { asIsoTimestamp, type IsoTimestamp } from '../../shared/types/brand';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import type { PreprocessedVideo } from '../../shared/types/video';
import { readField } from '../../shared/util/decode';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';
import { directoryOf, fileNameOf } from './pathText';
import { isTranscodeFileName, withUncheckedProcessed, type VideoPathGuard } from './videoPaths';
import { decodePreprocessedVideoList } from './videoRecords';

/**
 * How long an unreferenced temp file is left alone. ffmpeg may still be writing
 * a file that no queue mentions yet, so the grace period is what stops cleanup
 * from deleting a transcode out from under the job that is producing it.
 */
export const TEMP_FILE_MAX_AGE_MS = 3600000;

/**
 * The saved queue, and also the on-disk shape. Unlike the history file this one
 * does not keep the legacy spelling: the fingerprint is computed from different
 * inputs than the old `configHash`, so every previously written file is
 * discarded on the first run regardless and there is nothing to stay
 * compatible with.
 */
export interface QueueStateSnapshot {
  readonly savedAt: IsoTimestamp;
  readonly fingerprint: string;
  readonly queued: readonly PreprocessedVideo[];
  readonly recentHistory: readonly PreprocessedVideo[];
}

export interface QueuePersistenceDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: () => AppConfig;
  readonly digest: (input: string) => string;
  /** The saved file is untrusted input: a previous run may have been fed paths. */
  readonly videoPaths: VideoPathGuard;
}

export interface QueuePersistence {
  readonly save: (snapshot: {
    readonly queued: readonly PreprocessedVideo[];
    readonly recentHistory: readonly PreprocessedVideo[];
  }) => Promise<void>;
  readonly load: () => Promise<QueueStateSnapshot | null>;
  readonly clear: () => Promise<void>;
  /** Returns how many stale files were removed from the temp directory. */
  readonly cleanupTempDirectory: (protectedPaths: ReadonlySet<string>) => Promise<number>;
}

/** What {@link ensureCacheDirectory} needs, which every cache-backed store has. */
export interface CacheDirectoryDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly logger: Logger;
}

/**
 * Creates the cache directory on the way into a read or a write, so a user who
 * deletes it mid-session does not have to restart. Shared so that every store
 * writing into that directory reports the same failure once, at the same level.
 */
export const ensureCacheDirectory = async (deps: CacheDirectoryDeps): Promise<boolean> => {
  const created = await deps.fileSystem.ensureDirectory(deps.paths.cacheDirectory);
  if (created.ok) return true;
  deps.logger.error(`Cannot create cache directory ${deps.paths.cacheDirectory}`, created.error);
  return false;
};

const readTextField = (value: unknown, key: string): string | null => {
  const field = readField(value, key);
  return typeof field === 'string' ? field : null;
};

export const createQueuePersistence = (deps: QueuePersistenceDeps): QueuePersistence => {
  const { fileSystem, paths, clock, logger, config, digest, videoPaths } = deps;

  const fingerprintOfConfig = (): string => computeConfigHash(config(), digest);

  const clear = async (): Promise<void> => {
    const removed = await fileSystem.remove(paths.queueStateFile);
    if (!removed.ok) {
      logger.warn(`Failed to clear saved queue state: ${removed.error.message}`);
      return;
    }
    if (removed.value) logger.debug('Cleared saved queue state');
  };

  /**
   * Keeps only the entries that can still be played. A transcode whose source
   * has been deleted or moved can never be matched to it again, so the orphan
   * is removed here rather than waiting an hour for the temp sweep.
   *
   * "Gone" has to be proved, not assumed. `exists` answers false for a file that
   * was deleted and for a whole volume that is not mounted yet, and a library on
   * a share the machine has not finished reconnecting to reads as every source
   * having vanished at once. Deleting on that reading destroyed every transcode
   * the previous run produced, in the seconds before the share came back -
   * exactly what `refreshIndex` refuses to do for the same reason. So the
   * containing directory is consulted first: an unreadable one means the answer
   * is unknown, and an unknown answer keeps the file.
   */
  const retainPlayable = async (
    videos: readonly PreprocessedVideo[],
  ): Promise<readonly PreprocessedVideo[]> => {
    const kept: PreprocessedVideo[] = [];
    // One check per directory rather than per video: a queue is typically dozens
    // of entries drawn from a handful of folders.
    const reachableDirectories = new Map<string, boolean>();

    const sourceDirectoryIsReachable = async (path: string): Promise<boolean> => {
      const directory = directoryOf(path);
      const known = reachableDirectories.get(directory);
      if (known !== undefined) return known;
      const reachable = await fileSystem.exists(directory);
      reachableDirectories.set(directory, reachable);
      return reachable;
    };

    for (const video of videos) {
      const originalExists = await fileSystem.exists(video.originalPath);
      const processedExists = await fileSystem.exists(video.processedPath);

      if (originalExists && processedExists) {
        kept.push(video);
        continue;
      }

      // Only ever inside the temp directory. This is the one place that deletes
      // a file named by a record rather than by this process, so it is the last
      // line of defence if a path ever reaches the saved state that should not
      // have; it also stops a history entry written under an older
      // `system.tempDirectory` from having that old transcode deleted.
      if (processedExists && !originalExists && videoPaths.acceptsProcessed(video.processedPath)) {
        if (await sourceDirectoryIsReachable(video.originalPath)) {
          const removed = await fileSystem.remove(video.processedPath);
          if (!removed.ok) {
            logger.warn(
              `Failed to remove orphaned transcode of ${video.filename}: ${removed.error.message}`,
            );
          }
        } else {
          // Kept, but still dropped from the restored queue: the entry cannot be
          // re-transcoded while the source is out of reach, and the temp sweep
          // collects the file in an hour if the source never comes back.
          logger.warn(
            `Keeping the transcode of ${video.filename}: ` +
              `${directoryOf(video.originalPath)} cannot be read, so the source may only be offline`,
          );
        }
      }
      logger.debug(`Dropping ${video.filename}: source or transcode is missing`);
    }

    return kept;
  };

  const save = async (snapshot: {
    readonly queued: readonly PreprocessedVideo[];
    readonly recentHistory: readonly PreprocessedVideo[];
  }): Promise<void> => {
    if (!(await ensureCacheDirectory(deps))) return;

    const state: QueueStateSnapshot = {
      savedAt: clock.nowIso(),
      fingerprint: fingerprintOfConfig(),
      queued: snapshot.queued,
      recentHistory: snapshot.recentHistory,
    };

    const result = await fileSystem.writeJsonAtomically(paths.queueStateFile, state);
    if (!result.ok) {
      logger.error('Failed to save queue state', result.error);
      return;
    }
    logger.debug(
      `Saved queue state: ${state.queued.length} queued, ${state.recentHistory.length} history`,
    );
  };

  const load = async (): Promise<QueueStateSnapshot | null> => {
    if (!(await ensureCacheDirectory(deps))) return null;

    if (!(await fileSystem.exists(paths.queueStateFile))) {
      logger.info('No saved queue state found, starting fresh');
      return null;
    }

    const contents = await fileSystem.readJson(paths.queueStateFile);
    if (!contents.ok) {
      logger.warn(`Discarding unreadable queue state: ${contents.error.message}`);
      await clear();
      return null;
    }

    // Settings that decide what the index holds also decide what the queue may
    // contain, so a changed fingerprint makes every saved entry suspect.
    const fingerprint = readTextField(contents.value, 'fingerprint');
    if (fingerprint === null || fingerprint !== fingerprintOfConfig()) {
      logger.info('Configuration changed, discarding saved queue state');
      await clear();
      return null;
    }

    const savedAt = readTextField(contents.value, 'savedAt');
    // The queue is strict: an entry whose transcode is not in the temp directory
    // cannot be streamed anyway, and dropping it only costs one re-encode.
    const queued = await retainPlayable(
      decodePreprocessedVideoList(readField(contents.value, 'queued'), videoPaths),
    );
    // History is not: see `withUncheckedProcessed`.
    const recentHistory = await retainPlayable(
      decodePreprocessedVideoList(
        readField(contents.value, 'recentHistory'),
        withUncheckedProcessed(videoPaths),
      ),
    );

    logger.info(
      `Restored ${queued.length} queued videos and ${recentHistory.length} history entries`,
    );
    return {
      savedAt: savedAt === null ? clock.nowIso() : asIsoTimestamp(savedAt),
      fingerprint,
      queued,
      recentHistory,
    };
  };

  const cleanupTempDirectory = async (protectedPaths: ReadonlySet<string>): Promise<number> => {
    if (!(await fileSystem.exists(paths.tempDirectory))) return 0;

    const listed = await fileSystem.listFiles(paths.tempDirectory);
    if (!listed.ok) {
      logger.warn(`Cannot read temp directory ${paths.tempDirectory}: ${listed.error.message}`);
      return 0;
    }

    // Names, not paths: a queue entry and the file on disk can spell the same
    // location differently once a config change moves the temp directory.
    const protectedNames = new Set<string>();
    protectedPaths.forEach((path) => protectedNames.add(fileNameOf(path)));

    const now = clock.now();
    let removedCount = 0;

    for (const filePath of listed.value) {
      const name = fileNameOf(filePath);
      // Only files this application wrote. Anything else in the temp directory
      // belongs to whoever put it there.
      if (!isTranscodeFileName(name)) continue;
      if (protectedNames.has(name)) continue;

      const stats = await fileSystem.stat(filePath);
      if (!stats.ok) {
        logger.debug(`Skipping ${name}: ${stats.error.message}`);
        continue;
      }
      if (now - stats.value.modifiedAtMs <= TEMP_FILE_MAX_AGE_MS) continue;

      const removed = await fileSystem.remove(filePath);
      if (!removed.ok) {
        logger.debug(`Failed to remove ${name}: ${removed.error.message}`);
        continue;
      }
      if (removed.value) removedCount += 1;
    }

    if (removedCount > 0) logger.info(`Removed ${removedCount} stale temp files`);
    return removedCount;
  };

  return { save, load, clear, cleanupTempDirectory };
};
