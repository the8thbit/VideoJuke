import { createSerialTask } from '../../shared/state/store';
import type { Clock } from '../../shared/time/clock';
import { asProcessedVideoPath, type VideoId } from '../../shared/types/brand';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import { err, ok, type Result } from '../../shared/types/result';
import type { IndexedVideo, PreprocessedVideo, VideoMetadata } from '../../shared/types/video';
import { formatFileSize, formatPercent } from '../../shared/util/format';
import { computeCrossfadeTiming, toCrossfadeSettings } from '../../shared/video/crossfadeTiming';
import { planTranscode, resolvePerformanceSettings } from '../../shared/video/encoding';
import { isRecoverableAudioError, type MediaToolkit } from '../infra/ffmpeg';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';
import { joinPath } from './pathText';
import { transcodeFileName } from './videoPaths';

/**
 * Smallest output ffmpeg can produce that is plausibly a video. ffmpeg
 * occasionally exits zero having written nothing but a container header, and
 * the legacy pipeline queued those stubs and only discovered them when the
 * player failed to load one.
 */
export const MINIMUM_OUTPUT_BYTES = 1024;

/** ffmpeg emits progress continuously; only quarter marks reach the log. */
const PROGRESS_LOG_STEPS = 4;

export interface PreprocessorDeps {
  readonly fileSystem: FileSystem;
  readonly media: MediaToolkit;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly newVideoId: () => VideoId;
  readonly delay: (milliseconds: number) => Promise<void>;
  /** Read per call, so a config reload changes the next transcode, not this one. */
  readonly config: () => AppConfig;
}

export interface Preprocessor {
  readonly preprocess: (video: IndexedVideo) => Promise<Result<PreprocessedVideo, Error>>;
}

/**
 * Turns an indexed source file into a transcoded one.
 *
 * Every codec, filter and performance decision lives in `shared/video`; what
 * is left here is the sequencing around it: throttle, probe, transcode, retry
 * once on an audio failure, prove the output is real.
 */
export const createPreprocessor = (deps: PreprocessorDeps): Preprocessor => {
  /**
   * One ffmpeg at a time, across every caller.
   *
   * The queue fill is exclusive with itself, but `ensurePlayable` - the server's
   * answer to the viewer pressing "previous" on a video whose transcode has been
   * swept - runs outside that lock. A step back during a background fill
   * therefore started a second ffmpeg, and each one had been handed the full
   * `maxThreads` budget, so the machine ran at twice the CPU the user had
   * configured as its limit. Serialising here rather than at the queue keeps the
   * viewer's request waiting behind at most one transcode instead of an entire
   * fill.
   */
  const transcodes = createSerialTask();

  const runTranscode = (
    video: IndexedVideo,
    metadata: VideoMetadata,
    config: AppConfig,
    outputPath: string,
    compatibilityMode: boolean,
  ): Promise<Result<void, Error>> => {
    let loggedSteps = 0;

    return deps.media.transcode({
      inputPath: video.originalPath,
      outputPath,
      plan: planTranscode(metadata.audio, config, { compatibilityMode }),
      timeoutMs: config.timeouts.transcodeTimeout,
      onProgress: ({ progress }) => {
        if (progress === null) return;
        const step = Math.floor(progress * PROGRESS_LOG_STEPS);
        if (step <= loggedSteps) return;
        loggedSteps = step;
        deps.logger.debug(`transcoding ${video.filename}: ${formatPercent(progress)}`);
      },
    });
  };

  /**
   * A filter-graph failure is nearly always the 5.1 chain rejecting an unusual
   * source layout, so one retry re-plans in compatibility mode, which drops
   * every pan filter and emits stereo. Any other failure is genuine and
   * retrying it would only spend CPU to fail again.
   */
  const retryIfRecoverable = async (
    attempt: Result<void, Error>,
    video: IndexedVideo,
    metadata: VideoMetadata,
    config: AppConfig,
    outputPath: string,
  ): Promise<Result<void, Error>> => {
    if (attempt.ok || !isRecoverableAudioError(attempt.error.message, video.originalPath)) {
      return attempt;
    }

    deps.logger.warn(
      `audio error transcoding ${video.filename}, retrying in compatibility mode: ` +
        attempt.error.message,
    );
    return runTranscode(video, metadata, config, outputPath, true);
  };

  /** Returns the size of the verified output, in bytes. */
  const verifyOutput = async (
    outputPath: string,
    filename: string,
  ): Promise<Result<number, Error>> => {
    if (!(await deps.fileSystem.exists(outputPath))) {
      return err(new Error(`transcode of ${filename} reported success but wrote no file`));
    }

    const stats = await deps.fileSystem.stat(outputPath);
    if (!stats.ok) {
      return err(new Error(`cannot inspect the transcode of ${filename}: ${stats.error.message}`));
    }
    if (stats.value.sizeBytes >= MINIMUM_OUTPUT_BYTES) return ok(stats.value.sizeBytes);

    // Nothing references the stub yet, so drop it here rather than leaving a
    // file in the temp directory that only a later sweep would clean up.
    await deps.fileSystem.remove(outputPath);
    return err(
      new Error(`transcode of ${filename} produced only ${stats.value.sizeBytes} bytes`),
    );
  };

  const runPreprocess = async (video: IndexedVideo): Promise<Result<PreprocessedVideo, Error>> => {
    const config = deps.config();
    const performance = resolvePerformanceSettings(config.performance);

    // The pause comes before the work rather than after it, so a queue fill
    // spaces its transcodes out instead of running them back to back.
    await deps.delay(performance.processingDelay);

    const probed = await deps.media.probe(video.originalPath, config.timeouts.probeTimeout);
    if (!probed.ok) {
      return err(new Error(`failed to probe ${video.filename}: ${probed.error.message}`));
    }
    const metadata = probed.value;

    // tempDirectory was already resolved by the infra layer, so joinPath only
    // has to append to it.
    const outputPath = joinPath(deps.paths.tempDirectory, transcodeFileName(deps.newVideoId()));
    deps.logger.debug(`preprocessing ${video.filename} into ${outputPath}`);

    const attempt = await runTranscode(video, metadata, config, outputPath, false);
    const transcoded = await retryIfRecoverable(attempt, video, metadata, config, outputPath);
    if (!transcoded.ok) {
      // ffmpeg leaves whatever it had written when it gave up. Nothing references
      // it, so it would sit in the temp directory until the hourly sweep noticed
      // it; a library that fails to transcode can produce one of these per file.
      await deps.fileSystem.remove(outputPath);
      return err(new Error(`failed to transcode ${video.filename}: ${transcoded.error.message}`));
    }

    const verified = await verifyOutput(outputPath, video.filename);
    if (!verified.ok) return verified;

    deps.logger.debug(`preprocessed ${video.filename} (${formatFileSize(verified.value)})`);

    return ok({
      ...video,
      processedPath: asProcessedVideoPath(outputPath),
      processedAt: deps.clock.nowIso(),
      metadata,
      // Computed once, here. The legacy code left this to three call sites that
      // used three different rules, so a queued video and the player it fed
      // disagreed about when the blend should start.
      crossfadeTiming: computeCrossfadeTiming(metadata.duration, toCrossfadeSettings(config)),
    });
  };

  return { preprocess: (video) => transcodes.run(() => runPreprocess(video)) };
};
