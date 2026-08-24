import type {
  AudioConfig,
  LoudnessTarget,
  NormalizationConfig,
} from "../types/config";

/**
 * How the `dual_mono` segment of a loudnorm filter is spelled. The three
 * spellings are load-bearing: the filter string is what ffmpeg parses, and the
 * legacy pipeline emitted a different one per channel-count branch.
 *
 * - `omit`  no segment at all (3/4/5-channel and fallback chains)
 * - `true`  `:dual_mono=true` (mono, stereo and 6+-channel chains when the
 *           option is enabled in config)
 * - `false` `:dual_mono=false` (6+-channel chains when it is disabled; the
 *           other chains drop the segment instead of printing `false`)
 */
type DualMonoSpelling = "omit" | "true" | "false";

/** The configured upmix levels, unpacked so the filter expressions stay short. */
interface UpmixLevels {
  readonly rear: number;
  readonly center: number;
  readonly lfe: number;
}

/**
 * The loudness parameters to apply, or null when normalisation is off.
 *
 * Config normalisation already resolves the named preset into the explicit
 * `targetLufs` / `truePeak` / `loudnessRange` fields, so the overlay below is
 * total. It is written as an overlay anyway to keep the legacy precedence
 * visible: preset first, explicit values win.
 */
export const resolveLoudnessTarget = (
  config: NormalizationConfig,
): LoudnessTarget | null => {
  if (!config.enabled) return null;

  return {
    ...config.presets[config.strength],
    targetLufs: config.targetLufs,
    truePeak: config.truePeak,
    loudnessRange: config.loudnessRange,
  };
};

export const buildLoudnormFilter = (
  target: LoudnessTarget,
  options: { readonly dualMono: DualMonoSpelling },
): string => {
  const base = `loudnorm=I=${target.targetLufs}:TP=${target.truePeak}:LRA=${target.loudnessRange}`;
  return options.dualMono === "omit"
    ? base
    : `${base}:dual_mono=${options.dualMono}`;
};

/**
 * The rate a normalised chain is brought back to when the source did not say
 * what its own was. 48 kHz is what video audio is.
 */
const FALLBACK_SAMPLE_RATE = 48000;

/**
 * Restores the sample rate after `loudnorm`.
 *
 * `loudnorm` runs its measurement at 192 kHz and emits at that rate. Nothing
 * downstream asked for it, and the AAC encoder cannot take it, so ffmpeg
 * silently resampled to the highest rate it does support: every normalised file
 * this application produced came out at 96 kHz, whatever the source was, paying
 * for twice the samples and landing on a rate some TV decoders handle poorly.
 * The filter documentation calls for exactly this step.
 */
const restoreRate = (sampleRate: number | null): string =>
  `aresample=${sampleRate === null || sampleRate <= 0 ? FALLBACK_SAMPLE_RATE : sampleRate}`;

/** Zero or one loudnorm step, so callers can splice it into a chain unconditionally. */
const loudnormSteps = (
  target: LoudnessTarget | null,
  dualMono: DualMonoSpelling,
): readonly string[] =>
  target === null ? [] : [buildLoudnormFilter(target, { dualMono })];

/**
 * Appends the resample, and only ever at the end of the chain.
 *
 * Position is load-bearing, which is not obvious from the filter documentation.
 * Putting `aresample` directly after `loudnorm` and ahead of the `pan` makes
 * ffmpeg fail the whole transcode with "Error reinitializing filters!" - the pan
 * is negotiating a layout while the resampler is still changing the rate under
 * it. At the end of the chain, after every layout decision has been made, it
 * simply works.
 */
const withRestoredRate = (
  steps: readonly string[],
  target: LoudnessTarget | null,
  sampleRate: number | null,
): readonly string[] =>
  target === null ? steps : [...steps, restoreRate(sampleRate)];

/** Every upmix ends in a 5.1 pan; only the per-channel expressions differ. */
const panTo51 = (mappings: readonly string[]): string =>
  `pan=5.1|${mappings.join("|")}`;

/**
 * 3, 4 and 5 channels are upmixed by promoting the channels that already exist
 * and synthesising the rest. The attenuation factors are tuned per source
 * layout, so they stay written out rather than folded into the level constants.
 */
const intermediateMappings = (
  channels: number,
  levels: UpmixLevels,
): readonly string[] => {
  if (channels === 3) {
    return [
      "FL=c0",
      "FR=c1",
      `FC=${levels.center * 0.6}*c0+${levels.center * 0.6}*c1`,
      `LFE=c2+${levels.lfe * 0.4}*c0+${levels.lfe * 0.4}*c1`,
      `BL=${levels.rear * 1.2}*c0`,
      `BR=${levels.rear * 1.2}*c1`,
    ];
  }

  if (channels === 4) {
    return [
      "FL=c0",
      "FR=c1",
      `FC=${levels.center * 0.6}*c0+${levels.center * 0.6}*c1`,
      `LFE=${levels.lfe}*c0+${levels.lfe}*c1`,
      "BL=c2",
      "BR=c3",
    ];
  }

  return [
    "FL=c0",
    "FR=c1",
    "FC=c2",
    `LFE=${levels.lfe}*c0+${levels.lfe}*c1`,
    "BL=c3",
    "BR=c4",
  ];
};

/**
 * The safe mapping for channel counts that match no known layout. It reads at
 * most two source channels, duplicating the first when there is no second.
 */
const fallbackMappings = (
  channels: number,
  levels: UpmixLevels,
): readonly string[] => {
  const hasSecond = channels > 1;
  return [
    "FL=c0",
    hasSecond ? "FR=c1" : "FR=c0",
    `FC=${levels.center}*c0${hasSecond ? `+${levels.center}*c1` : ""}`,
    `LFE=${levels.lfe}*c0${hasSecond ? `+${levels.lfe}*c1` : ""}`,
    `BL=${levels.rear}*c0`,
    `BR=${levels.rear}*${hasSecond ? "c1" : "c0"}`,
  ];
};

/**
 * The ffmpeg audio filter chain for one source stream.
 *
 * These strings are tuned behaviour carried over verbatim from the legacy
 * preprocessor; the arithmetic on the configured levels is part of that tuning
 * and must stay in the same order so the printed numbers match.
 *
 * `channelLayout` is part of the input because the legacy 6+-channel branch
 * inspected it to decide whether to "preserve" the original, but both sides of
 * that branch emitted the identical filter, so it only ever changed a log line.
 */
export const buildAudioFilterChain = (
  input: {
    readonly channels: number;
    readonly channelLayout: string;
    /** From ffprobe; the chain is brought back to it after `loudnorm`. */
    readonly sampleRate?: number | null;
  },
  config: AudioConfig,
): readonly string[] => {
  const { channels } = input;
  const sampleRate = input.sampleRate ?? null;
  const target = resolveLoudnessTarget(config.normalization);
  const levels: UpmixLevels = {
    rear: config.stereoUpmixing.rearChannelLevel,
    center: config.stereoUpmixing.centerChannelLevel,
    lfe: config.stereoUpmixing.lfeChannelLevel,
  };
  const optionalDualMono: DualMonoSpelling = config.normalization.dualMono
    ? "true"
    : "omit";
  const requiredDualMono: DualMonoSpelling = config.normalization.dualMono
    ? "true"
    : "false";

  // Mono drives both front channels from the one source channel: panning it
  // straight to 5.1 leaves the output silent on some decoders.
  if (channels === 1) {
    return withRestoredRate(
      [
        ...loudnormSteps(target, optionalDualMono),
        panTo51([
          "FL=c0",
          "FR=c0",
          `FC=${levels.center}*c0`,
          `LFE=${levels.lfe}*c0`,
          `BL=${levels.rear}*c0`,
          `BR=${levels.rear}*c0`,
        ]),
      ],
      target,
      sampleRate,
    );
  }

  if (channels === 2) {
    return withRestoredRate(
      [
        ...loudnormSteps(target, optionalDualMono),
        panTo51([
          "FL=FL",
          "FR=FR",
          `FC=${levels.center}*FL+${levels.center}*FR`,
          `LFE=${levels.lfe}*FL+${levels.lfe}*FR`,
          `BL=${levels.rear}*FL`,
          `BR=${levels.rear}*FR`,
        ]),
      ],
      target,
      sampleRate,
    );
  }

  // Structurally identical to the 1 and 2 channel cases, and deliberately so.
  // This branch used to insert `aresample=resampler=soxr` between the loudnorm
  // and the pan, which failed twice over: the bundled `ffmpeg-static` is built
  // without libsoxr, so swresample rejected the engine outright, and the step
  // sat in exactly the position `withRestoredRate` documents as fatal. Every
  // 3, 4 and 5 channel source therefore failed its first transcode, was retried
  // in compatibility mode because the error text mentions audio, and ended up
  // keeping its original layout - the one thing this upmix exists to replace.
  if (channels === 3 || channels === 4 || channels === 5) {
    return withRestoredRate(
      [...loudnormSteps(target, "omit"), panTo51(intermediateMappings(channels, levels))],
      target,
      sampleRate,
    );
  }

  // Already multichannel: normalise and leave the channel mapping alone.
  if (channels >= 6) {
    return withRestoredRate(
      loudnormSteps(target, requiredDualMono),
      target,
      sampleRate,
    );
  }

  if (channels > 0) {
    return withRestoredRate(
      [
        ...loudnormSteps(target, "omit"),
        panTo51(fallbackMappings(channels, levels)),
      ],
      target,
      sampleRate,
    );
  }

  return [];
};

/**
 * The chain used when 5.1 processing is off or a retry has fallen back to
 * compatibility mode: normalise if configured, otherwise touch nothing.
 */
export const buildStereoFilterChain = (
  config: AudioConfig,
  sampleRate: number | null = null,
): readonly string[] => {
  const target = resolveLoudnessTarget(config.normalization);
  return withRestoredRate(
    loudnormSteps(target, config.normalization.dualMono ? "true" : "omit"),
    target,
    sampleRate,
  );
};
