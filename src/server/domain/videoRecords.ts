import {
  asIsoTimestamp,
  asProcessedVideoPath,
  asSourceVideoPath,
  type IsoTimestamp,
} from '../../shared/types/brand';
import type {
  AudioStreamInfo,
  ContainerInfo,
  CrossfadeTiming,
  IndexedVideo,
  PreprocessedVideo,
  VideoMetadata,
  VideoStreamInfo,
} from '../../shared/types/video';
import { toIsoTimestamp } from '../../shared/time/clock';
import { classifyAudioProfile, deriveChannelLayout } from '../../shared/video/audioProfile';
import {
  readArray,
  readBoolean,
  readField,
  readNullableString,
  readNumber,
  readString,
  type DecodeContext,
} from '../../shared/util/decode';
import { parseNumber, parseRationalNumber } from '../../shared/util/numbers';
import { isPlainObject } from '../../shared/util/objects';
import type { VideoPathGuard } from './videoPaths';

/**
 * Reading a cache file is not like reading config.json: a bad field there is
 * not actionable, because the record is simply dropped and rebuilt by the next
 * scan. Issues are therefore discarded rather than collected, which also stops
 * a 5000-entry history from building a 5000-entry issue list on every startup.
 */
const DISCARD: DecodeContext = {
  path: '',
  report: () => {},
  at: () => DISCARD,
};

/**
 * Stands in for a timestamp the cache never recorded. The epoch is used rather
 * than "now" so that decoding stays pure and a missing stamp reads as unknown
 * instead of as a file that was just added.
 */
const UNKNOWN_TIMESTAMP: IsoTimestamp = toIsoTimestamp(0);

const EMPTY_VIDEO_STREAM: VideoStreamInfo = {
  width: null,
  height: null,
  framesPerSecond: null,
  codec: null,
};

const EMPTY_CONTAINER: ContainerInfo = {
  fileSize: null,
  bitrate: null,
  formatName: null,
};

const EMPTY_METADATA: VideoMetadata = {
  duration: null,
  video: EMPTY_VIDEO_STREAM,
  audio: null,
  container: EMPTY_CONTAINER,
};

/** Null unless the field holds a usable string; the gate for required fields. */
const requiredString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const decodeTimestamp = (value: unknown): IsoTimestamp =>
  asIsoTimestamp(readString(DISCARD, value, UNKNOWN_TIMESTAMP));

/**
 * Audio is rebuilt around the channel count rather than trusted wholesale: the
 * profile is a pure function of channels and layout, and the legacy files hold
 * open-ended values such as `7-channel` that are not in the `AudioProfile`
 * union at all. Deriving it keeps every stored record inside the type.
 */
const decodeAudioStreamInfo = (
  channels: number,
  channelLayout: string,
  codec: unknown,
  sampleRate: unknown,
  bitrate: unknown,
): AudioStreamInfo => ({
  channels,
  channelLayout,
  codec: readNullableString(DISCARD, codec, null),
  sampleRate: parseNumber(sampleRate),
  bitrate: parseNumber(bitrate),
  profile: classifyAudioProfile(channels, channelLayout),
});

const decodeChannelCount = (value: unknown): number =>
  readNumber(DISCARD, value, 0, { integer: true, min: 0 });

const decodeChannelLayout = (value: unknown, channels: number): string => {
  const stored = readNullableString(DISCARD, value, null);
  return stored === null || stored === '' ? deriveChannelLayout(channels) : stored;
};

const decodeNestedMetadata = (value: unknown): VideoMetadata => {
  const video = readField(value, 'video');
  const audio = readField(value, 'audio');
  const container = readField(value, 'container');
  const channels = decodeChannelCount(readField(audio, 'channels'));

  return {
    duration: parseNumber(readField(value, 'duration')),
    video: {
      width: parseNumber(readField(video, 'width')),
      height: parseNumber(readField(video, 'height')),
      framesPerSecond: parseRationalNumber(readField(video, 'framesPerSecond')),
      codec: readNullableString(DISCARD, readField(video, 'codec'), null),
    },
    audio: isPlainObject(audio)
      ? decodeAudioStreamInfo(
          channels,
          decodeChannelLayout(readField(audio, 'channelLayout'), channels),
          readField(audio, 'codec'),
          readField(audio, 'sampleRate'),
          readField(audio, 'bitrate'),
        )
      : null,
    container: {
      fileSize: parseNumber(readField(container, 'fileSize')),
      bitrate: parseNumber(readField(container, 'bitrate')),
      formatName: readNullableString(DISCARD, readField(container, 'formatName'), null),
    },
  };
};

/**
 * Converts the flat record written before metadata was grouped by stream. Its
 * `container` field held the format name as a bare string, which is what makes
 * the two shapes safely distinguishable.
 */
const decodeLegacyMetadata = (value: unknown): VideoMetadata => {
  const channels = decodeChannelCount(readField(value, 'audioChannels'));
  const channelLayout = decodeChannelLayout(readField(value, 'channelLayout'), channels);
  const hasAudio = readBoolean(DISCARD, readField(value, 'hasAudio'), channels > 0);

  return {
    duration: parseNumber(readField(value, 'duration')),
    video: {
      width: parseNumber(readField(value, 'width')),
      height: parseNumber(readField(value, 'height')),
      framesPerSecond: parseRationalNumber(readField(value, 'fps')),
      codec: readNullableString(DISCARD, readField(value, 'videoCodec'), null),
    },
    audio: hasAudio
      ? decodeAudioStreamInfo(
          channels,
          channelLayout,
          readField(value, 'audioCodec'),
          readField(value, 'sampleRate'),
          readField(value, 'audioBitrate'),
        )
      : null,
    container: {
      fileSize: parseNumber(readField(value, 'fileSize')),
      bitrate: parseNumber(readField(value, 'bitrate')),
      formatName: readNullableString(DISCARD, readField(value, 'container'), null),
    },
  };
};

/**
 * Accepts both the nested shape and the flat one older caches hold, so that an
 * existing persisted history keeps working across the upgrade. Unusable input
 * yields empty metadata rather than dropping the record: the file itself is
 * still playable, and ffprobe can fill the gaps the next time it runs.
 */
export const decodeVideoMetadata = (value: unknown): VideoMetadata => {
  if (!isPlainObject(value)) return EMPTY_METADATA;
  const isNested = isPlainObject(value['video']) || isPlainObject(value['container']);
  return isNested ? decodeNestedMetadata(value) : decodeLegacyMetadata(value);
};

/**
 * Null when the timing is absent or nonsensical, which callers read as "not
 * computed yet"; `withCrossfadeTiming` then derives it from the duration.
 */
const decodeCrossfadeTiming = (value: unknown): CrossfadeTiming | null => {
  if (!isPlainObject(value)) return null;
  const duration = parseNumber(value['duration']);
  const startTime = parseNumber(value['startTime']);
  if (duration === null || duration <= 0 || startTime === null) return null;
  return { duration, startTime: Math.max(0, startTime) };
};

/**
 * Null when the record has no source path or filename, since neither can be
 * reconstructed and everything downstream identifies videos by their path, and
 * null again when the path is not one `guard` is willing to act on. The guard is
 * a required argument rather than an option because every caller of this
 * function is decoding something it did not produce itself.
 */
export const decodeIndexedVideo = (
  value: unknown,
  guard: VideoPathGuard,
): IndexedVideo | null => {
  const originalPath = requiredString(readField(value, 'originalPath'));
  const filename = requiredString(readField(value, 'filename'));
  if (originalPath === null || filename === null) return null;
  if (!guard.acceptsSource(originalPath)) return null;

  return {
    originalPath: asSourceVideoPath(originalPath),
    filename,
    directory: readString(DISCARD, readField(value, 'directory'), ''),
    addedAt: decodeTimestamp(readField(value, 'addedAt')),
    seasonalDirectory: readNullableString(DISCARD, readField(value, 'seasonalDirectory'), null),
  };
};

export const decodePreprocessedVideo = (
  value: unknown,
  guard: VideoPathGuard,
): PreprocessedVideo | null => {
  const indexed = decodeIndexedVideo(value, guard);
  if (indexed === null) return null;

  const processedPath = requiredString(readField(value, 'processedPath'));
  if (processedPath === null) return null;
  if (!guard.acceptsProcessed(processedPath)) return null;

  return {
    ...indexed,
    processedPath: asProcessedVideoPath(processedPath),
    processedAt: decodeTimestamp(readField(value, 'processedAt')),
    metadata: decodeVideoMetadata(readField(value, 'metadata')),
    crossfadeTiming: decodeCrossfadeTiming(readField(value, 'crossfadeTiming')),
  };
};

/** Drops the entries that fail to decode; a non-array value yields no entries. */
export const decodePreprocessedVideoList = (
  value: unknown,
  guard: VideoPathGuard,
): readonly PreprocessedVideo[] =>
  readArray(DISCARD, value, (_itemContext, item) => decodePreprocessedVideo(item, guard), []);
