import { decodeTimeCondition } from '../time/timeConditions';
import type {
  AppConfig,
  AudioCompatibilityConfig,
  AudioConfig,
  BlurConfig,
  CodecPreferencesConfig,
  ConfigIssue,
  CpuLimitingConfig,
  CrossfadeConfig,
  FilesConfig,
  LoudnessTarget,
  NetworkConfig,
  NormalizationConfig,
  PerformanceConfig,
  PerformancePreset,
  PlaybackConfig,
  RetriesConfig,
  SeasonalDirectoryConfig,
  ServerNetworkConfig,
  StereoUpmixingConfig,
  SystemConfig,
  TimeoutsConfig,
  UiConfig,
  VideoConfig,
} from '../types/config';
import {
  AUDIO_CODEC_NAMES,
  LOG_LEVEL_NAMES,
  NORMALIZATION_PRESET_NAMES,
  PERFORMANCE_MODES,
  PROCESS_PRIORITIES,
} from '../types/config';
import type { DecodeContext, NumberOptions } from '../util/decode';
import {
  createIssueCollector,
  readArray,
  readBoolean,
  readEnum,
  readNullableString,
  readNumber,
  readSecret,
  readSection,
  readString,
  readStringArray,
} from '../util/decode';
import { isPlainObject, mapValues, type UnknownRecord } from '../util/objects';
import { DEFAULT_CONFIG } from './defaults';

export interface NormalizedConfig {
  readonly config: AppConfig;
  readonly issues: readonly ConfigIssue[];
}

/** A raw value paired with the decode context naming the key it came from. */
interface RawField {
  readonly context: DecodeContext;
  readonly value: unknown;
}

/**
 * Finds a field inside an opened section. The optional second name is the
 * spelling older config files use; issues are reported against whichever key
 * the user actually wrote rather than the canonical one.
 */
type FieldLocator = (key: string, legacyKey?: string) => RawField;

const openSection = (source: RawField): FieldLocator => {
  const raw: UnknownRecord = readSection(source.context, source.value);
  return (key, legacyKey) => {
    const value = raw[key];
    if (value !== undefined || legacyKey === undefined) {
      return { context: source.context.at(key), value };
    }
    return { context: source.context.at(legacyKey), value: raw[legacyKey] };
  };
};

const bool = (source: RawField, fallback: boolean): boolean =>
  readBoolean(source.context, source.value, fallback);

const num = (source: RawField, fallback: number, options?: NumberOptions): number =>
  readNumber(source.context, source.value, fallback, options);

const text = (source: RawField, fallback: string): string =>
  readString(source.context, source.value, fallback);

const secret = (source: RawField, fallback: string): string =>
  readSecret(source.context, source.value, fallback);

const nullableText = (source: RawField, fallback: string | null): string | null =>
  readNullableString(source.context, source.value, fallback);

const choice = <TValue extends string>(
  source: RawField,
  allowed: readonly TValue[],
  fallback: TValue,
): TValue => readEnum(source.context, source.value, allowed, fallback);

const strings = (source: RawField, fallback: readonly string[]): readonly string[] =>
  readStringArray(source.context, source.value, fallback);

/** Whole things to be counted, where a fraction has no meaning. */
const COUNT: NumberOptions = { min: 1, integer: true };
/** Sizes and durations that must be at least one unit to do anything. */
const AT_LEAST_ONE: NumberOptions = { min: 1 };
/** Delays where zero legitimately means "immediately". */
const NON_NEGATIVE: NumberOptions = { min: 0 };
/** Probabilities and mix coefficients. */
const FRACTION: NumberOptions = { min: 0, max: 1 };
const PORT: NumberOptions = { min: 1, max: 65535, integer: true };
const CHANNELS: NumberOptions = { min: 1, max: 8, integer: true };
const THREADS: NumberOptions = { min: 1, max: 8, integer: true };
const PROCESSING_DELAY: NumberOptions = { min: 0, max: 10000 };
const THREAD_QUEUE_SIZE: NumberOptions = { min: 128, max: 2048, integer: true };
/** The range Chromium accepts for `playbackRate`; outside it playback stalls. */
const PLAYBACK_RATE: NumberOptions = { min: 0.0625, max: 16 };
/**
 * The ranges ffmpeg's `loudnorm` filter documents for `I`, `TP` and `LRA`.
 *
 * These are not decoration. A value outside them makes ffmpeg refuse to build
 * the filter graph, which fails the transcode of every single video; the
 * compatibility retry then re-emits the same loudnorm with the same value and
 * fails again, so the app indexes a full library and preprocesses none of it.
 */
const LOUDNESS_TARGET: NumberOptions = { min: -70, max: -5 };
const TRUE_PEAK: NumberOptions = { min: -9, max: 0 };
const LOUDNESS_RANGE: NumberOptions = { min: 1, max: 50 };

const readServerNetwork = (source: RawField, base: ServerNetworkConfig): ServerNetworkConfig => {
  const pick = openSection(source);
  return {
    enabled: bool(pick('enabled'), base.enabled),
    port: num(pick('port'), base.port, PORT),
    host: text(pick('host'), base.host),
    autoOpenBrowser: bool(pick('autoOpenBrowser'), base.autoOpenBrowser),
    allowedOrigins: strings(pick('allowedOrigins'), base.allowedOrigins),
    // `readSecret`, not `text`: an empty token is the legitimate way to say
    // "generate one", and a bad one must never be echoed into an issue message
    // that the logger broadcasts to every connected client.
    authToken: secret(pick('authToken'), base.authToken),
  };
};

const readNetwork = (source: RawField, base: NetworkConfig): NetworkConfig => {
  const pick = openSection(source);
  return { server: readServerNetwork(pick('server'), base.server) };
};

const readVideo = (source: RawField, base: VideoConfig): VideoConfig => {
  const pick = openSection(source);
  return {
    updateInterval: num(pick('updateInterval'), base.updateInterval, AT_LEAST_ONE),
    preprocessedQueueSize: num(pick('preprocessedQueueSize'), base.preprocessedQueueSize, COUNT),
    playbackQueueSize: num(pick('playbackQueueSize'), base.playbackQueueSize, COUNT),
    playbackQueueInitializationThreshold: num(
      pick('playbackQueueInitializationThreshold'),
      base.playbackQueueInitializationThreshold,
      COUNT,
    ),
    playbackHistorySize: num(pick('playbackHistorySize'), base.playbackHistorySize, COUNT),
    persistedHistorySize: num(pick('persistedHistorySize'), base.persistedHistorySize, COUNT),
  };
};

/**
 * Takes an already-opened section so that the live `cpuLimiting` block, which
 * is a preset plus an `enabled` flag, can share this decoder with the presets.
 */
const readPerformancePreset = (pick: FieldLocator, base: PerformancePreset): PerformancePreset => ({
  maxThreads: num(pick('maxThreads'), base.maxThreads, THREADS),
  processingDelay: num(pick('processingDelay'), base.processingDelay, PROCESSING_DELAY),
  threadQueueSize: num(pick('threadQueueSize'), base.threadQueueSize, THREAD_QUEUE_SIZE),
  priority: choice(pick('priority'), PROCESS_PRIORITIES, base.priority),
});

const readCpuLimiting = (source: RawField, base: CpuLimitingConfig): CpuLimitingConfig => {
  const pick = openSection(source);
  return {
    enabled: bool(pick('enabled'), base.enabled),
    ...readPerformancePreset(pick, base),
  };
};

const readPerformance = (source: RawField, base: PerformanceConfig): PerformanceConfig => {
  const pick = openSection(source);
  const presets = openSection(pick('presets'));
  return {
    mode: choice(pick('mode'), PERFORMANCE_MODES, base.mode),
    cpuLimiting: readCpuLimiting(pick('cpuLimiting'), base.cpuLimiting),
    // Presets get the same bounds as cpuLimiting because switching mode copies
    // one straight into it.
    presets: mapValues(base.presets, (preset, mode) =>
      readPerformancePreset(openSection(presets(mode)), preset),
    ),
  };
};

const readStereoUpmixing = (source: RawField, base: StereoUpmixingConfig): StereoUpmixingConfig => {
  const pick = openSection(source);
  return {
    enabled: bool(pick('enabled'), base.enabled),
    rearChannelLevel: num(pick('rearChannelLevel'), base.rearChannelLevel, FRACTION),
    centerChannelLevel: num(pick('centerChannelLevel'), base.centerChannelLevel, FRACTION),
    lfeChannelLevel: num(pick('lfeChannelLevel'), base.lfeChannelLevel, FRACTION),
  };
};

/**
 * Takes an already-opened section rather than a field, which is what lets the
 * normalization section and each of its presets share one decoder: the three
 * loudnorm values sit inline in the former and nested in the latter.
 */
const readLoudnessTarget = (pick: FieldLocator, base: LoudnessTarget): LoudnessTarget => ({
  targetLufs: num(pick('targetLufs', 'targetLUFS'), base.targetLufs, LOUDNESS_TARGET),
  truePeak: num(pick('truePeak'), base.truePeak, TRUE_PEAK),
  loudnessRange: num(pick('loudnessRange', 'LRA'), base.loudnessRange, LOUDNESS_RANGE),
});

const readNormalization = (source: RawField, base: NormalizationConfig): NormalizationConfig => {
  const pick = openSection(source);
  const presets = openSection(pick('presets'));
  const resolvedPresets = mapValues(base.presets, (preset, name) =>
    readLoudnessTarget(openSection(presets(name)), preset),
  );
  const strength = choice(pick('strength'), NORMALIZATION_PRESET_NAMES, base.strength);

  return {
    enabled: bool(pick('enabled'), base.enabled),
    strength,
    // Precedence, as in the original preprocessor: the named preset supplies the
    // loudness values, and any explicitly written field overrides it. Resolving
    // it here means every consumer reads three plain numbers instead of
    // re-deriving the preset lookup.
    ...readLoudnessTarget(pick, resolvedPresets[strength]),
    dualMono: bool(pick('dualMono'), base.dualMono),
    presets: resolvedPresets,
  };
};

const readCodecPreferences = (
  source: RawField,
  base: CodecPreferencesConfig,
): CodecPreferencesConfig => {
  const pick = openSection(source);
  return {
    multichannel: choice(pick('multichannel'), AUDIO_CODEC_NAMES, base.multichannel),
    stereo: choice(pick('stereo'), AUDIO_CODEC_NAMES, base.stereo),
    multichannelBitrate: num(pick('multichannelBitrate'), base.multichannelBitrate, COUNT),
    stereoBitrate: num(pick('stereoBitrate'), base.stereoBitrate, COUNT),
  };
};

const readAudioCompatibility = (
  source: RawField,
  base: AudioCompatibilityConfig,
): AudioCompatibilityConfig => {
  const pick = openSection(source);
  return {
    preserveOriginalIfMultichannel: bool(
      pick('preserveOriginalIfMultichannel'),
      base.preserveOriginalIfMultichannel,
    ),
    forceAac: bool(pick('forceAac', 'forceAAC'), base.forceAac),
  };
};

const readAudio = (source: RawField, base: AudioConfig): AudioConfig => {
  const pick = openSection(source);
  return {
    surroundProcessingEnabled: bool(
      pick('surroundProcessingEnabled', 'enabled51Processing'),
      base.surroundProcessingEnabled,
    ),
    outputChannels: num(
      pick('outputChannels', 'forceOutputChannels'),
      base.outputChannels,
      CHANNELS,
    ),
    stereoUpmixing: readStereoUpmixing(pick('stereoUpmixing'), base.stereoUpmixing),
    normalization: readNormalization(pick('normalization'), base.normalization),
    codecPreferences: readCodecPreferences(pick('codecPreferences'), base.codecPreferences),
    compatibility: readAudioCompatibility(pick('compatibility'), base.compatibility),
  };
};

const readTimeouts = (source: RawField, base: TimeoutsConfig): TimeoutsConfig => {
  const pick = openSection(source);
  return {
    videoLoadTimeout: num(pick('videoLoadTimeout'), base.videoLoadTimeout, AT_LEAST_ONE),
    videoTestTimeout: num(pick('videoTestTimeout'), base.videoTestTimeout, AT_LEAST_ONE),
    initializationRetryDelay: num(
      pick('initializationRetryDelay'),
      base.initializationRetryDelay,
      NON_NEGATIVE,
    ),
    backgroundRecoveryDelay: num(
      pick('backgroundRecoveryDelay'),
      base.backgroundRecoveryDelay,
      NON_NEGATIVE,
    ),
    queueMonitorInterval: num(
      pick('queueMonitorInterval'),
      base.queueMonitorInterval,
      AT_LEAST_ONE,
    ),
    periodicCleanupInterval: num(
      pick('periodicCleanupInterval'),
      base.periodicCleanupInterval,
      AT_LEAST_ONE,
    ),
    periodicSaveInterval: num(
      pick('periodicSaveInterval'),
      base.periodicSaveInterval,
      AT_LEAST_ONE,
    ),
    commandCooldown: num(pick('commandCooldown'), base.commandCooldown, AT_LEAST_ONE),
    crossfadeBufferTime: num(pick('crossfadeBufferTime'), base.crossfadeBufferTime, AT_LEAST_ONE),
    crossfadeMinDuration: num(
      pick('crossfadeMinDuration'),
      base.crossfadeMinDuration,
      AT_LEAST_ONE,
    ),
    queueRefillDelay: num(pick('queueRefillDelay'), base.queueRefillDelay, NON_NEGATIVE),
    backgroundFillDelay: num(pick('backgroundFillDelay'), base.backgroundFillDelay, NON_NEGATIVE),
    backgroundFillRetryDelay: num(
      pick('backgroundFillRetryDelay'),
      base.backgroundFillRetryDelay,
      NON_NEGATIVE,
    ),
    errorRecoveryDelay: num(pick('errorRecoveryDelay'), base.errorRecoveryDelay, NON_NEGATIVE),
    debugUpdateInterval: num(pick('debugUpdateInterval'), base.debugUpdateInterval, AT_LEAST_ONE),
    statusDisplayDuration: num(
      pick('statusDisplayDuration'),
      base.statusDisplayDuration,
      AT_LEAST_ONE,
    ),
    connectionTimeout: num(pick('connectionTimeout'), base.connectionTimeout, AT_LEAST_ONE),
    browserOpenDelay: num(pick('browserOpenDelay'), base.browserOpenDelay, NON_NEGATIVE),
    queueSyncInterval: num(pick('queueSyncInterval'), base.queueSyncInterval, AT_LEAST_ONE),
    transcodeTimeout: num(pick('transcodeTimeout'), base.transcodeTimeout, AT_LEAST_ONE),
    probeTimeout: num(pick('probeTimeout'), base.probeTimeout, AT_LEAST_ONE),
    streamUrlLifetime: num(pick('streamUrlLifetime'), base.streamUrlLifetime, AT_LEAST_ONE),
  };
};

const readRetries = (source: RawField, base: RetriesConfig): RetriesConfig => {
  const pick = openSection(source);
  return {
    maxInitializationAttempts: num(
      pick('maxInitializationAttempts'),
      base.maxInitializationAttempts,
      COUNT,
    ),
    maxQueueBuildAttempts: num(pick('maxQueueBuildAttempts'), base.maxQueueBuildAttempts, COUNT),
  };
};

const readSystem = (source: RawField, base: SystemConfig): SystemConfig => {
  const pick = openSection(source);
  return {
    tempDirectory: text(pick('tempDirectory'), base.tempDirectory),
    cacheDirectory: text(pick('cacheDirectory'), base.cacheDirectory),
    archiveDirectory: text(pick('archiveDirectory'), base.archiveDirectory),
    logLevel: choice(pick('logLevel'), LOG_LEVEL_NAMES, base.logLevel),
    enableFileWatcher: bool(pick('enableFileWatcher'), base.enableFileWatcher),
  };
};

const readFiles = (source: RawField, base: FilesConfig): FilesConfig => {
  const pick = openSection(source);
  const extensions = pick('supportedVideoExtensions');
  return {
    supportedVideoExtensions: readArray(
      extensions.context,
      extensions.value,
      (itemContext, item) => {
        if (typeof item !== 'string' || item.trim() === '') {
          itemContext.report('warning', 'ignoring an extension that is not a non-empty string');
          return null;
        }
        const normalized = item.trim().toLowerCase();
        return normalized.startsWith('.') ? normalized : `.${normalized}`;
      },
      base.supportedVideoExtensions,
    ),
  };
};

const readCrossfade = (source: RawField, base: CrossfadeConfig): CrossfadeConfig => {
  const pick = openSection(source);
  return {
    enabled: bool(pick('enabled'), base.enabled),
    duration: num(pick('duration'), base.duration, NON_NEGATIVE),
  };
};

const readBlur = (source: RawField, base: BlurConfig): BlurConfig => {
  const pick = openSection(source);
  return {
    enabled: bool(pick('enabled'), base.enabled),
    maxAmount: num(pick('maxAmount'), base.maxAmount, AT_LEAST_ONE),
  };
};

const readUi = (source: RawField, base: UiConfig): UiConfig => {
  const pick = openSection(source);
  return {
    infoDuration: num(pick('infoDuration'), base.infoDuration, AT_LEAST_ONE),
    errorDuration: num(pick('errorDuration'), base.errorDuration, AT_LEAST_ONE),
    tempInfoDuration: num(pick('tempInfoDuration'), base.tempInfoDuration, AT_LEAST_ONE),
    startFullscreen: bool(pick('startFullscreen'), base.startFullscreen),
    showErrorToast: bool(pick('showErrorToast'), base.showErrorToast),
  };
};

const readPlayback = (source: RawField, base: PlaybackConfig): PlaybackConfig => {
  const pick = openSection(source);
  return {
    skipSeconds: num(pick('skipSeconds'), base.skipSeconds, AT_LEAST_ONE),
    speedIncrement: num(pick('speedIncrement'), base.speedIncrement, PLAYBACK_RATE),
    minSpeed: num(pick('minSpeed'), base.minSpeed, PLAYBACK_RATE),
    maxSpeed: num(pick('maxSpeed'), base.maxSpeed, PLAYBACK_RATE),
  };
};

const readSeasonalDirectory = (
  context: DecodeContext,
  value: unknown,
): SeasonalDirectoryConfig | null => {
  if (!isPlainObject(value)) {
    context.report('warning', 'dropping a seasonal entry that is not an object');
    return null;
  }

  const pick = openSection({ context, value });
  const directory = pick('directory').value;
  if (typeof directory !== 'string' || directory.trim() === '') {
    context.report('warning', 'dropping a seasonal entry with no directory');
    return null;
  }

  // The legacy evaluator answered "no match" for a missing or non-object
  // condition set, so such an entry could never be picked. Dropping it keeps
  // that outcome and makes the dead entry visible in the startup log.
  const conditions = pick('conditions');
  if (!isPlainObject(conditions.value)) {
    context.report('warning', `dropping seasonal entry ${directory}: conditions must be an object`);
    return null;
  }

  const comment = pick('comment', '_comment');
  return {
    directory,
    // Legacy default: an entry without a likelihood never won its dice roll.
    likelihood: num(pick('likelihood'), 0, FRACTION),
    conditions: decodeTimeCondition(conditions.context, conditions.value),
    comment: nullableText(comment, null),
  };
};

/**
 * Resolves an untrusted config value against a complete base configuration.
 *
 * Absent fields fall back to `base` field by field, which is what the old
 * deep-merge-then-validate pass was approximating; arrays replace wholesale,
 * because listing three directories means exactly those three. Nothing throws:
 * every problem becomes an issue and the offending field falls back or clamps,
 * so a typo in one line cannot stop the app from starting.
 */
export const normalizeConfig = (
  raw: unknown,
  base: AppConfig = DEFAULT_CONFIG,
): NormalizedConfig => {
  const collector = createIssueCollector();
  const pick = openSection({ context: collector.context, value: raw });

  const directoriesField = pick('directories');
  const directories = strings(directoriesField, base.directories);
  if (directories.length === 0) {
    directoriesField.context.report('error', 'no video directories are configured');
  }

  const seasonalField = pick('seasonalDirectories');
  const config: AppConfig = {
    directories,
    seasonalDirectories: readArray(
      seasonalField.context,
      seasonalField.value,
      readSeasonalDirectory,
      base.seasonalDirectories,
    ),
    network: readNetwork(pick('network'), base.network),
    video: readVideo(pick('video'), base.video),
    performance: readPerformance(pick('performance'), base.performance),
    audio: readAudio(pick('audio'), base.audio),
    timeouts: readTimeouts(pick('timeouts'), base.timeouts),
    retries: readRetries(pick('retries'), base.retries),
    system: readSystem(pick('system'), base.system),
    files: readFiles(pick('files'), base.files),
    crossfade: readCrossfade(pick('crossfade'), base.crossfade),
    blur: readBlur(pick('blur'), base.blur),
    ui: readUi(pick('ui'), base.ui),
    playback: readPlayback(pick('playback'), base.playback),
  };

  return { config, issues: collector.issues() };
};
