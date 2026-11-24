import type { Clock } from '../../shared/time/clock';
import { asProcessedVideoPath, type VideoId } from '../../shared/types/brand';
import type { AppConfig, ProcessPriority } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import { err, ok, type Result } from '../../shared/types/result';
import type { IndexedVideo, PreprocessedVideo, VideoMetadata } from '../../shared/types/video';
import { formatFileSize, formatPercent } from '../../shared/util/format';
import { computeCrossfadeTiming, toCrossfadeSettings } from '../../shared/video/crossfadeTiming';
import {
  describeTranscodePlan,
  planTranscode,
  resolvePerformanceSettings,
} from '../../shared/video/encoding';
import { isImagePath } from '../../shared/video/mediaKind';
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

/**
 * The longest a still image render may take, whatever `transcodeTimeout` allows.
 * Rendering a picture takes a second or two; one ffmpeg cannot decode is looped
 * as an input and retried for ever, and would otherwise hold the queue for the
 * full timeout meant for transcoding a long film.
 */
export const IMAGE_RENDER_TIMEOUT_MS = 60000;

/**
 * Runs at most `limit()` tasks at once, the rest waiting in arrival order. The
 * limit is read whenever a slot frees up, so a settings change applies to the
 * next transcode without waiting for the queue to drain.
 */
export const createTaskLimiter = (limit: () => number) => {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    while (waiting.length > 0 && active < Math.max(1, limit())) {
      active += 1;
      (waiting.shift() as () => void)();
    }
  };

  const acquire = (): Promise<void> => {
    if (active < Math.max(1, limit())) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
};

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

/** Where one video has got to, for the queue's progress line. */
export interface PreprocessStage {
  /** What is being done, in a few words: "Copying", "Normalizing loudness". */
  readonly label: string;
  /** 0..1 while ffmpeg is running and can tell; null otherwise. */
  readonly progress: number | null;
}

export interface Preprocessor {
  readonly preprocess: (
    video: IndexedVideo,
    onStage?: (stage: PreprocessStage) => void,
  ) => Promise<Result<PreprocessedVideo, Error>>;
}

type StageReporter = (stage: PreprocessStage) => void;

const IGNORE_STAGE: StageReporter = () => undefined;

/**
 * Turns an indexed source file into a transcoded one.
 *
 * Every codec, filter and performance decision lives in `shared/video`; what
 * is left here is the sequencing around it: throttle, probe, transcode, retry
 * once on an audio failure, prove the output is real.
 */
export const createPreprocessor = (deps: PreprocessorDeps): Preprocessor => {
  /**
   * At most `performance.parallelTranscodes` ffmpegs at a time, across every
   * caller.
   *
   * The queue fill is not the only caller: `ensurePlayable` - the server's
   * answer to the viewer pressing "previous" on a video whose transcode has been
   * swept - runs beside it. Limiting here rather than at the queue keeps the
   * total to what the user configured however many callers there are, and
   * keeps the viewer's request waiting behind a few transcodes at most rather
   * than an entire fill.
   */
  const transcodes = createTaskLimiter(() => deps.config().performance.parallelTranscodes);

  const runTranscode = (
    video: IndexedVideo,
    metadata: VideoMetadata,
    config: AppConfig,
    outputPath: string,
    compatibilityMode: boolean,
    onStage: StageReporter,
    allowCopy = true,
  ): Promise<Result<void, Error>> => {
    let loggedSteps = 0;
    const plan = planTranscode(metadata.audio, config, { compatibilityMode, allowCopy });
    const label = compatibilityMode
      ? 'Retrying with stereo audio'
      : describeTranscodePlan(plan);
    onStage({ label, progress: null });
    if (plan.copyAudio) deps.logger.debug(`${video.filename} needs no audio work; copying it`);

    return deps.media.transcode({
      inputPath: video.originalPath,
      outputPath,
      plan,
      timeoutMs: config.timeouts.transcodeTimeout,
      onProgress: ({ progress }) => {
        if (progress === null) return;
        onStage({ label, progress });
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
    onStage: StageReporter,
  ): Promise<Result<void, Error>> => {
    if (attempt.ok || !isRecoverableAudioError(attempt.error.message, video.originalPath)) {
      return attempt;
    }

    deps.logger.warn(
      `audio error transcoding ${video.filename}, retrying in compatibility mode: ` +
        attempt.error.message,
    );
    return runTranscode(video, metadata, config, outputPath, true, onStage);
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

  /**
   * An image becomes a silent clip - held for `images.displayDuration`, or for
   * an animated GIF one pass of the animation - and is then
   * described by probing that clip rather than the source: the player needs the
   * clip's real length to end it and blend out of it on time, and a probe of
   * the JPEG itself reports a single 0.04 second frame.
   */
  const preprocessImage = async (
    video: IndexedVideo,
    config: AppConfig,
    priority: ProcessPriority,
    onStage: StageReporter,
  ): Promise<Result<PreprocessedVideo, Error>> => {
    const outputPath = joinPath(deps.paths.tempDirectory, transcodeFileName(deps.newVideoId()));
    deps.logger.debug(`rendering the image ${video.filename} into ${outputPath}`);
    onStage({ label: 'Rendering the image', progress: null });

    const rendered = await deps.media.renderImage({
      inputPath: video.originalPath,
      outputPath,
      durationSeconds: config.images.displayDuration / 1000,
      priority,
      stillTimeoutMs: Math.min(config.timeouts.transcodeTimeout, IMAGE_RENDER_TIMEOUT_MS),
      animationTimeoutMs: config.timeouts.transcodeTimeout,
    });
    if (!rendered.ok) {
      await deps.fileSystem.remove(outputPath);
      return err(new Error(`failed to render ${video.filename}: ${rendered.error.message}`));
    }

    const verified = await verifyOutput(outputPath, video.filename);
    if (!verified.ok) return verified;

    const probed = await deps.media.probe(outputPath, config.timeouts.probeTimeout);
    if (!probed.ok) {
      await deps.fileSystem.remove(outputPath);
      return err(new Error(`failed to probe the render of ${video.filename}: ${probed.error.message}`));
    }
    const metadata = probed.value;
    deps.logger.debug(`rendered ${video.filename} (${formatFileSize(verified.value)})`);

    return ok({
      ...video,
      processedPath: asProcessedVideoPath(outputPath),
      processedAt: deps.clock.nowIso(),
      metadata,
      crossfadeTiming: computeCrossfadeTiming(metadata.duration, toCrossfadeSettings(config)),
    });
  };

  const runPreprocess = async (
    video: IndexedVideo,
    onStage: StageReporter,
  ): Promise<Result<PreprocessedVideo, Error>> => {
    const config = deps.config();
    const performance = resolvePerformanceSettings(config.performance);

    // The pause comes before the work rather than after it, so a queue fill
    // spaces its transcodes out instead of running them back to back.
    await deps.delay(performance.processingDelay);

    if (isImagePath(video.originalPath, config)) {
      return preprocessImage(video, config, performance.priority, onStage);
    }

    onStage({ label: 'Reading', progress: null });
    const probed = await deps.media.probe(video.originalPath, config.timeouts.probeTimeout);
    if (!probed.ok) {
      return err(new Error(`failed to probe ${video.filename}: ${probed.error.message}`));
    }
    const metadata = probed.value;

    // tempDirectory was already resolved by the infra layer, so joinPath only
    // has to append to it.
    const outputPath = joinPath(deps.paths.tempDirectory, transcodeFileName(deps.newVideoId()));
    deps.logger.debug(`preprocessing ${video.filename} into ${outputPath}`);

    const first = await runTranscode(video, metadata, config, outputPath, false, onStage);
    // A copy ffmpeg refuses - a stream the MP4 container will not take as it is
    // - is not a reason to give up on the file: the full chain re-encodes it.
    const attempt =
      first.ok || !planTranscode(metadata.audio, config, { compatibilityMode: false }).copyAudio
        ? first
        : await (async () => {
            deps.logger.warn(`copying ${video.filename} failed, transcoding it instead: ${first.error.message}`);
            await deps.fileSystem.remove(outputPath);
            return runTranscode(video, metadata, config, outputPath, false, onStage, false);
          })();
    const transcoded = await retryIfRecoverable(
      attempt,
      video,
      metadata,
      config,
      outputPath,
      onStage,
    );
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

  return {
    preprocess: (video, onStage = IGNORE_STAGE) => {
      onStage({ label: 'Waiting for a free slot', progress: null });
      return transcodes.run(() => runPreprocess(video, onStage));
    },
  };
};
