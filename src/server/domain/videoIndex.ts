import { computeConfigHash } from '../../shared/config/hash';
import type { SeasonalCandidate } from '../../shared/queue/selection';
import { selectVideo } from '../../shared/queue/selection';
import { createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import { describeTimeFacts } from '../../shared/time/timeConditions';
import type { IsoTimestamp } from '../../shared/types/brand';
import { asIsoTimestamp, asSourceVideoPath } from '../../shared/types/brand';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import type { IndexedVideo } from '../../shared/types/video';
import type { RandomSource } from '../../shared/util/arrays';
import { sumBy, uniqueBy } from '../../shared/util/arrays';
import { ratio } from '../../shared/util/numbers';
import { isPlainObject, readProperty } from '../../shared/util/objects';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';
import { directoryOf, fileNameOf } from './pathText';
import { isPathInside, type VideoPathGuard } from './videoPaths';

/**
 * One complete scan. The fingerprint is the config hash the scan was made
 * against, which is the whole staleness check: the legacy build stored that
 * hash in `system.lastConfigHash` inside the user's own config file, so a cache
 * and the config that produced it could drift apart independently.
 */
export interface VideoIndexSnapshot {
  readonly fingerprint: string;
  readonly builtAt: IsoTimestamp;
  readonly regular: readonly IndexedVideo[];
  /** Seasonal videos keyed by the configured directory they came from. */
  readonly seasonal: Readonly<Record<string, readonly IndexedVideo[]>>;
}

export interface ScanProgress {
  /** Completion in the range 0..1. */
  readonly progress: number;
  readonly message: string;
}

/**
 * A scan that could not read everything it was asked to.
 *
 * The distinction matters twice over: a partial scan must not be written to the
 * cache as the authoritative index, and the session must not read a drop in the
 * count as "the user deleted their videos" when the truth is that a drive was
 * briefly unavailable.
 */
export interface ScanOutcome {
  readonly snapshot: VideoIndexSnapshot;
  readonly complete: boolean;
}

export interface VideoIndexDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly random: RandomSource;
  readonly digest: (input: string) => string;
  /** Read on demand so a config reload is picked up without rewiring. */
  readonly config: () => AppConfig;
  /** Applied to the cache file, which is untrusted input like any other. */
  readonly videoPaths: VideoPathGuard;
}

export interface VideoIndex {
  /** Restores the cache; false when there was nothing usable to restore. */
  readonly load: () => Promise<boolean>;
  readonly needsRebuild: () => boolean;
  readonly rebuild: (onProgress?: (progress: ScanProgress) => void) => Promise<ScanOutcome>;
  readonly snapshot: () => VideoIndexSnapshot;
  readonly count: () => number;
  readonly selectVideo: (excludedPaths: ReadonlySet<string>) => IndexedVideo | null;
}

/**
 * Extension test against the configured list, compared case-insensitively.
 * The legacy helper fell back to a mime-types lookup when the extension was not
 * listed, which quietly indexed whatever that package happened to know about;
 * the configurable list already covers every format it recognised.
 */
export const isSupportedVideoFile = (path: string, extensions: readonly string[]): boolean => {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  // Index 0 is a dotfile such as `.keep`, which has a name but no extension.
  if (dot <= 0) return false;

  const extension = name.slice(dot).toLowerCase();
  return extensions.some((candidate) => candidate.toLowerCase() === extension);
};

const readNonEmptyText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Reads one cached record, and checks its path like any other untrusted one.
 *
 * The cache is a file an earlier run wrote, not something this process produced,
 * and `originalPath` out of it is fed straight to ffmpeg and then streamed. Every
 * other reader of a cache file - the queue, the history, the archive list - puts
 * its records through `VideoPathGuard`; this was the one that did not, which
 * made it the only way a record naming a file outside the configured library
 * could reach the selection pool. Its own fingerprint is not that check: the
 * hash is over the configuration, so anything able to write the cache can write
 * a matching one too.
 */
const decodeIndexedVideo = (value: unknown, guard: VideoPathGuard): IndexedVideo | null => {
  const originalPath = readNonEmptyText(readProperty(value, 'originalPath'));
  const filename = readNonEmptyText(readProperty(value, 'filename'));
  const directory = readNonEmptyText(readProperty(value, 'directory'));
  const addedAt = readNonEmptyText(readProperty(value, 'addedAt'));
  if (originalPath === null || filename === null || directory === null || addedAt === null) {
    return null;
  }
  if (!guard.acceptsSource(originalPath)) return null;

  const seasonalDirectory = readProperty(value, 'seasonalDirectory');
  return {
    originalPath: asSourceVideoPath(originalPath),
    filename,
    directory,
    addedAt: asIsoTimestamp(addedAt),
    seasonalDirectory: typeof seasonalDirectory === 'string' ? seasonalDirectory : null,
  };
};

/** Drops individual unreadable entries; the cache is rebuilt often enough. */
const decodeIndexedVideos = (
  value: unknown,
  guard: VideoPathGuard,
): readonly IndexedVideo[] | null => {
  if (!Array.isArray(value)) return null;

  const videos: IndexedVideo[] = [];
  for (const item of value as readonly unknown[]) {
    const video = decodeIndexedVideo(item, guard);
    if (video !== null) videos.push(video);
  }
  return videos;
};

/**
 * Reads the cache file. Returns null for anything that is not recognisably a
 * snapshot, which the caller treats as "no cache" and rebuilds from scratch.
 */
export const decodeIndexSnapshot = (
  value: unknown,
  guard: VideoPathGuard,
): VideoIndexSnapshot | null => {
  if (!isPlainObject(value)) return null;

  const fingerprint = readProperty(value, 'fingerprint');
  const builtAt = readNonEmptyText(readProperty(value, 'builtAt'));
  if (typeof fingerprint !== 'string' || builtAt === null) return null;

  const regular = decodeIndexedVideos(readProperty(value, 'regular'), guard);
  const rawSeasonal = readProperty(value, 'seasonal');
  if (regular === null || !isPlainObject(rawSeasonal)) return null;

  const seasonal: Record<string, readonly IndexedVideo[]> = {};
  for (const directory of Object.keys(rawSeasonal)) {
    const videos = decodeIndexedVideos(rawSeasonal[directory], guard);
    if (videos !== null) seasonal[directory] = videos;
  }

  return { fingerprint, builtAt: asIsoTimestamp(builtAt), regular, seasonal };
};

/**
 * The state before anything is loaded. Its fingerprint matches no real config
 * hash, so a service that has not loaded a cache always needs a rebuild.
 */
const emptySnapshot = (builtAt: IsoTimestamp): VideoIndexSnapshot => ({
  fingerprint: '',
  builtAt,
  regular: [],
  seasonal: {},
});

const countSeasonal = (snapshot: VideoIndexSnapshot): number =>
  sumBy(Object.values(snapshot.seasonal), (videos) => videos.length);

const countVideos = (snapshot: VideoIndexSnapshot): number =>
  snapshot.regular.length + countSeasonal(snapshot);

export const createVideoIndex = (deps: VideoIndexDeps): VideoIndex => {
  const { fileSystem, paths, clock, logger, config } = deps;
  const state = createStore<VideoIndexSnapshot>(emptySnapshot(clock.nowIso()));

  const load = async (): Promise<boolean> => {
    if (!(await fileSystem.exists(paths.videoIndexFile))) {
      logger.info('no cached video index found');
      return false;
    }

    const read = await fileSystem.readJson(paths.videoIndexFile);
    if (!read.ok) {
      logger.warn(`could not read ${paths.videoIndexFile}: ${read.error.message}`);
      return false;
    }

    const snapshot = decodeIndexSnapshot(read.value, deps.videoPaths);
    if (snapshot === null) {
      logger.warn(`ignoring the malformed video index cache at ${paths.videoIndexFile}`);
      return false;
    }

    state.set(snapshot);
    logger.info(
      `loaded the video index cache: ${snapshot.regular.length} videos and ` +
        `${countSeasonal(snapshot)} seasonal videos in ` +
        `${Object.keys(snapshot.seasonal).length} directories, built ${snapshot.builtAt}`,
    );
    return true;
  };

  const needsRebuild = (): boolean =>
    state.get().fingerprint !== computeConfigHash(config(), deps.digest);

  const save = async (snapshot: VideoIndexSnapshot): Promise<void> => {
    const directory = await fileSystem.ensureDirectory(paths.cacheDirectory);
    if (!directory.ok) {
      logger.warn(`could not create ${paths.cacheDirectory}: ${directory.error.message}`);
      return;
    }

    const written = await fileSystem.writeJsonAtomically(paths.videoIndexFile, snapshot);
    if (!written.ok) {
      logger.warn(`could not save ${paths.videoIndexFile}: ${written.error.message}`);
      return;
    }
    logger.debug(`saved the video index cache to ${paths.videoIndexFile}`);
  };

  const toIndexedVideo = (path: string, seasonalDirectory: string | null): IndexedVideo => ({
    originalPath: asSourceVideoPath(path),
    filename: fileNameOf(path),
    directory: directoryOf(path),
    addedAt: clock.nowIso(),
    seasonalDirectory,
  });

  /**
   * A directory that is missing or unreadable is a warning and an empty result,
   * never an aborted build: one unplugged drive must not cost the user every
   * other library they have configured.
   */
  const scanDirectory = async (
    directory: string,
    seasonalDirectory: string | null,
    extensions: readonly string[],
  ): Promise<{ readonly videos: readonly IndexedVideo[]; readonly complete: boolean }> => {
    if (!(await fileSystem.exists(directory))) {
      logger.warn(`skipping ${directory}: the directory does not exist`);
      return { videos: [], complete: false };
    }

    const listed = await fileSystem.listFilesRecursively(directory);
    if (!listed.ok) {
      logger.warn(`skipping ${directory}: ${listed.error.message}`);
      return { videos: [], complete: false };
    }

    const videos: IndexedVideo[] = [];
    for (const file of listed.value.files) {
      if (!isSupportedVideoFile(file, extensions)) continue;
      logger.debug(`indexed ${file}`);
      videos.push(toIndexedVideo(file, seasonalDirectory));
    }

    for (const skipped of listed.value.unreadable) {
      logger.warn(`could not read ${skipped}; its videos are missing from this scan`);
    }

    logger.info(`found ${videos.length} videos in ${directory}`);
    return { videos, complete: listed.value.unreadable.length === 0 };
  };

  const rebuild = async (onProgress?: (progress: ScanProgress) => void): Promise<ScanOutcome> => {
    // One config value for the whole scan, so a reload part-way through cannot
    // produce a snapshot that half of the fingerprint describes.
    const current = config();
    const extensions = current.files.supportedVideoExtensions;
    const directories = uniqueBy(current.directories, (directory) => directory);
    const seasonalDirectories = uniqueBy(
      current.seasonalDirectories.map((entry) => entry.directory),
      (directory) => directory,
    );
    const total = directories.length + seasonalDirectories.length;

    logger.info(
      `building the video index from ${directories.length} directories and ` +
        `${seasonalDirectories.length} seasonal directories`,
    );

    const report = (progress: number, message: string): void => {
      onProgress?.({ progress, message });
    };

    const regular: IndexedVideo[] = [];
    const seasonal: Record<string, readonly IndexedVideo[]> = {};
    let scanned = 0;
    let complete = true;

    /**
     * A seasonal directory is very often a subfolder of a library - `X:/videos`
     * with `X:/videos/christmas` inside it is the obvious way to arrange this.
     * The recursive scan of the library therefore also finds those files, and
     * they landed in the regular pool as well as the seasonal one, where no time
     * condition applies to them: the December folder played in July, through the
     * very pool the gate was supposed to keep it out of.
     */
    const isSeasonal = (path: string): boolean =>
      seasonalDirectories.some((directory) => isPathInside(directory, path));

    /**
     * The archive is where videos go to stop coming round again, so it is never
     * indexed - not even when the user has put it inside a source directory,
     * which is the obvious place to put it and would otherwise mean an archived
     * video was picked up again by the very next scan.
     */
    const isArchived = (path: string): boolean => isPathInside(paths.archiveDirectory, path);

    for (const directory of directories) {
      report(ratio(scanned, total), `Scanning: ${fileNameOf(directory)}`);
      const result = await scanDirectory(directory, null, extensions);
      complete = complete && result.complete;
      // Appended one at a time because spreading a directory holding tens of
      // thousands of files into push() overflows the argument stack.
      for (const video of result.videos) {
        if (isArchived(video.originalPath) || isSeasonal(video.originalPath)) continue;
        regular.push(video);
      }
      scanned += 1;
    }

    for (const directory of seasonalDirectories) {
      report(ratio(scanned, total), `Scanning: ${fileNameOf(directory)}`);
      const result = await scanDirectory(directory, directory, extensions);
      complete = complete && result.complete;
      seasonal[directory] = result.videos.filter((entry) => !isArchived(entry.originalPath));
      scanned += 1;
    }

    const snapshot: VideoIndexSnapshot = {
      fingerprint: computeConfigHash(current, deps.digest),
      builtAt: clock.nowIso(),
      regular,
      seasonal,
    };

    state.set(snapshot);
    // Deliberately not cached when a directory could not be read: the file on
    // disk is the answer a later start trusts without re-scanning, and half a
    // library is the wrong answer to give it. The in-memory state still takes
    // the partial scan, because playing the videos we did find beats playing
    // none of them.
    if (complete) await save(snapshot);
    else logger.warn('the scan was incomplete; keeping the previous index cache on disk');

    const indexed = countVideos(snapshot);
    logger.info(`video index built: ${indexed} videos`);
    report(1, `Indexed ${indexed} videos`);
    return { snapshot, complete };
  };

  const pickVideo = (excludedPaths: ReadonlySet<string>): IndexedVideo | null => {
    const snapshot = state.get();
    const facts = clock.localFacts();
    const candidates: readonly SeasonalCandidate[] = config().seasonalDirectories.map((entry) => ({
      directory: entry.directory,
      likelihood: entry.likelihood,
      conditions: entry.conditions,
      videos: snapshot.seasonal[entry.directory] ?? [],
    }));

    const outcome = selectVideo({
      regular: snapshot.regular,
      seasonal: candidates,
      excludedPaths,
      facts,
      random: deps.random,
    });

    // The legacy build printed the entire time-condition evaluation at info
    // level on every single selection. The facts only answer a real question -
    // why did or did not the seasonal folder fire - so they are attached only
    // when a seasonal directory was in the running, and only at debug.
    const when = candidates.length === 0 ? '' : ` - ${describeTimeFacts(facts)}`;

    if (outcome.kind === 'seasonal') {
      logger.debug(`selected ${outcome.video.filename} from ${outcome.directory}${when}`);
      return outcome.video;
    }
    if (outcome.kind === 'regular') {
      logger.debug(`selected ${outcome.video.filename}${when}`);
      return outcome.video;
    }

    logger.debug(`selected nothing: ${outcome.reason}${when}`);
    return null;
  };

  return {
    load,
    needsRebuild,
    rebuild,
    snapshot: state.get,
    count: () => countVideos(state.get()),
    selectVideo: pickVideo,
  };
};
