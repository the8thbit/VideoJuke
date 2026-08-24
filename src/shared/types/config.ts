import type { DecodeIssue } from '../util/decode';
import type { NormalizedTimeCondition } from './time';

export type PerformanceMode = 'quiet' | 'balanced' | 'performance';
export type ProcessPriority = 'low' | 'normal' | 'high';
export type NormalizationPresetName = 'light' | 'medium' | 'strong' | 'broadcast';
export type AudioCodecName = 'aac' | 'ac3' | 'eac3';
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export const PERFORMANCE_MODES: readonly PerformanceMode[] = ['quiet', 'balanced', 'performance'];
export const PROCESS_PRIORITIES: readonly ProcessPriority[] = ['low', 'normal', 'high'];
export const NORMALIZATION_PRESET_NAMES: readonly NormalizationPresetName[] = [
  'light',
  'medium',
  'strong',
  'broadcast',
];
export const AUDIO_CODEC_NAMES: readonly AudioCodecName[] = ['aac', 'ac3', 'eac3'];
export const LOG_LEVEL_NAMES: readonly LogLevelName[] = ['debug', 'info', 'warn', 'error'];

export interface SeasonalDirectoryConfig {
  /** Absolute or project-relative directory scanned only while conditions hold. */
  readonly directory: string;
  /** Probability in the range 0..1 that this directory wins once it is active. */
  readonly likelihood: number;
  readonly conditions: NormalizedTimeCondition;
  /** Free-form note carried through from the config file, purely documentary. */
  readonly comment: string | null;
}

export interface ServerNetworkConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly host: string;
  readonly autoOpenBrowser: boolean;
  /**
   * Cross-origin pages allowed to call the API, as full origins.
   *
   * The browser client is served by this server, so its requests are
   * same-origin and never consult this list at all. The webOS app is the one
   * real cross-origin client: it runs from `file://`, which sends the literal
   * origin `null`, and that is why `null` is the default entry.
   *
   * The list used to be `*`. Since there is no authentication, that meant any
   * page the user happened to have open could drive their player, read the
   * paths of every video in their library, and - before the paths were
   * validated - have files deleted off their disk.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * The shared secret every client must present.
   *
   * Empty means "not chosen yet": the web server generates one on first run and
   * writes it back into config.json rather than serving an unprotected library
   * to whatever else is on the network. Only the web server uses it - the
   * Electron host talks to its own process over IPC and has nothing to
   * authenticate.
   */
  readonly authToken: string;
}

export interface NetworkConfig {
  readonly server: ServerNetworkConfig;
}

export interface VideoConfig {
  /** How often the source directories are re-scanned, in milliseconds. */
  readonly updateInterval: number;
  /** How many transcoded videos the server keeps ready. */
  readonly preprocessedQueueSize: number;
  /** How many videos the client keeps queued for playback. */
  readonly playbackQueueSize: number;
  /** How many videos the client requires before it starts playing. */
  readonly playbackQueueInitializationThreshold: number;
  /** Recent videos reachable with the "previous" command. */
  readonly playbackHistorySize: number;
  /** Long-term history retained on disk. */
  readonly persistedHistorySize: number;
}

export interface CpuLimitingConfig {
  readonly enabled: boolean;
  readonly maxThreads: number;
  /** Pause inserted before each transcode, in milliseconds. */
  readonly processingDelay: number;
  readonly threadQueueSize: number;
  readonly priority: ProcessPriority;
}

export interface PerformancePreset {
  readonly maxThreads: number;
  readonly processingDelay: number;
  readonly threadQueueSize: number;
  readonly priority: ProcessPriority;
}

export interface PerformanceConfig {
  readonly mode: PerformanceMode;
  readonly cpuLimiting: CpuLimitingConfig;
  readonly presets: Readonly<Record<PerformanceMode, PerformancePreset>>;
}

export interface StereoUpmixingConfig {
  readonly enabled: boolean;
  readonly rearChannelLevel: number;
  readonly centerChannelLevel: number;
  readonly lfeChannelLevel: number;
}

/** EBU R128 loudness parameters handed to the ffmpeg loudnorm filter. */
export interface LoudnessTarget {
  readonly targetLufs: number;
  readonly truePeak: number;
  readonly loudnessRange: number;
}

export interface NormalizationConfig extends LoudnessTarget {
  readonly enabled: boolean;
  readonly strength: NormalizationPresetName;
  readonly dualMono: boolean;
  readonly presets: Readonly<Record<NormalizationPresetName, LoudnessTarget>>;
}

export interface CodecPreferencesConfig {
  readonly multichannel: AudioCodecName;
  readonly stereo: AudioCodecName;
  readonly multichannelBitrate: number;
  readonly stereoBitrate: number;
}

export interface AudioCompatibilityConfig {
  readonly preserveOriginalIfMultichannel: boolean;
  readonly forceAac: boolean;
}

export interface AudioConfig {
  readonly surroundProcessingEnabled: boolean;
  readonly outputChannels: number;
  readonly stereoUpmixing: StereoUpmixingConfig;
  readonly normalization: NormalizationConfig;
  readonly codecPreferences: CodecPreferencesConfig;
  readonly compatibility: AudioCompatibilityConfig;
}

/** Every duration is in milliseconds. */
export interface TimeoutsConfig {
  readonly videoLoadTimeout: number;
  readonly videoTestTimeout: number;
  readonly initializationRetryDelay: number;
  readonly backgroundRecoveryDelay: number;
  readonly queueMonitorInterval: number;
  readonly periodicCleanupInterval: number;
  readonly periodicSaveInterval: number;
  readonly commandCooldown: number;
  readonly crossfadeBufferTime: number;
  readonly crossfadeMinDuration: number;
  readonly queueRefillDelay: number;
  readonly backgroundFillDelay: number;
  readonly backgroundFillRetryDelay: number;
  readonly errorRecoveryDelay: number;
  readonly debugUpdateInterval: number;
  readonly statusDisplayDuration: number;
  readonly connectionTimeout: number;
  readonly browserOpenDelay: number;
  /** How often the client mirrors its playback queue to the server. */
  readonly queueSyncInterval: number;
  /**
   * How long one ffmpeg run may take before it is killed. A transcode has no
   * deadline of its own, and the queue fill is exclusive, so a single child that
   * stops making progress - a broken file, a network source that stalls - would
   * otherwise hold the fill lock for the life of the process and the queue would
   * never be topped up again.
   */
  readonly transcodeTimeout: number;
  /** How long `ffprobe` may take. It reads headers, so it is far quicker. */
  readonly probeTimeout: number;
  /**
   * How long a signed stream URL stays usable.
   *
   * Generously long on purpose. The URL is signed when the video is handed to a
   * client, not when it is played, and a client holds a queue of them - with a
   * 50-deep queue and a viewer who pauses overnight, the last one in the queue
   * may not be played for many hours. Shortening this does not buy much on a
   * LAN: anyone who can read the URL can already reach the server.
   */
  readonly streamUrlLifetime: number;
}

export interface RetriesConfig {
  readonly maxInitializationAttempts: number;
  readonly maxQueueBuildAttempts: number;
}

export interface SystemConfig {
  readonly tempDirectory: string;
  readonly cacheDirectory: string;
  /**
   * Where `npm run archive` moves the videos flagged from the player.
   *
   * Kept out of the scan even when it sits inside a source directory, since the
   * point of archiving a video is that it stops coming round again.
   */
  readonly archiveDirectory: string;
  readonly logLevel: LogLevelName;
  /** Whether config.json is watched for changes while the app runs. */
  readonly enableFileWatcher: boolean;
}

export interface FilesConfig {
  /** Lower-case extensions including the leading dot. */
  readonly supportedVideoExtensions: readonly string[];
}

export interface CrossfadeConfig {
  readonly enabled: boolean;
  /** Nominal crossfade length in milliseconds. */
  readonly duration: number;
}

export interface BlurConfig {
  readonly enabled: boolean;
  /** Peak blur radius in CSS pixels. */
  readonly maxAmount: number;
}

export interface UiConfig {
  readonly infoDuration: number;
  readonly errorDuration: number;
  readonly tempInfoDuration: number;
  readonly startFullscreen: boolean;
  readonly showErrorToast: boolean;
}

export interface PlaybackConfig {
  readonly skipSeconds: number;
  readonly speedIncrement: number;
  readonly minSpeed: number;
  readonly maxSpeed: number;
}

/**
 * The fully resolved configuration. Every field is present and validated, so
 * consumers never need fallbacks: parsing happens exactly once, at the edge.
 */
export interface AppConfig {
  readonly directories: readonly string[];
  readonly seasonalDirectories: readonly SeasonalDirectoryConfig[];
  readonly network: NetworkConfig;
  readonly video: VideoConfig;
  readonly performance: PerformanceConfig;
  readonly audio: AudioConfig;
  readonly timeouts: TimeoutsConfig;
  readonly retries: RetriesConfig;
  readonly system: SystemConfig;
  readonly files: FilesConfig;
  readonly crossfade: CrossfadeConfig;
  readonly blur: BlurConfig;
  readonly ui: UiConfig;
  readonly playback: PlaybackConfig;
}

/**
 * The subset of the configuration a browser client needs. Source directories,
 * ffmpeg tuning and filesystem paths never leave the server.
 */
export type ClientConfig = Pick<
  AppConfig,
  'video' | 'timeouts' | 'retries' | 'crossfade' | 'blur' | 'ui' | 'playback'
>;

export const toClientConfig = (config: AppConfig): ClientConfig => ({
  video: config.video,
  timeouts: config.timeouts,
  retries: config.retries,
  crossfade: config.crossfade,
  blur: config.blur,
  ui: config.ui,
  playback: config.playback,
});

/** A single problem found while normalising a user config file. */
export type ConfigIssue = DecodeIssue;
