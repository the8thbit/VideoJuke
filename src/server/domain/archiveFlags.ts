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
  /** The marked source paths, as one set that changes only when the list does. */
  readonly paths: () => ReadonlySet<string>;
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
 * What tells one list of marked videos from another: the archive list and the
 * favorites are the same kind of thing - a hand-made, unrecomputable list of
 * source files, written through on every change - kept in different files.
 */
export interface MarkedListKind {
  readonly file: string;
  /** The array's key in the file. */
  readonly listKey: string;
  /** For the log: "flagged for archiving", "added to favorites" and so on. */
  readonly added: string;
  readonly removed: string;
  readonly plural: string;
}

/**
 * The list of videos the viewer has asked to have moved out of the library.
 *
 * Unlike history or the queue, this is not state the application can rebuild, so
 * every change is written through to disk immediately rather than on a timer: a
 * viewer who flags three videos and then pulls the plug should still find three
 * videos in the file.
 */
export const createArchiveFlagsStore = (deps: ArchiveFlagsDeps): ArchiveFlagsStore =>
  createMarkedListStore(deps, {
    file: deps.paths.archiveFlagsFile,
    listKey: 'flagged',
    added: 'flagged for archiving',
    removed: 'unflagged from archiving',
    plural: 'videos flagged for archiving',
  });

/** The viewer's favorites, which selection gives an extra share of the picks. */
export const createFavoritesStore = (deps: ArchiveFlagsDeps): ArchiveFlagsStore =>
  createMarkedListStore(deps, {
    file: deps.paths.favoritesFile,
    listKey: 'favorites',
    added: 'added to favorites',
    removed: 'removed from favorites',
    plural: 'favorite videos',
  });

export const createMarkedListStore = (
  deps: ArchiveFlagsDeps,
  kind: MarkedListKind,
): ArchiveFlagsStore => {
  const { fileSystem, clock, logger, videoPaths } = deps;
  const file = kind.file;
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
  let pathSetSource: readonly ArchiveFlag[] | null = null;
  let pathSet: ReadonlySet<string> = new Set();

  const save = (): Promise<void> =>
    writes.run(async () => {
      // The load already refused to clear an unreadable file, on the grounds
      // that it records decisions nothing can reconstruct - and then the first
      // toggle wrote an empty list straight over it, because the store it saves
      // from is what the failed load left behind. Refusing here is what actually
      // keeps that promise.
      if (unreadable.get()) {
        logger.error(
          `not writing ${file}: it could not be read, and replacing it ` +
            'would discard what it holds. Fix the file, then try again.',
        );
        return;
      }

      const contents = toArchiveFlagsFile(clock.nowIso(), flags.get(), unrecognised.get());
      const body = { savedAt: contents.savedAt, [kind.listKey]: contents.flagged };
      const written = await fileSystem.writeJsonAtomically(file, body);
      if (!written.ok) {
        logger.error(`could not write ${file}`, written.error);
        return;
      }
      logger.debug(`${kind.plural} saved: ${contents.flagged.length}`);
    });

  const load = async (): Promise<void> => {
    if (!(await fileSystem.exists(file))) {
      logger.debug(`no ${kind.plural} yet`);
      return;
    }

    const contents = await fileSystem.readJson(file);
    if (!contents.ok) {
      // Deliberately not cleared: this file records a decision the viewer made
      // by hand, and overwriting an unreadable one would throw that away
      // silently. Starting empty is recoverable; deleting it is not.
      unreadable.set(true);
      logger.warn(`ignoring unreadable ${file}: ${contents.error.message}`);
      return;
    }

    unreadable.set(false);
    const { accepted, unrecognised: kept } = partitionArchiveFlags(
      readField(contents.value, kind.listKey),
      videoPaths,
    );
    flags.set(accepted);
    unrecognised.set(kept);
    logger.info(`loaded ${accepted.length} ${kind.plural}`);
    if (kept.length > 0) {
      logger.warn(
        `${kept.length} entries in ${file} name files outside the configured ` +
          'directories; they are kept, and count again once those directories are back',
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
      logger.info(`${video.filename} ${flagged ? kind.added : kind.removed}`);
      return flagged;
    },

    paths: () => {
      const current = flags.get();
      if (current !== pathSetSource) {
        pathSetSource = current;
        pathSet = new Set(current.map((flag) => String(flag.originalPath)));
      }
      return pathSet;
    },

    isFlagged: (originalPath) => flags.get().some((flag) => flag.originalPath === originalPath),
    list: () => flags.get(),
  };
};
