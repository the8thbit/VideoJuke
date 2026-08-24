import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { asIsoTimestamp, asProcessedVideoPath, asSourceVideoPath } from '../src/shared/types/brand';
import { toClientConfig, type ClientConfig } from '../src/shared/types/config';
import type { PlayableVideo, QueuedVideo } from '../src/shared/types/video';
import { createPlaybackQueue } from '../src/client/core/queue/playbackQueue';
import { fakeDocument, settle } from './support/fakeMedia';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const clientConfig = (overrides: Record<string, unknown> = {}): ClientConfig =>
  toClientConfig(normalizeConfig({ directories: ['/videos'], ...overrides }).config);

const playable = (name: string): PlayableVideo => ({
  originalPath: asSourceVideoPath(`/videos/${name}.mp4`),
  filename: `${name}.mp4`,
  directory: '/videos',
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory: null,
  processedPath: asProcessedVideoPath(`/temp/processed_${name}.mp4`),
  processedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  metadata: {
    duration: 60,
    video: { width: 1920, height: 1080, framesPerSecond: 30, codec: 'h264' },
    audio: null,
    container: { fileSize: null, bitrate: null, formatName: null },
  },
  crossfadeTiming: { duration: 0.5, startTime: 59 },
  location: { kind: 'file', path: asProcessedVideoPath(`/temp/processed_${name}.mp4`) },
});

const asQueued = (name: string): QueuedVideo => ({ video: playable(name), origin: 'queue' });

/** A server with `count` videos to give, then nothing. */
const makeQueue = (
  count: number,
  config: ClientConfig = clientConfig({
    video: { playbackQueueSize: 5, playbackQueueInitializationThreshold: 3 },
  }),
  broken: ReadonlySet<string> = new Set(),
) => {
  const handedOut: string[] = [];
  const reportedErrors: string[] = [];
  let served = 0;
  const { document } = fakeDocument({ broken });

  const queue = createPlaybackQueue({
    api: {
      takeNextVideo: async () => {
        if (served >= count) return null;
        const video = playable(`v${served}`);
        served += 1;
        handedOut.push(video.filename);
        return video;
      },
      recordVideoError: async (message) => {
        reportedErrors.push(message);
      },
    },
    config,
    logger: silentLogger,
    origin: null,
    document: document as unknown as Document,
  });

  return { queue, handedOut, reportedErrors, servedCount: () => served };
};

describe('playback queue under rapid stepping', () => {
  it('builds up to the initialization threshold', async () => {
    const { queue } = makeQueue(10);
    const built = await queue.buildInitial();
    assert.equal(built, true);
    assert.ok(queue.size() >= 3, `expected at least the threshold, got ${queue.size()}`);
    queue.cleanup();
  });

  it('hands videos out in order and never the same one twice', async () => {
    const { queue } = makeQueue(10);
    await queue.buildInitial();

    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = queue.takeNext();
      if (next !== null) seen.push(next.video.filename);
    }

    assert.deepEqual(seen, ['v0.mp4', 'v1.mp4', 'v2.mp4']);
    assert.equal(new Set(seen).size, seen.length);
    queue.cleanup();
  });

  it('refuses to re-queue a video it is already holding', async () => {
    const { queue } = makeQueue(10);
    await queue.buildInitial();

    const taken = queue.takeNext();
    assert.notEqual(taken, null);
    assert.equal(queue.pushFront(taken as QueuedVideo), true, 'the first push back is accepted');
    assert.equal(queue.pushFront(taken as QueuedVideo), false, 'the second is a duplicate');

    const paths = queue.snapshot().map((entry) => entry.originalPath);
    assert.equal(new Set(paths).size, paths.length);
    queue.cleanup();
  });

  it('stays bounded when the viewer steps back over and over', async () => {
    // Every step back pushes the outgoing video to the front. Without a ceiling
    // the client's queue would grow for as long as the viewer kept pressing.
    const config = clientConfig({
      video: { playbackQueueSize: 5, playbackQueueInitializationThreshold: 3 },
    });
    const { queue } = makeQueue(50, config);
    await queue.buildInitial();

    const ceiling = 5 + Math.floor(5 * 0.2);
    for (let i = 0; i < 200; i += 1) {
      queue.pushFront(asQueued(`extra${i}`));
      assert.ok(queue.size() <= ceiling, `queue grew to ${queue.size()} on step ${i}`);

      const paths = queue.snapshot().map((entry) => entry.originalPath);
      assert.equal(new Set(paths).size, paths.length, 'a duplicate appeared');
    }
    queue.cleanup();
  });

  it('survives take and push alternating as fast as they can be called', async () => {
    const { queue } = makeQueue(50);
    await queue.buildInitial();

    for (let i = 0; i < 300; i += 1) {
      const taken = queue.takeNext();
      if (taken !== null && i % 3 !== 0) queue.pushFront(taken);
      assert.ok(queue.size() >= 0);
      const paths = queue.snapshot().map((entry) => entry.originalPath);
      assert.equal(new Set(paths).size, paths.length);
    }
    queue.cleanup();
  });

  it('empties cleanly and reports nothing rather than handing back rubbish', async () => {
    const { queue } = makeQueue(2);
    await queue.buildInitial();

    const drained: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const next = queue.takeNext();
      if (next !== null) drained.push(next.video.filename);
    }

    assert.deepEqual(drained, ['v0.mp4', 'v1.mp4']);
    assert.equal(queue.takeNext(), null);
    assert.equal(queue.size(), 0);
    queue.cleanup();
  });

  it('gives up rather than spinning when the server only serves broken files', async () => {
    // Every candidate fails to decode. The fill must stop, not loop forever.
    const broken = new Set(
      Array.from({ length: 20 }, (_, i) => `file:///temp/processed_v${i}.mp4`),
    );
    const { queue, reportedErrors } = makeQueue(20, undefined, broken);

    const built = await queue.buildInitial();
    await settle();

    assert.equal(built, false, 'an all-broken library cannot start');
    assert.equal(queue.size(), 0);
    assert.ok(reportedErrors.length > 0, 'the failures must reach the server');
    assert.ok(reportedErrors.length < 20, 'and it must stop before exhausting the library');
    queue.cleanup();
  });

  it('releases its probe element on cleanup', async () => {
    const { document, appended } = fakeDocument();
    const queue = createPlaybackQueue({
      api: { takeNextVideo: async () => null, recordVideoError: async () => undefined },
      config: clientConfig(),
      logger: silentLogger,
      origin: null,
      document: document as unknown as Document,
    });

    await queue.fill(1);
    queue.cleanup();
    assert.deepEqual(appended, [], 'the hidden probe element must be detached');
  });
});
