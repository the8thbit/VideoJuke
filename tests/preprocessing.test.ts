import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { asIsoTimestamp, asProcessedVideoPath, asSourceVideoPath } from '../src/shared/types/brand';
import type { AppConfig } from '../src/shared/types/config';
import { ok } from '../src/shared/types/result';
import type { AudioStreamInfo, IndexedVideo, PreprocessedVideo } from '../src/shared/types/video';
import { classifyAudioProfile, deriveChannelLayout } from '../src/shared/video/audioProfile';
import {
  canCopyAudio,
  describeTranscodePlan,
  planTranscode,
} from '../src/shared/video/encoding';
import { createPreprocessedQueue, describeFill } from '../src/server/domain/preprocessedQueue';
import type { PreprocessStage, Preprocessor } from '../src/server/domain/preprocessor';
import { createTaskLimiter } from '../src/server/domain/preprocessor';
import { UNCHECKED_VIDEO_PATHS } from '../src/server/domain/videoPaths';
import type { VideoIndex } from '../src/server/domain/videoIndex';
import type { FileSystem } from '../src/server/infra/fileSystem';

const configWith = (overrides: Record<string, unknown> = {}): AppConfig =>
  normalizeConfig({ directories: ['/videos'], ...overrides }).config;

const NO_NORMALIZATION = { normalization: { enabled: false } };

const audio = (channels: number, codec = 'aac'): AudioStreamInfo => {
  const channelLayout = deriveChannelLayout(channels);
  return {
    channels,
    channelLayout,
    codec,
    sampleRate: 48000,
    bitrate: 128000,
    profile: classifyAudioProfile(channels, channelLayout),
  };
};

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('running transcodes side by side', () => {
  it('never runs more than the limit at once, and queues the rest in order', async () => {
    const limiter = createTaskLimiter(() => 2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates: (() => void)[] = [];
    const tasks = [0, 1, 2, 3, 4].map((index) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(index);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return index;
      }),
    );

    await settle();
    assert.equal(running, 2, 'two start at once');
    while (gates.length > 0) {
      (gates.shift() as () => void)();
      await settle();
    }
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it('takes up a raised limit as soon as a slot frees', async () => {
    let limit = 1;
    const limiter = createTaskLimiter(() => limit);
    let running = 0;
    const gates: (() => void)[] = [];
    const block = (): Promise<void> =>
      limiter.run(async () => {
        running += 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
      });
    const all = [block(), block(), block()];
    await settle();
    assert.equal(running, 1);
    limit = 3;
    (gates.shift() as () => void)();
    await settle();
    assert.equal(running, 2, 'both waiting tasks start together');
    while (gates.length > 0) {
      (gates.shift() as () => void)();
      await settle();
    }
    await Promise.all(all);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = createTaskLimiter(() => 1);
    await assert.rejects(limiter.run(() => Promise.reject(new Error('ffmpeg died'))));
    assert.equal(await limiter.run(() => Promise.resolve('next')), 'next');
  });
});

describe('copying audio that needs no work', () => {
  it('copies only when normalization is off', () => {
    assert.equal(canCopyAudio(audio(2), configWith()), false);
    assert.equal(
      canCopyAudio(audio(2), configWith({ audio: { ...NO_NORMALIZATION, surroundProcessingEnabled: false } })),
      true,
    );
  });

  it('still upmixes stereo when 5.1 output is asked for', () => {
    const config = configWith({ audio: NO_NORMALIZATION });
    assert.equal(canCopyAudio(audio(2), config), false);
    assert.equal(canCopyAudio(audio(6), config), true, 'a 5.1 source is already what is wanted');
  });

  it('copies stereo when upmixing is switched off', () => {
    const config = configWith({ audio: { ...NO_NORMALIZATION, stereoUpmixing: { enabled: false } } });
    assert.equal(canCopyAudio(audio(2), config), true);
  });

  it('re-encodes anything that is not AAC', () => {
    const config = configWith({ audio: { ...NO_NORMALIZATION, surroundProcessingEnabled: false } });
    assert.equal(canCopyAudio(audio(2, 'ac3'), config), false);
    assert.equal(canCopyAudio(audio(2, 'mp3'), config), false);
  });

  it('copies a silent video, which the full chain gives no audio either', () => {
    assert.equal(canCopyAudio(null, configWith({ audio: NO_NORMALIZATION })), true);
  });

  it('plans a copy only when allowed and not retrying in compatibility mode', () => {
    const config = configWith({ audio: { ...NO_NORMALIZATION, surroundProcessingEnabled: false } });
    const copy = planTranscode(audio(2), config, { compatibilityMode: false });
    assert.equal(copy.copyAudio, true);
    assert.deepEqual(copy.audioFilters, []);
    assert.equal(planTranscode(audio(2), config, { compatibilityMode: true }).copyAudio, false);
    assert.equal(
      planTranscode(audio(2), config, { compatibilityMode: false, allowCopy: false }).copyAudio,
      false,
    );
  });
});

describe('what the progress line says about a video', () => {
  it('names the audio work a plan does', () => {
    assert.equal(
      describeTranscodePlan(planTranscode(audio(2), configWith(), { compatibilityMode: false })),
      'Normalizing loudness and upmixing to 5.1',
    );
    assert.equal(
      describeTranscodePlan(
        planTranscode(audio(2), configWith({ audio: { outputChannels: 2 } }), { compatibilityMode: false }),
      ),
      'Normalizing loudness',
    );
    assert.equal(
      describeTranscodePlan(
        planTranscode(audio(2, 'mp3'), configWith({ audio: { ...NO_NORMALIZATION, surroundProcessingEnabled: false } }), {
          compatibilityMode: false,
        }),
      ),
      'Re-encoding audio',
    );
    assert.equal(
      describeTranscodePlan(
        planTranscode(audio(2), configWith({ audio: { ...NO_NORMALIZATION, surroundProcessingEnabled: false } }), {
          compatibilityMode: false,
        }),
      ),
      'Copying',
    );
  });

  it('lists each video being prepared under the count', () => {
    const text = describeFill('Preparing videos', {
      current: 1,
      target: 3,
      working: [
        { filename: 'beach day.mp4', label: 'Normalizing loudness', progress: 0.456 },
        { filename: 'clip.mkv', label: 'Reading', progress: null },
      ],
    });
    assert.equal(
      text,
      'Preparing videos: 1 of 3 ready\nNormalizing loudness · beach day.mp4 · 46%\nReading · clip.mkv',
    );
  });

  it('shortens a long name from the middle', () => {
    const name = `${'a'.repeat(40)}${'b'.repeat(40)}.mp4`;
    const line = describeFill('x', {
      current: 0,
      target: 1,
      working: [{ filename: name, label: 'Copying', progress: null }],
    }).split('\n')[1] as string;
    const shown = line.slice('Copying · '.length);
    assert.equal(shown.length, 48);
    assert.ok(shown.startsWith('aaaa') && shown.endsWith('b.mp4') && shown.includes('…'));
  });
});

describe('filling the queue several videos at a time', () => {
  const source = (index: number): IndexedVideo => ({
    originalPath: asSourceVideoPath(`/videos/v${index}.mp4`),
    filename: `v${index}.mp4`,
    directory: '/videos',
    addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
    seasonalDirectory: null,
  });

  const build = (parallelTranscodes: number) => {
    const library = [0, 1, 2, 3, 4, 5].map(source);
    const videoIndex = {
      selectVideo: (excluded: ReadonlySet<string>) =>
        library.find((video) => !excluded.has(video.originalPath)) ?? null,
    } as unknown as VideoIndex;
    const fileSystem = {
      exists: () => Promise.resolve(true),
      remove: () => Promise.resolve(ok(undefined)),
    } as unknown as FileSystem;

    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const preprocessor: Preprocessor = {
      preprocess: async (video, onStage?: (stage: PreprocessStage) => void) => {
        running += 1;
        peak = Math.max(peak, running);
        onStage?.({ label: 'Copying', progress: 0.5 });
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        const done: PreprocessedVideo = {
          ...video,
          processedPath: asProcessedVideoPath(`/temp/processed_${video.filename}`),
          processedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
          metadata: { duration: 10, video: null, audio: null, container: null } as never,
          crossfadeTiming: null,
        };
        return ok(done);
      },
    };

    const reports: { current: number; working: number }[] = [];
    const queue = createPreprocessedQueue({
      fileSystem,
      preprocessor,
      videoIndex,
      logger: silentLogger,
      config: () => configWith({ performance: { parallelTranscodes } }),
      onStatsChange: () => undefined,
      videoPaths: UNCHECKED_VIDEO_PATHS,
    });
    return { queue, gates, reports, peak: () => peak, running: () => running };
  };

  it('keeps the configured number of transcodes running until the target is met', async () => {
    const { queue, gates, peak, running } = build(2);
    const seen: string[][] = [];
    const filling = queue.fill(4, (progress) => {
      seen.push(progress.working.map((video) => video.filename));
    });
    await settle();
    assert.equal(running(), 2);
    assert.ok(seen.some((names) => names.length === 2), 'both are listed while they run');
    while (queue.size() < 4) {
      (gates.shift() as () => void)();
      await settle();
    }
    await filling;
    assert.equal(peak(), 2);
    assert.equal(queue.size(), 4);
    const paths = queue.snapshot().map((video) => video.originalPath);
    assert.equal(new Set(paths).size, 4, 'no video is prepared twice');
  });

  it('runs one at a time when set to 1', async () => {
    const { queue, gates, peak } = build(1);
    const filling = queue.fill(3);
    await settle();
    while (queue.size() < 3) {
      (gates.shift() as () => void)();
      await settle();
    }
    await filling;
    assert.equal(peak(), 1);
  });
});
