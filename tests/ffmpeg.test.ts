import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { describe, it } from 'node:test';

import { PRIORITY_VALUES, isRecoverableAudioError, toVideoMetadata } from '../src/server/infra/ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';

describe('process priority mapping', () => {
  it('lowers and raises in the directions the names promise', () => {
    assert.equal(PRIORITY_VALUES.low, constants.priority.PRIORITY_LOW);
    assert.equal(PRIORITY_VALUES.normal, constants.priority.PRIORITY_NORMAL);
    assert.ok(PRIORITY_VALUES.low > PRIORITY_VALUES.normal, 'low must be a higher nice value');
    assert.ok(PRIORITY_VALUES.high < PRIORITY_VALUES.normal, 'high must be a lower nice value');
  });

  it('keeps "high" below the highest class on purpose', () => {
    // Deliberate, and worth pinning so it is not "corrected" later: on Windows
    // PRIORITY_HIGH outranks most of the desktop, and an encoder that outranks
    // the compositor makes the machine unusable while it works.
    assert.equal(PRIORITY_VALUES.high, constants.priority.PRIORITY_ABOVE_NORMAL);
    assert.notEqual(PRIORITY_VALUES.high, constants.priority.PRIORITY_HIGH);
  });
});

describe('isRecoverableAudioError', () => {
  it('retries in compatibility mode for a filter-graph failure', () => {
    assert.equal(isRecoverableAudioError('Error reinitializing filters! pan=5.1 failed'), true);
    assert.equal(isRecoverableAudioError('Invalid channel layout for loudnorm'), true);
  });

  it('does not retry a failure that has nothing to do with audio', () => {
    assert.equal(isRecoverableAudioError('No such file or directory'), false);
    assert.equal(isRecoverableAudioError('moov atom not found'), false);
  });

  it('ignores the source path when deciding', () => {
    // ffmpeg quotes the command line back in its error text, so a library at
    // `X:/videos/channel surfing` matched "channel" and a folder named `Japan`
    // matched "pan": every unrelated failure spent a second full transcode
    // failing in exactly the same way.
    const path = 'X:/videos/channel surfing/Japan/clip.mp4';
    const message = `${path}: No such file or directory`;
    assert.equal(isRecoverableAudioError(message), true, 'without the path it still matches');
    assert.equal(isRecoverableAudioError(message, path), false, 'with the path it does not');
  });

  it('still catches a real audio failure that mentions the path', () => {
    const path = 'X:/videos/clip.mp4';
    assert.equal(
      isRecoverableAudioError(`${path}: Invalid channel layout`, path),
      true,
    );
  });
});

/**
 * Which stream a probe describes has to be the one ffmpeg will encode, because
 * `applyPlan` emits no `-map` and therefore leaves the choice to ffmpeg's own
 * default selection. The expectations below were taken from the bundled
 * `ffmpeg-static` binary on three-stream files built for the purpose.
 */
describe('choosing the stream a probe describes', () => {
  const stream = (
    index: number,
    codecType: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    index,
    codec_type: codecType,
    codec_name: codecType === 'audio' ? 'aac' : 'h264',
    disposition: { default: 0, attached_pic: 0 },
    ...extra,
  });

  const probe = (streams: readonly Record<string, unknown>[]): FfprobeData =>
    ({ streams, format: { duration: '10' } }) as unknown as FfprobeData;

  const video = stream(0, 'video', { width: 1920, height: 1080, r_frame_rate: '30/1' });

  it('describes the audio stream with the most channels, not the first one', () => {
    // A rip carrying a stereo mixdown or a commentary track first is the
    // ordinary case. Describing that one and then applying its two-channel pan
    // to the 5.1 stream ffmpeg picks discards the real surround content, and
    // nothing fails while it happens.
    const metadata = toVideoMetadata(
      probe([
        video,
        stream(1, 'audio', { channels: 2, channel_layout: 'stereo' }),
        stream(2, 'audio', { channels: 6, channel_layout: '5.1' }),
      ]),
    );
    assert.equal(metadata.audio?.channels, 6);
  });

  it('lets the default disposition outrank the channel count, as ffmpeg does', () => {
    const metadata = toVideoMetadata(
      probe([
        video,
        stream(1, 'audio', {
          channels: 1,
          channel_layout: 'mono',
          disposition: { default: 1, attached_pic: 0 },
        }),
        stream(2, 'audio', { channels: 6, channel_layout: '5.1' }),
      ]),
    );
    assert.equal(metadata.audio?.channels, 1, 'a flagged stream wins however small it is');
  });

  it('keeps the lowest index when nothing separates two streams', () => {
    const metadata = toVideoMetadata(
      probe([
        video,
        stream(1, 'audio', { channels: 6, channel_layout: '5.1', codec_name: 'ac3' }),
        stream(2, 'audio', { channels: 6, channel_layout: '5.1', codec_name: 'eac3' }),
      ]),
    );
    assert.equal(metadata.audio?.codec, 'ac3');
  });

  it('never describes cover art as the picture', () => {
    const metadata = toVideoMetadata(
      probe([
        stream(0, 'video', {
          width: 300,
          height: 300,
          disposition: { default: 1, attached_pic: 1 },
        }),
        stream(1, 'video', { width: 1920, height: 1080, r_frame_rate: '30/1' }),
        stream(2, 'audio', { channels: 2, channel_layout: 'stereo' }),
      ]),
    );
    assert.equal(metadata.video.width, 1920);
    assert.equal(metadata.video.height, 1080);
  });

  it('reports no audio at all for a file that carries none', () => {
    assert.equal(toVideoMetadata(probe([video])).audio, null);
  });
});
