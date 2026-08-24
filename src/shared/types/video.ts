import type { IsoTimestamp, ProcessedVideoPath, SourceVideoPath } from './brand';

/** How many discrete speakers a channel layout addresses. */
export type AudioProfile =
  | 'no-audio'
  | 'mono'
  | 'stereo'
  | '2.1-surround'
  | 'quadraphonic'
  | '4.0-surround'
  | '5.0-surround'
  | '5.1-surround'
  | '7.1-surround'
  | 'other-multichannel';

export interface AudioStreamInfo {
  readonly channels: number;
  /** ffmpeg layout name such as `stereo` or `5.1(side)`; derived when absent. */
  readonly channelLayout: string;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly bitrate: number | null;
  readonly profile: AudioProfile;
}

export interface VideoStreamInfo {
  readonly width: number | null;
  readonly height: number | null;
  readonly framesPerSecond: number | null;
  readonly codec: string | null;
}

export interface ContainerInfo {
  readonly fileSize: number | null;
  readonly bitrate: number | null;
  readonly formatName: string | null;
}

/** Everything ffprobe told us about a file, in a shape the app actually uses. */
export interface VideoMetadata {
  /** Length in seconds, or null when the container does not report one. */
  readonly duration: number | null;
  readonly video: VideoStreamInfo;
  readonly audio: AudioStreamInfo | null;
  readonly container: ContainerInfo;
}

/** A video file discovered while scanning a configured source directory. */
export interface IndexedVideo {
  readonly originalPath: SourceVideoPath;
  readonly filename: string;
  readonly directory: string;
  readonly addedAt: IsoTimestamp;
  /** Set when the file came from a seasonal directory rather than a regular one. */
  readonly seasonalDirectory: string | null;
}

/** When to start blending into the next video, in seconds from the start. */
export interface CrossfadeTiming {
  readonly duration: number;
  readonly startTime: number;
}

/** An indexed video that has been transcoded into the temp directory. */
export interface PreprocessedVideo extends IndexedVideo {
  readonly processedPath: ProcessedVideoPath;
  readonly processedAt: IsoTimestamp;
  readonly metadata: VideoMetadata;
  readonly crossfadeTiming: CrossfadeTiming | null;
}

/**
 * Where a client should load the transcoded file from. Electron reads the file
 * directly; browsers stream it over HTTP. Modelling this as a union removes the
 * "is `serverUrl` set?" guesswork that used to be repeated at every call site.
 */
export type VideoLocation =
  | { readonly kind: 'file'; readonly path: ProcessedVideoPath }
  | { readonly kind: 'http'; readonly url: string };

/** A preprocessed video plus the instructions needed to play it. */
export interface PlayableVideo extends PreprocessedVideo {
  readonly location: VideoLocation;
}

/**
 * A video the viewer has marked to be moved out of the library.
 *
 * Only the source path matters - the transcode is disposable and will be swept
 * anyway - but the filename and the timestamp are carried so that
 * `flagged_for_archive.json` can be read, and edited, by a person.
 */
export interface ArchiveFlag {
  readonly originalPath: SourceVideoPath;
  readonly filename: string;
  readonly flaggedAt: IsoTimestamp;
}

/** Why a video is being played, which decides whether it re-enters history. */
export type PlaybackOrigin = 'queue' | 'history';

export interface QueuedVideo {
  readonly video: PlayableVideo;
  readonly origin: PlaybackOrigin;
}
