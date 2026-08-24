import { constants, setPriority } from 'os';

import ffmpeg, { type FfprobeData, type FfprobeStream } from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

import type { ProcessPriority } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import { err, ok, toError, type Result } from '../../shared/types/result';
import type {
  AudioStreamInfo,
  ContainerInfo,
  VideoMetadata,
  VideoStreamInfo,
} from '../../shared/types/video';
import { classifyAudioProfile, deriveChannelLayout } from '../../shared/video/audioProfile';
import type { TranscodePlan } from '../../shared/video/encoding';
import { parseNumber, parseRationalNumber } from '../../shared/util/numbers';

if (typeof ffmpegStatic === 'string') {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface TranscodeProgress {
  /** Completion in the range 0..1, or null when ffmpeg cannot estimate it. */
  readonly progress: number | null;
}

export interface TranscodeRequest {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly plan: TranscodePlan;
  /** Milliseconds before the child is killed; see `timeouts.transcodeTimeout`. */
  readonly timeoutMs: number;
  readonly onProgress?: (progress: TranscodeProgress) => void;
}

export interface MediaToolkitDeps {
  readonly logger: Logger;
}

export interface MediaToolkit {
  readonly probe: (path: string, timeoutMs: number) => Promise<Result<VideoMetadata>>;
  readonly transcode: (request: TranscodeRequest) => Promise<Result<void>>;
  /**
   * Kills every ffmpeg still running and refuses to start more.
   *
   * Without it, quitting the application left a CPU-bound child behind: Electron
   * calls `app.exit`, the web server calls `process.exit`, and neither takes a
   * detached grandchild with it. A user who quit during a fill was left with an
   * ffmpeg pinning their cores and writing into a temp directory nothing would
   * ever read.
   */
  readonly shutdown: () => void;
}

const streamsOfKind = (data: FfprobeData, kind: string): readonly FfprobeStream[] =>
  data.streams.filter((stream) => stream.codec_type === kind);

/**
 * Whether the container marks this stream as the one to play by default.
 *
 * It outranks everything else in ffmpeg's own selection, including the channel
 * count, which is why it is a separate term rather than folded into the score.
 */
const isDefaultStream = (stream: FfprobeStream): boolean =>
  stream.disposition?.default === 1;

/**
 * Picks the stream ffmpeg will encode, rather than the first one of its kind.
 *
 * `applyPlan` emits no `-map`, so ffmpeg applies its own default selection, and
 * `streams.find(...)` is not that rule. A file laid out as `#1 AAC 2.0, #2 AC-3
 * 5.1` - the ordinary shape of a rip carrying a stereo mixdown or a commentary
 * track first - was described as stereo, and that stereo plan was then applied
 * to the 5.1 stream ffmpeg actually chose. The two-channel `pan` names only FL
 * and FR, so nothing failed: the real centre, LFE and surround channels were
 * silently discarded and resynthesised from the front pair, and the result was
 * cached for the life of the file.
 *
 * The ordering below is ffmpeg's, confirmed against the bundled binary: the
 * default disposition first, then the tie-break for the kind, then the lowest
 * index. `>` rather than `>=` is what keeps that last rule.
 */
const bestStream = (
  streams: readonly FfprobeStream[],
  rank: (stream: FfprobeStream) => number,
): FfprobeStream | undefined => {
  let best: FfprobeStream | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const stream of streams) {
    // Large enough that no realistic channel count or frame area can reach it,
    // which is the point: a flagged stream wins however small it is.
    const score = (isDefaultStream(stream) ? 1e12 : 0) + rank(stream);
    if (score > bestScore) {
      best = stream;
      bestScore = score;
    }
  }
  return best;
};

const bestAudioStream = (data: FfprobeData): FfprobeStream | undefined =>
  bestStream(streamsOfKind(data, 'audio'), (stream) => stream.channels ?? 0);

/**
 * The same rule for video, ranked by frame area. An `attached_pic` - the cover
 * art in an mp3 or an m4a - is a video stream as far as ffprobe is concerned,
 * and ffmpeg ranks it below every real one; describing a 300x300 JPEG as the
 * picture put the artwork's dimensions in the debug overlay.
 */
const bestVideoStream = (data: FfprobeData): FfprobeStream | undefined =>
  bestStream(streamsOfKind(data, 'video'), (stream) =>
    stream.disposition?.attached_pic === 1
      ? Number.NEGATIVE_INFINITY
      : (stream.width ?? 0) * (stream.height ?? 0),
  );

const toAudioStreamInfo = (stream: FfprobeStream | undefined): AudioStreamInfo | null => {
  if (!stream) return null;

  const channels = stream.channels ?? 0;
  // ffprobe omits channel_layout for some codecs, notably Opus, so derive it.
  const channelLayout = stream.channel_layout ?? deriveChannelLayout(channels);

  return {
    channels,
    channelLayout,
    codec: stream.codec_name ?? null,
    sampleRate: parseNumber(stream.sample_rate),
    bitrate: parseNumber(stream.bit_rate),
    profile: classifyAudioProfile(channels, channelLayout),
  };
};

const toVideoStreamInfo = (stream: FfprobeStream | undefined): VideoStreamInfo => ({
  width: stream?.width ?? null,
  height: stream?.height ?? null,
  // r_frame_rate arrives as a rational string such as "30000/1001".
  framesPerSecond: parseRationalNumber(stream?.r_frame_rate),
  codec: stream?.codec_name ?? null,
});

const toContainerInfo = (data: FfprobeData): ContainerInfo => ({
  fileSize: parseNumber(data.format.size),
  bitrate: parseNumber(data.format.bit_rate),
  formatName: data.format.format_name ?? null,
});

export const toVideoMetadata = (data: FfprobeData): VideoMetadata => ({
  duration: parseNumber(data.format.duration),
  video: toVideoStreamInfo(bestVideoStream(data)),
  audio: toAudioStreamInfo(bestAudioStream(data)),
  container: toContainerInfo(data),
});

/**
 * ffmpeg reports filter-graph problems as ordinary failures, and the ones we
 * can recover from by falling back to a plain stereo mix all mention the audio
 * stage. Anything else is a genuine failure for this file.
 *
 * `inputPath` is removed before the test because ffmpeg quotes the command line
 * back in its error message. A file under `X:/videos/channel surfing/` matched
 * `channel`, and a directory named `Japan` matched `pan`, so every unrelated
 * failure - a missing file, a corrupt container - was retried in compatibility
 * mode, spending a second full transcode to fail in exactly the same way.
 */
export const isRecoverableAudioError = (message: string, inputPath = ''): boolean => {
  const lowered = message.toLowerCase();
  const withoutPath =
    inputPath === '' ? lowered : lowered.split(inputPath.toLowerCase()).join(' ');
  return (
    withoutPath.includes('audio') ||
    withoutPath.includes('pan') ||
    withoutPath.includes('loudnorm') ||
    withoutPath.includes('channel')
  );
};

const applyPlan = (command: ffmpeg.FfmpegCommand, plan: TranscodePlan): ffmpeg.FfmpegCommand => {
  const withAudio = command
    .audioFilters([...plan.audioFilters])
    .videoCodec('copy')
    .audioCodec(plan.audioEncoding.codec)
    .audioBitrate(`${Math.floor(plan.audioEncoding.bitrate / 1000)}k`);

  const withChannels =
    plan.outputChannels === null ? withAudio : withAudio.audioChannels(plan.outputChannels);

  return withChannels.format('mp4').outputOptions([...plan.outputOptions]);
};

/**
 * `performance.priority` in the units the OS wants.
 *
 * `high` deliberately maps to *above* normal rather than to the highest class
 * available. On Windows `PRIORITY_HIGH` outranks most of the desktop, and an
 * encoder that outranks the compositor makes the machine unusable while it
 * works - which is not what anyone choosing "high" for a background transcoder
 * is asking for.
 */
export const PRIORITY_VALUES: Readonly<Record<ProcessPriority, number>> = {
  low: constants.priority.PRIORITY_LOW,
  normal: constants.priority.PRIORITY_NORMAL,
  high: constants.priority.PRIORITY_ABOVE_NORMAL,
};

/**
 * The child's pid, or null if this build of fluent-ffmpeg does not hand it over.
 *
 * `ffmpegProc` is not part of the documented API - it is how the library's own
 * `kill` finds the process - so it is read defensively. Losing it costs the
 * priority setting and nothing else, which is why this reports null rather than
 * throwing.
 */
const childPid = (command: ffmpeg.FfmpegCommand): number | null => {
  const process = (command as { ffmpegProc?: { readonly pid?: number } }).ffmpegProc;
  return typeof process?.pid === 'number' ? process.pid : null;
};

export const createMediaToolkit = (deps: MediaToolkitDeps): MediaToolkit => {
  const logger = deps.logger;

  /**
   * Applies the configured priority to a child that has just been spawned.
   *
   * ffmpeg has no flag for this and fluent-ffmpeg's own `niceness` option is a
   * documented no-op on Windows, which is this application's main platform, so
   * the pid is renice'd directly instead. The setting had been validated,
   * threaded into every transcode plan and then never read: choosing the `quiet`
   * performance preset promised a low-priority encoder and delivered an ordinary
   * one.
   */
  const applyPriority = (command: ffmpeg.FfmpegCommand, priority: ProcessPriority): void => {
    if (priority === 'normal') return;

    const pid = childPid(command);
    if (pid === null) {
      logger.debug('cannot set the ffmpeg priority: this build exposes no child process');
      return;
    }

    try {
      setPriority(pid, PRIORITY_VALUES[priority]);
      logger.debug(`ffmpeg ${pid} set to ${priority} priority`);
    } catch (thrown) {
      // Lowering a priority is always permitted; raising one is not, so `high`
      // fails as an ordinary user on Linux. The transcode is unaffected either
      // way, so this is worth a line and nothing more.
      logger.warn(`could not set ffmpeg to ${priority} priority: ${toError(thrown).message}`);
    }
  };

  /** Every command that has been started and has not yet settled. */
  const running = new Set<ffmpeg.FfmpegCommand>();
  let stopped = false;

  const probe = (path: string, timeoutMs: number): Promise<Result<VideoMetadata>> =>
    new Promise<Result<VideoMetadata>>((resolve) => {
      let settled = false;
      const finish = (result: Result<VideoMetadata>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };

      // ffprobe reads headers, so it should answer in milliseconds. When it does
      // not - a source on a share that has gone away - the callback never fires
      // and the preprocess call it belongs to never returns.
      const deadline = setTimeout(() => {
        finish(err(new Error(`probing ${path} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      ffmpeg.ffprobe(path, (probeError, data) => {
        if (probeError) {
          finish(err(toError(probeError)));
          return;
        }
        try {
          finish(ok(toVideoMetadata(data)));
        } catch (thrown) {
          finish(err(toError(thrown)));
        }
      });
    });

  const transcode = ({
    inputPath,
    outputPath,
    plan,
    timeoutMs,
    onProgress,
  }: TranscodeRequest): Promise<Result<void>> =>
    new Promise<Result<void>>((resolve) => {
      if (stopped) {
        resolve(err(new Error('the media toolkit is shutting down')));
        return;
      }

      const command = applyPlan(ffmpeg(inputPath), plan);
      let settled = false;

      const finish = (result: Result<void>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        running.delete(command);
        resolve(result);
      };

      // A child that stops making progress holds the exclusive fill lock, and
      // nothing else in the process can ever take it again.
      const deadline = setTimeout(() => {
        // `error` follows the kill and reports the failure; this only names the
        // real cause, since ffmpeg's own message will just say it was signalled.
        command.kill('SIGKILL');
        finish(err(new Error(`transcoding ${inputPath} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      running.add(command);
      command
        // Emitted immediately after the child is spawned and assigned, which is
        // the first moment its pid exists.
        .on('start', () => {
          // And the first moment it can be killed. `kill` before the spawn is a
          // warning and nothing else, so a shutdown landing in the window
          // between `.save()` and this event - which is not small, since the
          // first transcode of a run spends it probing ffmpeg's capabilities -
          // left behind exactly the orphan `shutdown` exists to prevent.
          if (stopped) {
            command.kill('SIGKILL');
            return;
          }
          applyPriority(command, plan.performance.priority);
        })
        .on('progress', (progress) => {
          const percent = typeof progress.percent === 'number' ? progress.percent : null;
          onProgress?.({ progress: percent === null ? null : percent / 100 });
        })
        .on('error', (transcodeError) => finish(err(toError(transcodeError))))
        .on('end', () => finish(ok(undefined)))
        .save(outputPath);
    });

  const shutdown = (): void => {
    stopped = true;
    for (const command of Array.from(running)) {
      // The `error` handler each command already carries settles its promise,
      // and `finish` takes it out of the set - which is why the set is not
      // cleared here. Clearing it discarded any command that had not spawned
      // yet, and those are precisely the ones `kill` could not touch: the
      // `start` handler above finishes the job when they do spawn.
      command.kill('SIGKILL');
    }
  };

  return { probe, transcode, shutdown };
};
