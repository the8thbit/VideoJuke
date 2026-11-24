import { createExclusiveTask, createStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import type { IndexedVideo, PreprocessedVideo } from '../../shared/types/video';
import { takeRandom } from '../../shared/util/arrays';
import type { FileSystem } from '../infra/fileSystem';
import type { Preprocessor } from './preprocessor';
import type { VideoIndex } from './videoIndex';
import type { VideoPathGuard } from './videoPaths';

/** Increments, not totals: the owner of the counters adds them to its own. */
export interface QueueStatsChange {
  readonly preprocessed?: number;
  readonly errors?: number;
}

export interface FillProgress {
  readonly current: number;
  readonly target: number;
}

export interface PreprocessedQueueDeps {
  readonly fileSystem: FileSystem;
  readonly preprocessor: Preprocessor;
  readonly videoIndex: VideoIndex;
  readonly logger: Logger;
  readonly config: () => AppConfig;
  readonly onStatsChange: (change: QueueStatsChange) => void;
  /** Consulted before any transcode is deleted; see `clear`. */
  readonly videoPaths: VideoPathGuard;
  /**
   * Source paths better not picked right now: what a screen is playing or has
   * queued, and what it played a moment ago. Only a preference - a library too
   * small to avoid them all still gets videos rather than none.
   */
  readonly avoid?: () => ReadonlySet<string>;
}

export interface PreprocessedQueue {
  readonly fill: (
    targetSize?: number,
    onProgress?: (progress: FillProgress) => void,
  ) => Promise<void>;
  readonly takeNext: () => PreprocessedVideo | null;
  /**
   * Builds `count` fresh transcodes beside the queue and then swaps them in for
   * everything it held, which is how a settings change reaches the queue without
   * interrupting playback. Ordinary fills stand aside while it runs. Resolves to
   * whether the swap happened.
   */
  readonly replaceWithFresh: (
    count: number,
    onProgress?: (progress: FillProgress) => void,
  ) => Promise<boolean>;
  /**
   * Bumped by every `replaceWithFresh` swap. Everything a client took before the
   * bump was chosen under the old settings, which is how it knows to drop them.
   */
  readonly batch: () => number;
  readonly size: () => number;
  readonly isFilling: () => boolean;
  readonly snapshot: () => readonly PreprocessedVideo[];
  readonly restore: (videos: readonly PreprocessedVideo[]) => void;
  readonly removeMissingFiles: () => Promise<number>;
  readonly clear: () => Promise<void>;
  readonly ensurePlayable: (video: PreprocessedVideo) => Promise<PreprocessedVideo | null>;
}

/**
 * The pool of transcoded videos waiting to be played.
 *
 * It is a bag rather than a queue: `takeNext` draws at random, which is what
 * makes playback feel shuffled even though the index is scanned in order. The
 * bag deliberately does not schedule its own refills; the server owns that, so
 * that a fill cannot be triggered from inside a synchronous read.
 */
export const createPreprocessedQueue = (deps: PreprocessedQueueDeps): PreprocessedQueue => {
  const videos = createStore<readonly PreprocessedVideo[]>([]);
  const filling = createExclusiveTask();
  /**
   * Bumped by anything that discards the queue wholesale. A transcode started
   * before that point finishes long after it, and appending its result would
   * put a video chosen against the abandoned index back into a queue that was
   * emptied precisely to be rid of it - with a file the clear could not delete,
   * because it did not exist yet.
   */
  const generation = createStore(0);
  /** See `PreprocessedQueue.batch`. */
  const batch = createStore(0);
  /** Set while a replacement batch is being built; ordinary fills stand aside. */
  const replacing = createStore(false);
  /** The fill in flight, so a replacement can wait for its current transcode. */
  const activeFill = createStore<Promise<void> | null>(null);

  /**
   * Chooses up to `count` sources to transcode. The ones picked earlier in this
   * same call are always excluded, so a single fill never transcodes the same
   * file twice, and so are the queued ones unless `excludeQueued` is false.
   *
   * A fresh batch passes false: the queue it is about to replace is going in
   * the bin, so its videos are as eligible as any other. Excluding them made a
   * small library build an empty batch - every video was already queued - and
   * the new settings never arrived at all.
   */
  const selectSources = (count: number, excludeQueued = true): readonly IndexedVideo[] => {
    const excluded = new Set<string>(
      excludeQueued ? videos.get().map((video) => video.originalPath) : [],
    );
    const selected: IndexedVideo[] = [];

    // The server's queue is all this used to exclude, so a video already waiting
    // in a screen's own queue, on screen, or just played could be picked again
    // and come round twice in a row.
    const avoided = new Set<string>(excluded);
    if (deps.avoid !== undefined) deps.avoid().forEach((path) => avoided.add(path));

    for (let index = 0; index < count; index += 1) {
      const source =
        deps.videoIndex.selectVideo(avoided) ?? deps.videoIndex.selectVideo(excluded);
      if (source === null) {
        deps.logger.debug(`selection ran dry after ${selected.length} of ${count} videos`);
        break;
      }
      excluded.add(source.originalPath);
      avoided.add(source.originalPath);
      selected.push(source);
    }

    return selected;
  };

  /**
   * Transcodes one source, or answers null when it could not be, or when the
   * queue was cleared while it ran and the result belongs to nothing any more.
   */
  const transcodeOne = async (source: IndexedVideo): Promise<PreprocessedVideo | null> => {
    // Indexes outlive the files they describe, so a source can disappear
    // between the scan and the transcode. That is not a preprocessing error.
    if (!(await deps.fileSystem.exists(source.originalPath))) {
      deps.logger.warn(`skipping missing source file: ${source.originalPath}`);
      return null;
    }

    const startedAt = generation.get();
    const processed = await deps.preprocessor.preprocess(source);
    if (!processed.ok) {
      deps.logger.warn(`failed to preprocess ${source.filename}: ${processed.error.message}`);
      deps.onStatsChange({ errors: 1 });
      return null;
    }

    if (generation.get() !== startedAt) {
      deps.logger.debug(`discarding ${source.filename}: the queue was cleared while it ran`);
      await deps.fileSystem.remove(processed.value.processedPath);
      return null;
    }

    deps.onStatsChange({ preprocessed: 1 });
    return processed.value;
  };

  const preprocessOne = async (source: IndexedVideo): Promise<void> => {
    const processed = await transcodeOne(source);
    if (processed !== null) videos.update((previous) => [...previous, processed]);
  };

  /** Deletes transcodes nothing will play, checking each path first; see `clear`. */
  const removeTranscodes = async (discarded: readonly PreprocessedVideo[]): Promise<number> => {
    // Not everything in this bag was put there by this process: `restore` fills
    // it from the saved state file, so the paths are only as trustworthy as that
    // file is. This is one of exactly two places that deletes a file named by a
    // record rather than by the preprocessor, and both check first.
    const removable = discarded.filter((video) =>
      deps.videoPaths.acceptsProcessed(video.processedPath),
    );
    const skipped = discarded.length - removable.length;
    if (skipped > 0) {
      deps.logger.warn(`left ${skipped} queued files alone: they are outside the temp directory`);
    }
    await Promise.all(removable.map((video) => deps.fileSystem.remove(video.processedPath)));
    return removable.length;
  };

  const runFill = async (
    targetSize: number | undefined,
    onProgress: ((progress: FillProgress) => void) | undefined,
  ): Promise<void> => {
    const target = targetSize ?? deps.config().video.preprocessedQueueSize;
    const needed = target - videos.get().length;

    if (needed <= 0) {
      onProgress?.({ current: videos.get().length, target });
      return;
    }

    deps.logger.info(`filling preprocessed queue: ${videos.get().length}/${target}`);

    const sources = selectSources(needed);
    if (sources.length === 0) {
      deps.logger.info('no videos available to preprocess');
      onProgress?.({ current: videos.get().length, target });
      return;
    }

    // One at a time: the transcodes are CPU-bound and the preprocessor already
    // paces them with the configured processing delay.
    const startedAt = generation.get();
    for (const source of sources) {
      // The whole list was chosen against the index as it stood when this fill
      // began. A `clear` or a `restore` part-way through abandons that index, so
      // everything still unstarted is abandoned with it: the per-transcode check
      // in `preprocessOne` only ever caught the one already running, and the
      // remaining sources each re-read the new generation and appended
      // themselves to the bag that was just emptied to be rid of them.
      if (generation.get() !== startedAt) {
        deps.logger.info('abandoning the rest of this fill: the queue was cleared while it ran');
        return;
      }
      // Everything this fill would add is about to be swapped out.
      if (replacing.get()) {
        deps.logger.info('abandoning the rest of this fill: a fresh batch is being built');
        return;
      }
      await preprocessOne(source);
      onProgress?.({ current: videos.get().length, target });
    }

    deps.logger.info(`preprocessed queue filled: ${videos.get().length}/${target}`);
  };

  const fill = async (
    targetSize?: number,
    onProgress?: (progress: FillProgress) => void,
  ): Promise<void> => {
    // A batch built under the new settings is about to replace the queue, and
    // anything added now would only be thrown away with it.
    if (replacing.get()) {
      deps.logger.debug('skipping a fill: a fresh batch is being built');
      return;
    }
    // Overlapping fills would select against a stale exclusion set and
    // transcode the same file twice; the exclusive task makes them impossible.
    const running = filling.runExclusive(() => runFill(targetSize, onProgress));
    const settled = running.then(() => undefined);
    activeFill.set(settled);
    try {
      await settled;
    } finally {
      if (activeFill.get() === settled) activeFill.set(null);
    }
  };

  const replaceWithFresh = async (
    count: number,
    onProgress?: (progress: FillProgress) => void,
  ): Promise<boolean> => {
    replacing.set(true);
    try {
      // A fill already under way finishes the transcode it is on and then
      // stops; `runFill` checks `replacing` between sources.
      const running = activeFill.get();
      if (running !== null) await running.catch(() => undefined);

      const swapped = await filling.runExclusive(async (): Promise<boolean> => {
        const startedAt = generation.get();
        const sources = selectSources(count, false);
        const staged: PreprocessedVideo[] = [];
        deps.logger.info(`building a fresh batch of ${sources.length} videos`);
        onProgress?.({ current: 0, target: sources.length });

        for (const source of sources) {
          if (generation.get() !== startedAt) break;
          const processed = await transcodeOne(source);
          if (processed !== null) staged.push(processed);
          onProgress?.({ current: staged.length, target: sources.length });
        }

        // A clear or a restore while this ran abandoned the index it was built
        // against, exactly as it abandons an ordinary fill.
        if (generation.get() !== startedAt || staged.length === 0) {
          await removeTranscodes(staged);
          deps.logger.warn('the fresh batch was abandoned; keeping the current queue');
          return false;
        }

        const discarded = videos.get();
        videos.set(staged);
        generation.update((previous) => previous + 1);
        batch.update((previous) => previous + 1);
        const removed = await removeTranscodes(discarded);
        deps.logger.info(
          `swapped in a fresh batch of ${staged.length} videos, ${removed} older transcodes removed`,
        );
        return true;
      });
      return swapped === true;
    } finally {
      replacing.set(false);
    }
  };

  const takeNext = (): PreprocessedVideo | null => {
    // Nothing is awaited between the read and the write, so the draw is atomic.
    // The deps carry no random source because every caller of this queue wants
    // real shuffling; the selection randomness tests care about is in videoIndex.
    const { removed, rest } = takeRandom(videos.get(), Math.random);
    if (removed === null) return null;

    videos.set(rest);
    deps.logger.debug(`dequeued ${removed.filename}, ${rest.length} remaining`);
    return removed;
  };

  /**
   * Drops queued videos whose transcode has vanished, which happens when the
   * temp directory is cleaned while the queue is live.
   *
   * This is the file check the legacy `getNext` meant to perform: it called
   * `exists` without awaiting it, so the truthy promise passed every candidate
   * and the guard never rejected anything. Doing it here keeps the draw
   * synchronous and still gets the queue validated, just on its own schedule.
   */
  const removeMissingFiles = async (): Promise<number> => {
    const current = videos.get();
    const checks = await Promise.all(
      current.map(async (video) => ({
        video,
        present: await deps.fileSystem.exists(video.processedPath),
      })),
    );

    const missing = new Set<string>(
      checks.filter((check) => !check.present).map((check) => check.video.processedPath),
    );
    if (missing.size === 0) return 0;

    // Filter the live state rather than replacing it: a draw may have landed
    // while the existence checks were in flight.
    const before = videos.get().length;
    const after = videos.update((previous) =>
      previous.filter((video) => !missing.has(video.processedPath)),
    ).length;

    const dropped = before - after;
    if (dropped > 0) {
      deps.logger.warn(`dropped ${dropped} queued videos whose processed file is gone`);
    }
    return dropped;
  };

  const clear = async (): Promise<void> => {
    // Empty the bag first so nothing can be drawn while its file is being
    // deleted underneath it.
    const discarded = videos.get();
    videos.set([]);
    generation.update((previous) => previous + 1);

    const removed = await removeTranscodes(discarded);
    deps.logger.info(`cleared preprocessed queue: ${removed} files removed`);
  };

  const ensurePlayable = async (video: PreprocessedVideo): Promise<PreprocessedVideo | null> => {
    if (await deps.fileSystem.exists(video.processedPath)) return video;

    if (!(await deps.fileSystem.exists(video.originalPath))) {
      deps.logger.warn(`cannot reprocess ${video.filename}: the source file is gone`);
      return null;
    }

    deps.logger.debug(`reprocessing ${video.filename}: its processed file is missing`);
    const processed = await deps.preprocessor.preprocess(video);
    if (!processed.ok) {
      deps.logger.warn(`failed to reprocess ${video.filename}: ${processed.error.message}`);
      return null;
    }

    // Keep the timing the video was queued with: history entries were handed to
    // the client with it, and recomputing would move a fade the user has
    // already seen scheduled.
    if (video.crossfadeTiming === null) return processed.value;
    return { ...processed.value, crossfadeTiming: video.crossfadeTiming };
  };

  return {
    fill,
    takeNext,
    replaceWithFresh,
    batch: batch.get,
    size: () => videos.get().length,
    isFilling: () => filling.isRunning(),
    snapshot: () => videos.get(),
    restore: (restored) => {
      videos.set([...restored]);
      // A restore replaces the bag as completely as a clear does; a transcode
      // still running from before it must not append itself to the result.
      generation.update((previous) => previous + 1);
    },
    removeMissingFiles,
    clear,
    ensurePlayable,
  };
};
