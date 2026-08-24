import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeIndexedVideo,
  decodePreprocessedVideo,
  decodePreprocessedVideoList,
  decodeVideoMetadata,
} from '../src/server/domain/videoRecords';
import { UNCHECKED_VIDEO_PATHS } from '../src/server/domain/videoPaths';

/**
 * A verbatim record from a real cache/persisted-history.json, with the paths
 * redacted. Existing installations hold thousands of these, and losing them
 * would throw away a user's entire watch history, so the decoders have to keep
 * reading the flat metadata shape the old preprocessor wrote.
 */
const LEGACY_RECORD = {
  originalPath: 'X:/videos/example.mp4',
  filename: 'example.mp4',
  directory: 'X:/videos',
  addedAt: '2026-05-26T07:27:35.155Z',
  metadata: {
    duration: 14.186,
    width: 576,
    height: 1024,
    fps: 30,
    videoCodec: 'h264',
    hasAudio: true,
    audioChannels: 2,
    channelLayout: 'stereo',
    audioCodec: 'aac',
    sampleRate: 44100,
    audioBitrate: 32116,
    fileSize: 4213466,
    bitrate: 2376126,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    audioProfile: 'stereo',
    requiresUpmixing: true,
    streams: {
      video: { codec: 'h264', profile: 'High', level: 32 },
      audio: { codec: 'aac', channels: 2, layout: 'stereo' },
    },
  },
  processedPath: 'C:/temp/processed_x.mp4',
  processedAt: '2026-05-26T07:27:55.788Z',
  crossfadeTiming: { duration: 0.5, startTime: 13.186 },
  // The legacy history manager stamped this; nothing reads it any more.
  addedToHistoryAt: '2026-05-26T07:29:44.785Z',
};

const CURRENT_RECORD = {
  originalPath: 'X:/videos/current.mp4',
  filename: 'current.mp4',
  directory: 'X:/videos',
  addedAt: '2026-08-21T00:00:00.000Z',
  seasonalDirectory: null,
  processedPath: 'C:/temp/processed_y.mp4',
  processedAt: '2026-08-21T00:00:10.000Z',
  metadata: {
    duration: 30,
    video: { width: 1920, height: 1080, framesPerSecond: 25, codec: 'h264' },
    audio: {
      channels: 6,
      channelLayout: '5.1',
      codec: 'aac',
      sampleRate: 48000,
      bitrate: 384000,
      profile: '5.1-surround',
    },
    container: { fileSize: 1024, bitrate: 2048, formatName: 'mp4' },
  },
  crossfadeTiming: null,
};

describe('decodeVideoMetadata', () => {
  it('converts the legacy flat shape into the nested one', () => {
    const metadata = decodeVideoMetadata(LEGACY_RECORD.metadata);

    assert.equal(metadata.duration, 14.186);
    assert.deepEqual(metadata.video, {
      width: 576,
      height: 1024,
      framesPerSecond: 30,
      codec: 'h264',
    });
    assert.equal(metadata.audio?.channels, 2);
    assert.equal(metadata.audio?.channelLayout, 'stereo');
    assert.equal(metadata.audio?.codec, 'aac');
    assert.equal(metadata.audio?.sampleRate, 44100);
    // The profile is derived, not trusted: it is a pure function of the layout.
    assert.equal(metadata.audio?.profile, 'stereo');
    assert.deepEqual(metadata.container, {
      fileSize: 4213466,
      bitrate: 2376126,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
  });

  it('reads the current nested shape unchanged', () => {
    assert.deepEqual(decodeVideoMetadata(CURRENT_RECORD.metadata), CURRENT_RECORD.metadata);
  });

  it('reports no audio when the legacy record said so', () => {
    const metadata = decodeVideoMetadata({ duration: 5, hasAudio: false, audioChannels: 0 });
    assert.equal(metadata.audio, null);
  });

  it('derives a layout the legacy record omitted', () => {
    const metadata = decodeVideoMetadata({ duration: 5, hasAudio: true, audioChannels: 6 });
    assert.equal(metadata.audio?.channelLayout, '5.1');
    assert.equal(metadata.audio?.profile, '5.1-surround');
  });

  it('degrades to an empty description rather than throwing', () => {
    for (const value of [null, undefined, 'nonsense', 42]) {
      const metadata = decodeVideoMetadata(value);
      assert.equal(metadata.duration, null);
      assert.equal(metadata.audio, null);
    }
  });
});

describe('decodePreprocessedVideo', () => {
  it('reads a legacy history entry end to end', () => {
    const video = decodePreprocessedVideo(LEGACY_RECORD, UNCHECKED_VIDEO_PATHS);

    assert.notEqual(video, null);
    assert.equal(video?.filename, 'example.mp4');
    assert.equal(video?.originalPath, 'X:/videos/example.mp4');
    assert.equal(video?.processedPath, 'C:/temp/processed_x.mp4');
    assert.equal(video?.seasonalDirectory, null);
    assert.deepEqual(video?.crossfadeTiming, { duration: 0.5, startTime: 13.186 });
    assert.equal(video?.metadata.audio?.channels, 2);
  });

  it('drops the markers the new design replaced', () => {
    const video = decodePreprocessedVideo(
      { ...LEGACY_RECORD, _fromHistory: true, fromPlaybackQueue: true },
      UNCHECKED_VIDEO_PATHS,
    );

    assert.equal(Object.prototype.hasOwnProperty.call(video ?? {}, '_fromHistory'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(video ?? {}, 'fromPlaybackQueue'), false);
  });

  it('rejects a record with nothing to play', () => {
    const { processedPath: _dropped, ...withoutProcessed } = LEGACY_RECORD;
    assert.equal(decodePreprocessedVideo(withoutProcessed, UNCHECKED_VIDEO_PATHS), null);

    const { originalPath: _also, ...withoutOriginal } = LEGACY_RECORD;
    assert.equal(decodePreprocessedVideo(withoutOriginal, UNCHECKED_VIDEO_PATHS), null);

    assert.equal(decodePreprocessedVideo(null, UNCHECKED_VIDEO_PATHS), null);
    assert.equal(decodePreprocessedVideo('nope', UNCHECKED_VIDEO_PATHS), null);
  });
});

describe('decodeIndexedVideo', () => {
  it('keeps the seasonal directory when there is one', () => {
    const video = decodeIndexedVideo(
      {
        originalPath: 'X:/seasonal/pride/a.mp4',
        filename: 'a.mp4',
        directory: 'X:/seasonal/pride',
        addedAt: '2026-06-01T00:00:00.000Z',
        seasonalDirectory: 'X:/seasonal/pride',
      },
      UNCHECKED_VIDEO_PATHS,
    );

    assert.equal(video?.seasonalDirectory, 'X:/seasonal/pride');
  });

  it('rejects a record without a path', () => {
    assert.equal(decodeIndexedVideo({ filename: 'a.mp4' }, UNCHECKED_VIDEO_PATHS), null);
  });
});

describe('decodePreprocessedVideoList', () => {
  it('keeps the readable entries and discards the rest', () => {
    const decoded = decodePreprocessedVideoList(
      [LEGACY_RECORD, null, { filename: 'broken.mp4' }, CURRENT_RECORD],
      UNCHECKED_VIDEO_PATHS,
    );

    assert.deepEqual(
      decoded.map((video) => video.filename),
      ['example.mp4', 'current.mp4'],
    );
  });

  it('treats a non-array as empty rather than failing the load', () => {
    assert.deepEqual(decodePreprocessedVideoList(undefined, UNCHECKED_VIDEO_PATHS), []);
    assert.deepEqual(
      decodePreprocessedVideoList({ persistedHistory: [] }, UNCHECKED_VIDEO_PATHS),
      [],
    );
  });
});
