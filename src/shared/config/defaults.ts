import type { AppConfig } from '../types/config';

/**
 * The single source of truth for every configuration default.
 *
 * `config.default.json` is the user-facing copy of this value written in the
 * on-disk key spelling; normalising that file must reproduce this object
 * exactly. Defaults live here rather than in the JSON so that a missing,
 * truncated or hand-broken default file cannot leave a field undefined, which
 * is how the previous implementation crashed on a fresh install.
 */
export const DEFAULT_CONFIG: AppConfig = {
  // Deliberately empty: an invented sample path pretends to be a working
  // install and hides the real problem. Startup reports the empty list instead.
  directories: [],
  seasonalDirectories: [],
  network: {
    server: {
      enabled: true,
      port: 3123,
      host: 'localhost',
      autoOpenBrowser: true,
      allowedOrigins: ['null'],
      authToken: '',
    },
  },
  video: {
    updateInterval: 900000,
    preprocessedQueueSize: 20,
    playbackQueueSize: 50,
    playbackQueueInitializationThreshold: 10,
    playbackHistorySize: 10,
    persistedHistorySize: 5000,
  },
  performance: {
    mode: 'balanced',
    cpuLimiting: {
      enabled: true,
      maxThreads: 2,
      processingDelay: 1000,
      threadQueueSize: 512,
      priority: 'normal',
    },
    presets: {
      quiet: {
        maxThreads: 1,
        processingDelay: 3000,
        threadQueueSize: 256,
        priority: 'low',
      },
      balanced: {
        maxThreads: 2,
        processingDelay: 1000,
        threadQueueSize: 512,
        priority: 'normal',
      },
      performance: {
        maxThreads: 4,
        processingDelay: 0,
        threadQueueSize: 1024,
        priority: 'normal',
      },
    },
  },
  audio: {
    surroundProcessingEnabled: true,
    outputChannels: 6,
    stereoUpmixing: {
      enabled: true,
      rearChannelLevel: 0.2,
      centerChannelLevel: 0.5,
      lfeChannelLevel: 0.3,
    },
    normalization: {
      enabled: true,
      strength: 'medium',
      targetLufs: -16,
      truePeak: -1.5,
      loudnessRange: 11,
      dualMono: true,
      presets: {
        light: { targetLufs: -12, truePeak: -1.0, loudnessRange: 15 },
        medium: { targetLufs: -16, truePeak: -1.5, loudnessRange: 11 },
        strong: { targetLufs: -20, truePeak: -2.0, loudnessRange: 8 },
        broadcast: { targetLufs: -23, truePeak: -1.0, loudnessRange: 7 },
      },
    },
    codecPreferences: {
      multichannel: 'aac',
      stereo: 'aac',
      multichannelBitrate: 384000,
      stereoBitrate: 256000,
    },
    compatibility: {
      preserveOriginalIfMultichannel: true,
      forceAac: true,
    },
  },
  timeouts: {
    videoLoadTimeout: 10000,
    videoTestTimeout: 5000,
    initializationRetryDelay: 2000,
    backgroundRecoveryDelay: 30000,
    queueMonitorInterval: 30000,
    periodicCleanupInterval: 300000,
    periodicSaveInterval: 60000,
    commandCooldown: 200,
    crossfadeBufferTime: 500,
    crossfadeMinDuration: 200,
    queueRefillDelay: 100,
    backgroundFillDelay: 500,
    backgroundFillRetryDelay: 2000,
    errorRecoveryDelay: 1000,
    debugUpdateInterval: 2000,
    statusDisplayDuration: 1500,
    connectionTimeout: 5000,
    browserOpenDelay: 1000,
    queueSyncInterval: 30000,
    transcodeTimeout: 1800000,
    probeTimeout: 60000,
    streamUrlLifetime: 43200000,
  },
  retries: {
    maxInitializationAttempts: 3,
    maxQueueBuildAttempts: 3,
  },
  system: {
    tempDirectory: './temp',
    cacheDirectory: './cache',
    archiveDirectory: './archive',
    logLevel: 'info',
    enableFileWatcher: true,
  },
  files: {
    supportedVideoExtensions: [
      '.mp4',
      '.avi',
      '.mov',
      '.wmv',
      '.flv',
      '.webm',
      '.mkv',
      '.m4v',
      '.3gp',
      '.mpeg',
      '.mpg',
      '.ts',
      '.mts',
      '.m2ts',
    ],
  },
  crossfade: {
    enabled: false,
    duration: 500,
  },
  blur: {
    enabled: false,
    maxAmount: 8,
  },
  ui: {
    infoDuration: 3000,
    errorDuration: 3000,
    tempInfoDuration: 3000,
    startFullscreen: true,
    showErrorToast: false,
  },
  playback: {
    skipSeconds: 5,
    speedIncrement: 0.25,
    minSpeed: 0.25,
    maxSpeed: 3,
  },
};
