import { computeConfigHash } from '../../shared/config/hash';
import { createLengthWeight, toLengthRange, type LengthWeight } from '../../shared/queue/lengthBias';
import type { DirectoryCandidate, SeasonalCandidate } from '../../shared/queue/selection';
import { selectVideo } from '../../shared/queue/selection';
import { createStore } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import { describeTimeFacts } from '../../shared/time/timeConditions';
import type { IsoTimestamp } from '../../shared/types/brand';
import { asIsoTimestamp, asSourceVideoPath } from '../../shared/types/brand';
import {
  directoryPaths,
  type AppConfig,
  type DirectoryConfig,
  type LengthBiasConfig,
} from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import { ok, type Result } from '../../shared/types/result';
import type { IndexedVideo } from '../../shared/types/video';
import type { RandomSource } from '../../shared/util/arrays';
import { sumBy, uniqueBy } from '../../shared/util/arrays';
import { ratio } from '../../shared/util/numbers';
import { isFiniteNumber } from '../../shared/util/numbers';
import { isPlainObject, readProperty } from '../../shared/util/objects';
import { indexedExtensions, isImagePath } from '../../shared/video/mediaKind';
import type { DirectoryListing, FileSystem } from '../infra/fileSystem';
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
  /**
   * Measured lengths in seconds, keyed by source path, for the length bias.
   *
   * Absent means never measured; null means measured and unreadable, which is
   * remembered so that a broken file is not re-probed - against a minute-long
   * probe timeout - on every re-scan. Kept beside the videos rather than on
   * them, because `IndexedVideo` travels to every client inside each queued
   * record and a length is of no use to any of them.
   */
  readonly durations: Readonly<Record<string, number | null>>;
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
  /**
   * The length of one source file in seconds, or null when it cannot be read.
   * Only consulted while the length bias is on.
   */
  readonly measureDuration: (path: string) => Promise<number | null>;
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
  /** Whether the length bias is on and some indexed video has no measured length. */
  readonly needsMeasurement: () => boolean;
  /** Measures every video that has no length yet, without re-scanning. */
  readonly measure: (onProgress?: (progress: ScanProgress) => void) => Promise<void>;
  readonly snapshot: () => VideoIndexSnapshot;
  readonly count: () => number;
  readonly selectVideo: (excludedPaths: ReadonlySet<string>) => IndexedVideo | null;
  /** Empties the index and deletes its cache file. */
  readonly clear: () => Promise<void>;
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
 * Reads the measured lengths. A cache written before lengths were measured has
 * none, which is simply "nothing measured yet", not a reason to re-scan.
 */
const decodeDurations = (value: unknown): Record<string, number | null> => {
  const durations: Record<string, number | null> = {};
  if (!isPlainObject(value)) return durations;
  for (const path of Object.keys(value)) {
    const duration = value[path];
    if (duration === null) durations[path] = null;
    else if (isFiniteNumber(duration) && duration >= 0) durations[path] = duration;
  }
  return durations;
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

  return {
    fingerprint,
    builtAt: asIsoTimestamp(builtAt),
    regular,
    seasonal,
    durations: decodeDurations(readProperty(value, 'durations')),
  };
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
  durations: {},
});

const countSeasonal = (snapshot: VideoIndexSnapshot): number =>
  sumBy(Object.values(snapshot.seasonal), (videos) => videos.length);

const countVideos = (snapshot: VideoIndexSnapshot): number =>
  snapshot.regular.length + countSeasonal(snapshot);

/** Every source path in the snapshot, regular and seasonal, once each. */
const allPaths = (snapshot: VideoIndexSnapshot): readonly string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (video: IndexedVideo): void => {
    if (seen.has(video.originalPath)) return;
    seen.add(video.originalPath);
    paths.push(video.originalPath);
  };
  for (const video of snapshot.regular) add(video);
  for (const directory of Object.keys(snapshot.seasonal)) {
    for (const video of snapshot.seasonal[directory] ?? []) add(video);
  }
  return paths;
};

/** How many ffprobes run at once while measuring. They read headers, not frames. */
const MEASURE_CONCURRENCY = 4;

/**
 * How often a long measurement writes what it has so far. A first measurement
 * of a large library on a network share can take many minutes, and quitting
 * part-way through should not cost all of it.
 */
const MEASURE_SAVE_INTERVAL_MS = 60000;

/** Progress is reported this many times over a measurement, at most. */
const MEASURE_PROGRESS_STEPS = 200;

/** Where scanning ends and measuring begins on a rebuild's progress bar. */
const SCAN_SHARE_WHEN_MEASURING = 0.5;

/**
 * Splits the regular pool by the configured directory each video belongs to.
 *
 * A video belongs to the deepest configured directory that contains it. Nested
 * directories are the reason: with both `X:/videos` and `X:/videos/music`
 * configured, the music files are found by both scans, and putting them in the
 * outer directory as well would let them be drawn through either bias.
 * A video under none of them - only possible between a config change and the
 * re-scan it triggers - is not offered at all, which is also what the path
 * guard would say about it.
 */
export const toDirectoryCandidates = (
  regular: readonly IndexedVideo[],
  directories: readonly DirectoryConfig[],
): readonly DirectoryCandidate[] => {
  const configured = uniqueBy(directories, (entry) => entry.directory);
  const buckets = configured.map(() => [] as IndexedVideo[]);

  for (const video of regular) {
    let owner = -1;
    for (let index = 0; index < configured.length; index += 1) {
      const entry = configured[index];
      if (entry === undefined || !isPathInside(entry.directory, video.originalPath)) continue;
      const current = owner === -1 ? undefined : configured[owner];
      if (current === undefined || entry.directory.length > current.directory.length) owner = index;
    }
    if (owner !== -1) buckets[owner]?.push(video);
  }

  return configured.map((entry, index) => ({
    directory: entry.directory,
    bias: entry.bias,
    videos: buckets[index] ?? [],
  }));
};

/**
 * The regular pool split by directory, kept until the pool or the directories
 * change. Splitting compares every path against every configured directory,
 * which is far too much work to repeat for each of the twenty picks in a fill.
 */
interface BucketModel {
  readonly regular: readonly IndexedVideo[];
  readonly directories: readonly DirectoryConfig[];
  readonly candidates: readonly DirectoryCandidate[];
}

/** The length weighting, kept until the lengths or the bias settings change. */
interface WeightModel {
  readonly durations: Readonly<Record<string, number | null>>;
  readonly lengthBias: LengthBiasConfig;
  readonly weight: LengthWeight;
}

export const createVideoIndex = (deps: VideoIndexDeps): VideoIndex => {
  const { fileSystem, paths, clock, logger, config } = deps;
  const state = createStore<VideoIndexSnapshot>(emptySnapshot(clock.nowIso()));
  /**
   * Whether the in-memory snapshot may be written to the cache file: true for
   * one loaded from it or produced by a complete scan, false after a scan that
   * could not read everything.
   */
  const persistable = createStore(false);
  // Each rebuilt only when one of its inputs is a different object.
  const buckets = createStore<BucketModel | null>(null);
  const weights = createStore<WeightModel | null>(null);

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
    persistable.set(true);
    logger.info(
      `loaded the video index cache: ${snapshot.regular.length} videos and ` +
        `${countSeasonal(snapshot)} seasonal videos in ` +
        `${Object.keys(snapshot.seasonal).length} directories, built ${snapshot.builtAt}`,
    );
    return true;
  };

  const needsRebuild = (): boolean =>
    state.get().fingerprint !== computeConfigHash(config(), deps.digest);

  const needsMeasurement = (): boolean => {
    if (!config().selection.lengthBias.enabled) return false;
    const snapshot = state.get();
    return allPaths(snapshot).some((path) => !(path in snapshot.durations));
  };

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
  const listDirectory = async (
    directory: string,
    recursive: boolean,
  ): Promise<Result<DirectoryListing>> => {
    if (recursive) return fileSystem.listFilesRecursively(directory);
    const files = await fileSystem.listFiles(directory);
    return files.ok ? ok({ files: files.value, unreadable: [] }) : files;
  };

  const scanDirectory = async (
    directory: string,
    seasonalDirectory: string | null,
    extensions: readonly string[],
    recursive: boolean,
  ): Promise<{ readonly videos: readonly IndexedVideo[]; readonly complete: boolean }> => {
    if (!(await fileSystem.exists(directory))) {
      logger.warn(`skipping ${directory}: the directory does not exist`);
      return { videos: [], complete: false };
    }

    const listed = await listDirectory(directory, recursive);
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
    const extensions = indexedExtensions(current);
    const recursive = current.files.recursive;
    const directories = uniqueBy(directoryPaths(current), (directory) => directory);
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

    const measuring = current.selection.lengthBias.enabled;
    const scanShare = measuring ? SCAN_SHARE_WHEN_MEASURING : 1;

    const regular: IndexedVideo[] = [];
    // Nested directories find the same files twice; each is indexed once, and
    // `toDirectoryCandidates` decides which directory it counts towards.
    const indexedRegular = new Set<string>();
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
      report(scanShare * ratio(scanned, total), `Scanning: ${fileNameOf(directory)}`);
      const result = await scanDirectory(directory, null, extensions, recursive);
      complete = complete && result.complete;
      // Appended one at a time because spreading a directory holding tens of
      // thousands of files into push() overflows the argument stack.
      for (const video of result.videos) {
        if (isArchived(video.originalPath) || isSeasonal(video.originalPath)) continue;
        if (indexedRegular.has(video.originalPath)) continue;
        indexedRegular.add(video.originalPath);
        regular.push(video);
      }
      scanned += 1;
    }

    for (const directory of seasonalDirectories) {
      report(scanShare * ratio(scanned, total), `Scanning: ${fileNameOf(directory)}`);
      const result = await scanDirectory(directory, directory, extensions, recursive);
      complete = complete && result.complete;
      seasonal[directory] = result.videos.filter((entry) => !isArchived(entry.originalPath));
      scanned += 1;
    }

    const scannedSnapshot: VideoIndexSnapshot = {
      fingerprint: computeConfigHash(current, deps.digest),
      builtAt: clock.nowIso(),
      regular,
      seasonal,
      durations: {},
    };
    // Lengths are carried over whether or not the bias is on, so switching it
    // on later only has to measure what is new.
    const previous = state.get().durations;
    const durations: Record<string, number | null> = {};
    for (const path of allPaths(scannedSnapshot)) {
      // An image has no length of its own - ffprobe calls a JPEG a 0.04 second
      // clip, which would make it the shortest thing in the library and drag
      // the whole length range down with it. Recording it as unknown keeps it
      // out of the range and weighs it in the middle, like an average video.
      if (isImagePath(path, current)) {
        durations[path] = null;
        continue;
      }
      const known = previous[path];
      if (known !== undefined) durations[path] = known;
    }

    state.set({ ...scannedSnapshot, durations });
    persistable.set(complete);
    if (measuring) {
      await measureMissing(complete, (done, outOf) => {
        report(
          scanShare + (1 - scanShare) * ratio(done, outOf),
          `Measuring video lengths: ${done}/${outOf}`,
        );
      });
    }

    const snapshot = state.get();
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

  /**
   * Probes every indexed video that has no length yet, a few at a time.
   *
   * Lengths land in the live snapshot as they arrive rather than all at the
   * end, so selection during a long first measurement already uses the ones
   * that are known. `persist` is false after an incomplete scan, whose
   * snapshot must never reach the cache file.
   */
  const measureMissing = async (
    persist: boolean,
    onProgress: (done: number, outOf: number) => void,
  ): Promise<void> => {
    const startedFrom = state.get();
    const pending = allPaths(startedFrom).filter((path) => !(path in startedFrom.durations));
    if (pending.length === 0) return;

    logger.info(`measuring the length of ${pending.length} videos`);
    const step = Math.max(1, Math.floor(pending.length / MEASURE_PROGRESS_STEPS));
    let next = 0;
    let done = 0;
    let unreadable = 0;
    let lastSavedAt = clock.now();
    onProgress(0, pending.length);

    // Gathered here and handed to the snapshot in batches: copying the whole
    // map once per file is quadratic, and a library can hold tens of thousands.
    let batch: Record<string, number | null> = {};
    const flush = (): void => {
      const measured = batch;
      batch = {};
      state.update((snapshot) =>
        // A rebuild may have replaced the snapshot meanwhile; lengths for a
        // scan that is no longer current are dropped with it.
        snapshot.regular === startedFrom.regular && snapshot.seasonal === startedFrom.seasonal
          ? { ...snapshot, durations: { ...snapshot.durations, ...measured } }
          : snapshot,
      );
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const path = pending[next];
        next += 1;
        if (path === undefined) return;

        const duration = await deps.measureDuration(path);
        if (duration === null) unreadable += 1;
        batch[path] = duration;
        done += 1;
        if (done % step === 0 || done === pending.length) {
          flush();
          onProgress(done, pending.length);
        }

        if (persist && clock.now() - lastSavedAt >= MEASURE_SAVE_INTERVAL_MS) {
          lastSavedAt = clock.now();
          await save(state.get());
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let count = 0; count < Math.min(MEASURE_CONCURRENCY, pending.length); count += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    flush();

    if (unreadable > 0) {
      logger.warn(`could not read the length of ${unreadable} videos; they count as average`);
    }
    logger.info(`measured the length of ${pending.length - unreadable} videos`);
  };

  const measure = async (onProgress?: (progress: ScanProgress) => void): Promise<void> => {
    // Lengths add nothing to what the scan found, so the snapshot is exactly as
    // fit to save afterwards as it was before.
    const persist = persistable.get();
    await measureMissing(persist, (done, outOf) => {
      onProgress?.({
        progress: ratio(done, outOf),
        message: `Measuring video lengths: ${done}/${outOf}`,
      });
    });
    if (persist) await save(state.get());
  };

  const directoryCandidates = (snapshot: VideoIndexSnapshot): readonly DirectoryCandidate[] => {
    const directories = config().directories;
    const cached = buckets.get();
    if (cached !== null && cached.regular === snapshot.regular && cached.directories === directories) {
      return cached.candidates;
    }
    const candidates = toDirectoryCandidates(snapshot.regular, directories);
    buckets.set({ regular: snapshot.regular, directories, candidates });
    return candidates;
  };

  const lengthWeight = (snapshot: VideoIndexSnapshot): LengthWeight => {
    const lengthBias = config().selection.lengthBias;
    const cached = weights.get();
    if (cached !== null && cached.durations === snapshot.durations && cached.lengthBias === lengthBias) {
      return cached.weight;
    }
    // The range is the whole library's, regular and seasonal alike, so a given
    // length always weighs the same wherever it is drawn from.
    const range = lengthBias.enabled
      ? toLengthRange(allPaths(snapshot).map((path) => snapshot.durations[path] ?? null))
      : null;
    const weight = createLengthWeight(lengthBias, range);
    weights.set({ durations: snapshot.durations, lengthBias, weight });
    return weight;
  };

  const pickVideo = (excludedPaths: ReadonlySet<string>): IndexedVideo | null => {
    const snapshot = state.get();
    const facts = clock.localFacts();
    const weight = lengthWeight(snapshot);
    const candidates: readonly SeasonalCandidate[] = config().seasonalDirectories.map((entry) => ({
      directory: entry.directory,
      likelihood: entry.likelihood,
      conditions: entry.conditions,
      videos: snapshot.seasonal[entry.directory] ?? [],
    }));

    const outcome = selectVideo({
      regular: directoryCandidates(snapshot),
      seasonal: candidates,
      excludedPaths,
      facts,
      random: deps.random,
      weightOf: (video) => weight(snapshot.durations[video.originalPath] ?? null),
      scaleBiasByDirectorySize: config().selection.scaleBiasByDirectorySize,
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
      logger.debug(`selected ${outcome.video.filename} from ${outcome.directory}${when}`);
      return outcome.video;
    }

    logger.debug(`selected nothing: ${outcome.reason}${when}`);
    return null;
  };

  return {
    load,
    needsRebuild,
    rebuild,
    needsMeasurement,
    measure,
    snapshot: state.get,
    count: () => countVideos(state.get()),
    selectVideo: pickVideo,
    clear: async () => {
      state.set(emptySnapshot(clock.nowIso()));
      persistable.set(false);
      const removed = await fileSystem.remove(paths.videoIndexFile);
      if (!removed.ok) logger.warn(`could not delete ${paths.videoIndexFile}: ${removed.error.message}`);
      logger.info('cleared the video index');
    },
  };
};
