import { createSerialTask, createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import { asIsoTimestamp, asSourceVideoPath } from '../../shared/types/brand';
import type { Logger } from '../../shared/types/logging';
import type { ArchiveFlag, IndexedVideo } from '../../shared/types/video';
import { readArray, readField } from '../../shared/util/decode';
import { isPlainObject } from '../../shared/util/objects';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';
import type { VideoPathGuard } from './videoPaths';

/** The on-disk shape of `flagged_for_archive.json`. */
export interface ArchiveFlagsFile {
  readonly savedAt: string;
  readonly flagged: readonly ArchiveFlag[];
}

export interface ArchiveFlagsDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The list is a file a person may have edited, so its paths are checked. */
  readonly videoPaths: VideoPathGuard;
}

export interface ArchiveFlagsStore {
  readonly load: () => Promise<void>;
  /** Adds or removes the video, and resolves to whether it is now flagged. */
  readonly toggle: (video: IndexedVideo) => Promise<boolean>;
  readonly isFlagged: (originalPath: string) => boolean;
  readonly list: () => readonly ArchiveFlag[];
}

/**
 * Reads one entry, dropping anything that is not a flag for a real source file.
 *
 * The same rule the transports apply to a video record applies here: a path in
 * this file becomes a path `npm run archive` moves, so it has to name something
 * inside a directory the user actually configured.
 */
export const decodeArchiveFlag = (value: unknown, guard: VideoPathGuard): ArchiveFlag | null => {
  if (!isPlainObject(value)) return null;

  const originalPath = readField(value, 'originalPath');
  const filename = readField(value, 'filename');
  if (typeof originalPath !== 'string' || originalPath.trim() === '') return null;
  if (!guard.acceptsSource(originalPath)) return null;

  const flaggedAt = readField(value, 'flaggedAt');
  return {
    originalPath: asSourceVideoPath(originalPath),
    filename:
      typeof filename === 'string' && filename.trim() !== ''
        ? filename
        : originalPath.slice(Math.max(originalPath.lastIndexOf('/'), originalPath.lastIndexOf('\\')) + 1),
    flaggedAt: asIsoTimestamp(typeof flaggedAt === 'string' ? flaggedAt : ''),
  };
};

export const decodeArchiveFlags = (
  value: unknown,
  guard: VideoPathGuard,
): readonly ArchiveFlag[] => {
  const context = { path: '', report: () => undefined, at: () => context };
  return readArray(context, value, (_itemContext, item) => decodeArchiveFlag(item, guard), []);
};

/** Both halves of a read: what this run may act on, and what it must not lose. */
export interface PartitionedArchiveFlags {
  readonly accepted: readonly ArchiveFlag[];
  /**
   * Entries the decoder rejected, kept exactly as they were written.
   *
   * Rejection is not the same as invalidity. `acceptsSource` answers against the
   * directories configured *right now*, so a viewer who removes a drive from
   * config.json, or renames a share, turns every flag under it into an entry
   * this run cannot understand - and both writers rewrite the whole file. Kept
   * verbatim, they survive to be understood again when the directory comes back;
   * dropped, they are gone, and a flag is the one thing in this application that
   * nothing can recompute.
   */
  readonly unrecognised: readonly unknown[];
}

const pathOf = (value: unknown): string | null => {
  const path = readField(value, 'originalPath');
  return typeof path === 'string' ? path : null;
};

export const partitionArchiveFlags = (
  value: unknown,
  guard: VideoPathGuard,
): PartitionedArchiveFlags => {
  const accepted = decodeArchiveFlags(value, guard);
  if (!Array.isArray(value)) return { accepted, unrecognised: [] };

  const known = new Set(accepted.map((flag) => String(flag.originalPath)));
  const unrecognised = (value as readonly unknown[]).filter((entry) => {
    const path = pathOf(entry);
    return path === null || !known.has(path);
  });
  return { accepted, unrecognised };
};

/**
 * The file body, with the entries this run understood written back beside the
 * ones it did not. An accepted flag wins a collision, since it is the one that
 * has just been edited.
 */
export const toArchiveFlagsFile = (
  savedAt: string,
  accepted: readonly ArchiveFlag[],
  unrecognised: readonly unknown[],
): { readonly savedAt: string; readonly flagged: readonly unknown[] } => {
  const known = new Set(accepted.map((flag) => String(flag.originalPath)));
  const kept = unrecognised.filter((entry) => {
    const path = pathOf(entry);
    return path === null || !known.has(path);
  });
  return { savedAt, flagged: [...accepted, ...kept] };
};

/**
 * The list of videos the viewer has asked to have moved out of the library.
 *
 * Unlike history or the queue, this is not state the application can rebuild, so
 * every change is written through to disk immediately rather than on a timer: a
 * viewer who flags three videos and then pulls the plug should still find three
 * videos in the file.
 */
export const createArchiveFlagsStore = (deps: ArchiveFlagsDeps): ArchiveFlagsStore => {
  const { fileSystem, paths, clock, logger, videoPaths } = deps;
  const flags = createStore<readonly ArchiveFlag[]>([]);
  /** Entries the last load could not use; written back untouched. */
  const unrecognised = createStore<readonly unknown[]>([]);
  /**
   * Set when the file exists but could not be parsed at all, which is the one
   * case nothing can be preserved from - so nothing may be written over it
   * either.
   */
  const unreadable = createStore(false);
  // Writes are queued rather than skipped: a viewer holding the key down must
  // not have the last toggle overtake the one before it on the way to disk.
  const writes = createSerialTask();

  const save = (): Promise<void> =>
    writes.run(async () => {
      // The load already refused to clear an unreadable file, on the grounds
      // that it records decisions nothing can reconstruct - and then the first
      // toggle wrote an empty list straight over it, because the store it saves
      // from is what the failed load left behind. Refusing here is what actually
      // keeps that promise.
      if (unreadable.get()) {
        logger.error(
          `not writing ${paths.archiveFlagsFile}: it could not be read, and replacing it ` +
            'would discard the flags it holds. Fix the file, then flag the video again.',
        );
        return;
      }

      const file = toArchiveFlagsFile(clock.nowIso(), flags.get(), unrecognised.get());
      const written = await fileSystem.writeJsonAtomically(paths.archiveFlagsFile, file);
      if (!written.ok) {
        logger.error(`could not write ${paths.archiveFlagsFile}`, written.error);
        return;
      }
      logger.debug(`archive list saved: ${file.flagged.length} videos`);
    });

  const load = async (): Promise<void> => {
    if (!(await fileSystem.exists(paths.archiveFlagsFile))) {
      logger.debug('no archive list yet');
      return;
    }

    const contents = await fileSystem.readJson(paths.archiveFlagsFile);
    if (!contents.ok) {
      // Deliberately not cleared: this file records a decision the viewer made
      // by hand, and overwriting an unreadable one would throw that away
      // silently. Starting empty is recoverable; deleting it is not.
      unreadable.set(true);
      logger.warn(`ignoring unreadable ${paths.archiveFlagsFile}: ${contents.error.message}`);
      return;
    }

    unreadable.set(false);
    const { accepted, unrecognised: kept } = partitionArchiveFlags(
      readField(contents.value, 'flagged'),
      videoPaths,
    );
    flags.set(accepted);
    unrecognised.set(kept);
    logger.info(`loaded ${accepted.length} videos flagged for archiving`);
    if (kept.length > 0) {
      logger.warn(
        `${kept.length} entries in ${paths.archiveFlagsFile} name files outside the configured ` +
          'directories; they are kept but cannot be archived until those directories are back',
      );
    }
  };

  return {
    load,

    toggle: async (video) => {
      const path = String(video.originalPath);
      const present = flags.get().some((flag) => flag.originalPath === path);

      flags.set(
        present
          ? flags.get().filter((flag) => flag.originalPath !== path)
          : [
              ...flags.get(),
              {
                originalPath: video.originalPath,
                filename: video.filename,
                flaggedAt: clock.nowIso(),
              },
            ],
      );

      await save();
      const flagged = !present;
      logger.info(`${video.filename} ${flagged ? 'flagged for' : 'unflagged from'} archiving`);
      return flagged;
    },

    isFlagged: (originalPath) => flags.get().some((flag) => flag.originalPath === originalPath),
    list: () => flags.get(),
  };
};
