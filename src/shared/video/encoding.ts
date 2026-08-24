import type {
  AppConfig,
  AudioCodecName,
  AudioConfig,
  PerformanceConfig,
  PerformancePreset,
} from '../types/config';
import type { AudioStreamInfo } from '../types/video';
import { buildAudioFilterChain, buildStereoFilterChain } from './audioFilters';

export interface AudioEncoding {
  readonly codec: AudioCodecName;
  /** Bits per second, as ffmpeg reports it; the shell converts to `NNNk`. */
  readonly bitrate: number;
}

/** The most any AAC stream is given, per channel count, in compatibility mode. */
const FORCED_AAC_MULTICHANNEL_BITRATE = 384000;
const FORCED_AAC_STEREO_BITRATE = 256000;

/**
 * Picks the codec and bitrate for a given output channel count.
 *
 * `forceAac` exists because browser support for AC-3 is patchy: it overrides
 * the configured codec and caps the bitrate, since a conservative AAC stream
 * plays everywhere whereas a high-bitrate multichannel one does not.
 */
export const selectAudioEncoding = (channels: number, config: AudioConfig): AudioEncoding => {
  const { codecPreferences, compatibility } = config;
  const multichannel = channels > 2;
  const configuredBitrate = multichannel
    ? codecPreferences.multichannelBitrate
    : codecPreferences.stereoBitrate;

  if (compatibility.forceAac) {
    const cap = multichannel ? FORCED_AAC_MULTICHANNEL_BITRATE : FORCED_AAC_STEREO_BITRATE;
    return { codec: 'aac', bitrate: Math.min(configuredBitrate, cap) };
  }

  return {
    codec: multichannel ? codecPreferences.multichannel : codecPreferences.stereo,
    bitrate: configuredBitrate,
  };
};

/**
 * Resolves the named performance preset, then lets an enabled `cpuLimiting`
 * block override it. That block carries every field a preset has, so enabling
 * it replaces the preset outright rather than merging into it.
 */
export const resolvePerformanceSettings = (config: PerformanceConfig): PerformancePreset => {
  const preset = config.presets[config.mode];
  if (!config.cpuLimiting.enabled) return preset;

  const { maxThreads, processingDelay, threadQueueSize, priority } = config.cpuLimiting;
  return { maxThreads, processingDelay, threadQueueSize, priority };
};

export const buildPerformanceOutputOptions = (
  settings: PerformancePreset,
): readonly string[] => {
  const options: readonly string[] = [
    '-threads',
    String(settings.maxThreads),
    '-thread_queue_size',
    String(settings.threadQueueSize),
    '-preset',
    'medium',
  ];

  // A single thread means the user asked for a quiet machine, so give up more
  // encoder quality for less CPU on top of the thread limit.
  return settings.maxThreads === 1 ? [...options, '-cpu-used', '1'] : options;
};

/** Makes the transcoded file streamable and tolerant of negative start timestamps. */
export const MP4_OUTPUT_OPTIONS: readonly string[] = [
  '-movflags',
  'faststart',
  '-avoid_negative_ts',
  'make_zero',
];

export interface TranscodePlan {
  readonly audioFilters: readonly string[];
  readonly audioEncoding: AudioEncoding;
  /** Null in compatibility mode, where the channel count is left to the encoder. */
  readonly outputChannels: number | null;
  readonly outputOptions: readonly string[];
  readonly performance: PerformancePreset;
}

/** What compatibility mode always falls back to: plain stereo AAC. */
const COMPATIBILITY_ENCODING: AudioEncoding = { codec: 'aac', bitrate: 256000 };

/** A source with no audio stream takes the fallback branch of the filter chain. */
const SILENT_SOURCE = { channels: 0, channelLayout: '', sampleRate: null } as const;

/**
 * Everything ffmpeg needs to know about one transcode, decided up front.
 *
 * Compatibility mode is the retry path: the first attempt builds a full 5.1
 * chain, and an audio-related ffmpeg failure re-plans with `compatibilityMode`
 * set, which drops every pan filter and emits stereo.
 */
export const planTranscode = (
  audio: AudioStreamInfo | null,
  config: AppConfig,
  options: { readonly compatibilityMode: boolean },
): TranscodePlan => {
  const performance = resolvePerformanceSettings(config.performance);
  const outputOptions: readonly string[] = [
    ...buildPerformanceOutputOptions(performance),
    ...MP4_OUTPUT_OPTIONS,
  ];

  /**
   * `audio.stereoUpmixing.enabled` was validated, documented and then never
   * read: turning it off still ran every mono and stereo source through the 5.1
   * pan, because only the per-channel *levels* beside it were ever consulted.
   * A source that is already multichannel is unaffected either way - there is
   * nothing to synthesise - so this only decides what happens to the sources the
   * setting is actually about.
   */
  const sourceChannels = audio?.channels ?? 0;
  const upmixRefused =
    sourceChannels > 0 && sourceChannels < 6 && !config.audio.stereoUpmixing.enabled;

  if (options.compatibilityMode || !config.audio.surroundProcessingEnabled || upmixRefused) {
    return {
      audioFilters: buildStereoFilterChain(config.audio, audio?.sampleRate ?? null),
      audioEncoding: COMPATIBILITY_ENCODING,
      outputChannels: null,
      outputOptions,
      performance,
    };
  }

  /**
   * Asked for one or two channels, so there is nothing to upmix *to*.
   *
   * The pan ran anyway, and `-ac 2` then folded the six channels it had just
   * invented back down to two. Measured on a hard-panned source, that round trip
   * put a channel that had been digitally silent back at -32 dB - audible
   * crosstalk, because the synthesised centre is `0.5*FL + 0.5*FR` and the
   * downmix returns it to both sides - and left the result 4 dB under the
   * loudness target loudnorm had just hit, by a margin that varies with how much
   * energy each file has in the channels being discarded. That is the one thing
   * normalisation exists to prevent.
   *
   * `outputChannels` is still applied, so a genuinely multichannel source is
   * downmixed exactly once, by ffmpeg, from its real layout. Nothing here
   * touches the default of 6: that path still upmixes stereo to 5.1.
   */
  if (config.audio.outputChannels <= 2) {
    return {
      audioFilters: buildStereoFilterChain(config.audio, audio?.sampleRate ?? null),
      audioEncoding: selectAudioEncoding(config.audio.outputChannels, config.audio),
      outputChannels: config.audio.outputChannels,
      outputOptions,
      performance,
    };
  }

  return {
    audioFilters: buildAudioFilterChain(audio ?? SILENT_SOURCE, config.audio),
    audioEncoding: selectAudioEncoding(config.audio.outputChannels, config.audio),
    outputChannels: config.audio.outputChannels,
    outputOptions,
    performance,
  };
};
