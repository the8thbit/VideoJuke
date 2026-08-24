import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { EMPTY_HISTORY, recordPlayed, takePrevious } from '../src/shared/queue/history';
import { asIsoTimestamp, asProcessedVideoPath, asSourceVideoPath } from '../src/shared/types/brand';
import { toClientConfig, type ClientConfig } from '../src/shared/types/config';
import type { PreprocessedVideo, QueuedVideo } from '../src/shared/types/video';
import { createVideoPlayer, type VideoPlayer } from '../src/client/core/player/videoPlayer';
import { createVideoStage } from '../src/client/core/player/videoStage';
import { FakeVideoElement, settle, type FakeVideoOptions } from './support/fakeMedia';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const clientConfig = (overrides: Record<string, unknown> = {}): ClientConfig =>
  toClientConfig(normalizeConfig({ directories: ['/videos'], ...overrides }).config);

const preprocessed = (name: string, duration = 60): PreprocessedVideo => ({
  originalPath: asSourceVideoPath(`/videos/${name}.mp4`),
  filename: `${name}.mp4`,
  directory: '/videos',
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory: null,
  processedPath: asProcessedVideoPath(`/temp/processed_${name}.mp4`),
  processedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  metadata: {
    duration,
    video: { width: 1920, height: 1080, framesPerSecond: 30, codec: 'h264' },
    audio: null,
    container: { fileSize: null, bitrate: null, formatName: null },
  },
  crossfadeTiming: { duration: 0.5, startTime: duration - 1 },
});

const queued = (name: string, duration = 60): QueuedVideo => {
  const video = preprocessed(name, duration);
  return {
    video: { ...video, location: { kind: 'file', path: video.processedPath } },
    origin: 'queue',
  };
};

interface Harness {
  readonly player: VideoPlayer;
  readonly elements: readonly [FakeVideoElement, FakeVideoElement];
  readonly started: string[];
  readonly ended: string[];
  readonly errors: string[];
  readonly returned: string[];
  readonly upcoming: QueuedVideo[];
}

const harness = (
  config: ClientConfig = clientConfig(),
  options: FakeVideoOptions = {},
): Harness => {
  const elements: readonly [FakeVideoElement, FakeVideoElement] = [
    new FakeVideoElement(options),
    new FakeVideoElement(options),
  ];
  const started: string[] = [];
  const ended: string[] = [];
  const errors: string[] = [];
  const returned: string[] = [];
  const upcoming: QueuedVideo[] = [];

  const player = createVideoPlayer({
    stage: createVideoStage(elements as unknown as readonly [HTMLVideoElement, HTMLVideoElement]),
    config,
    logger: silentLogger,
    origin: null,
    events: {
      onStarted: (video) => started.push(video.video.filename),
      onEnded: (video) => ended.push(video.video.filename),
      onError: (error) => errors.push(error.message),
      requestNext: () => Promise.resolve(upcoming.shift() ?? null),
      returnNext: (video) => {
        returned.push(video.video.filename);
        upcoming.unshift(video);
      },
    },
  });

  return { player, elements, started, ended, errors, returned, upcoming };
};

const play = async (h: Harness, video: QueuedVideo, isFirst = false) => {
  const result = h.player.play(video, { isFirst });
  await settle();
  return result;
};

const activeOf = (h: Harness): FakeVideoElement =>
  h.elements.find((element) => element.classes.has('visible')) ?? h.elements[0];

describe('pause and resume', () => {
  it('pauses the element and stops it ending on its own', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const active = activeOf(h);
    assert.equal(active.paused, false);

    h.player.setPaused(true);
    assert.equal(active.paused, true);
    assert.equal(h.player.snapshot().paused, true);

    // However long the pause lasts, the watchdog must not decide the video is
    // over: the position never moves while paused, and a timeupdate that does
    // arrive is not a reason to advance the queue.
    active.seekTo(59.99);
    active.seekTo(59.99);
    await settle();
    assert.deepEqual(h.ended, []);
    assert.equal(h.player.snapshot().paused, true);
  });

  it('resumes from where it stopped, however long it was paused', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const active = activeOf(h);

    active.currentTime = 12.5;
    h.player.setPaused(true);
    await settle();

    // Simulating hours of wall clock: nothing about the element changed, which
    // is exactly the state a resume has to cope with.
    h.player.setPaused(false);
    await settle();

    assert.equal(active.paused, false);
    assert.equal(h.player.snapshot().paused, false);
    assert.equal(active.currentTime, 12.5, 'the position must survive the pause');
    assert.deepEqual(h.ended, []);
  });

  it('survives many pause and resume cycles without stacking listeners', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const active = activeOf(h);
    const baseline = active.liveListeners();

    for (let i = 0; i < 50; i += 1) {
      h.player.setPaused(true);
      h.player.setPaused(false);
      await settle(1);
    }

    assert.equal(active.liveListeners(), baseline, 'listeners must not accumulate');
    assert.equal(active.paused, false);
    assert.equal(h.player.snapshot().paused, false);
  });

  it('still advances normally once resumed', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const active = activeOf(h);

    h.player.setPaused(true);
    await settle();
    h.player.setPaused(false);
    await settle();

    active.endNaturally();
    await settle();
    assert.deepEqual(h.ended, ['a.mp4']);
  });

  it('reports the element as the truth for play/pause toggling', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const active = activeOf(h);

    h.player.togglePlayPause();
    assert.equal(active.paused, true);
    h.player.togglePlayPause();
    await settle();
    assert.equal(active.paused, false);
  });

  it('keeps the transport paused across a video change', async () => {
    // A pause lands on whichever element is on screen. If the next video is
    // promoted without re-applying it, the viewer sees playback resume itself.
    const h = harness();
    await play(h, queued('a'), true);
    h.player.setPaused(true);
    await settle();

    await play(h, queued('b'));
    await settle();

    assert.equal(h.player.snapshot().paused, true);
    assert.equal(activeOf(h).paused, true, 'the promoted element must still be paused');
  });
});

describe('rapid skipping', () => {
  it('refuses overlapping transitions rather than interleaving them', async () => {
    const h = harness();
    await play(h, queued('a'), true);

    // Five skips fired without waiting, as a held-down button produces.
    const attempts = [
      h.player.play(queued('b')),
      h.player.play(queued('c')),
      h.player.play(queued('d')),
      h.player.play(queued('e')),
      h.player.play(queued('f')),
    ];
    const outcomes = await Promise.all(attempts);
    await settle();

    const accepted = outcomes.filter((outcome) => outcome.ok).length;
    const refused = outcomes.filter(
      (outcome) => !outcome.ok && outcome.error.name === 'TransitionBusyError',
    ).length;

    assert.equal(accepted, 1, 'exactly one transition may proceed');
    assert.equal(refused, outcomes.length - accepted, 'the rest must be refused, not failed');
    assert.equal(h.started.length, 2, 'only the accepted video starts');
  });

  it('leaves the stage consistent after a long burst of skips', async () => {
    const h = harness();
    await play(h, queued('a'), true);

    for (let i = 0; i < 40; i += 1) {
      void h.player.play(queued(`v${i}`));
      // Every other skip is given room to land, so the burst is a mix of
      // accepted and refused rather than uniformly one or the other.
      if (i % 2 === 0) await settle(2);
    }
    await settle(10);

    const visible = h.elements.filter((element) => element.classes.has('visible'));
    assert.equal(visible.length, 1, 'exactly one element may be on screen');

    const current = h.player.snapshot().current;
    assert.notEqual(current, null);
    // The element on screen is the one holding the current video's transcode.
    assert.ok(
      activeOf(h).src.endsWith(`processed_${current?.video.filename.replace('.mp4', '') ?? ''}.mp4`),
      `on screen: ${activeOf(h).src}, current: ${current?.video.filename ?? 'none'}`,
    );

    // Both elements together must never hold more than the one live listener
    // set: a burst that leaked would show a multiple of it.
    const attached = h.elements.reduce((total, element) => total + element.liveListeners(), 0);
    assert.equal(attached, 3, 'ended, error and timeupdate, on the active element only');
  });

  it('hands a video back to the queue when a scheduled fade cannot use it', async () => {
    // The queue has already given the video up by the time the fade fails, so
    // losing it there means the viewer never sees that file again this session.
    const broken = new Set(['file:///temp/processed_bad.mp4']);
    const h = harness(clientConfig({ crossfade: { enabled: true, duration: 50 } }), { broken });
    await play(h, queued('a', 3), true);

    h.upcoming.push(queued('bad', 3));
    // Seeking past the fade's start time re-arms it, and a fade already due
    // fires immediately rather than waiting for a timer.
    h.player.seekBy(2.9);
    await settle(30);

    assert.deepEqual(h.returned, ['bad.mp4'], 'the dequeued video must come back');
    assert.equal(h.upcoming.length, 1);
  });

  it('delivers a failure that arrived while a scheduled fade held the guard', async () => {
    // The video that failed will never fire `ended`, so this error is the only
    // thing left that can move the queue on. It used to be delivered straight
    // through: the shell answered it with one recovery timer, the fade still
    // holding the guard refused that timer's `play`, and when the fade then
    // failed as well both sides had deferred to the other and the screen kept a
    // dead frame until a key was pressed.
    const broken = new Set(['file:///temp/processed_bad.mp4']);
    const h = harness(clientConfig({ crossfade: { enabled: true, duration: 50 } }), { broken });
    await play(h, queued('a', 3), true);
    const active = activeOf(h);

    h.upcoming.push(queued('bad', 3));
    // Seeking past the fade's start time arms it, and a fade already due fires
    // synchronously - so the guard is held by the time the next line runs.
    h.player.seekBy(2.9);
    active.fail();
    assert.deepEqual(h.errors, [], 'the failure must wait for the guard to be free');

    await settle(30);
    assert.equal(h.errors.length, 1, 'and be delivered once the fade has given up');
    assert.match(h.errors[0] ?? '', /decoding/);
  });

  it('drops a latched failure when the handover it collided with succeeded', async () => {
    // A fade that lands has already replaced the video that failed, so
    // delivering the failure as well would advance the queue a second time.
    const h = harness(clientConfig({ crossfade: { enabled: true, duration: 20 } }));
    // The scheduled fade runs for the *outgoing* video's declared duration, so
    // it is shortened here rather than in the config the fade does not read.
    const outgoing = queued('a', 3);
    await play(
      h,
      { ...outgoing, video: { ...outgoing.video, crossfadeTiming: { duration: 0.02, startTime: 2 } } },
      true,
    );
    const active = activeOf(h);

    h.upcoming.push(queued('b', 3));
    h.player.seekBy(2.9);
    active.fail();

    await settle(60);
    assert.deepEqual(h.started, ['a.mp4', 'b.mp4']);
    assert.deepEqual(h.errors, [], 'a replaced failure belongs to nobody');
  });

  it('does not double-report the end of a video that was skipped away from', async () => {
    const h = harness();
    await play(h, queued('a'), true);
    const first = activeOf(h);

    await play(h, queued('b'));
    await settle();

    // The retired element finishes off screen; that end belongs to nobody.
    first.endNaturally();
    await settle();

    assert.deepEqual(h.ended, [], 'an off-screen end must not advance the queue');
  });
});

describe('history under rapid stepping', () => {
  const limits = { recentLimit: 5, persistedLimit: 20 };

  it('returns videos in reverse order and never repeats one', () => {
    let state = EMPTY_HISTORY;
    for (const name of ['a', 'b', 'c']) state = recordPlayed(state, preprocessed(name), limits);

    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const step = takePrevious(state);
      state = step.state;
      if (step.video !== null) seen.push(step.video.filename);
    }
    assert.deepEqual(seen, ['c.mp4', 'b.mp4', 'a.mp4']);
    assert.deepEqual(takePrevious(state).video, null);
  });

  it('stays consistent when stepping back and forward repeatedly', () => {
    let state = EMPTY_HISTORY;
    for (const name of ['a', 'b', 'c', 'd']) state = recordPlayed(state, preprocessed(name), limits);

    for (let i = 0; i < 50; i += 1) {
      const step = takePrevious(state);
      state = step.state;
      if (step.video !== null) state = recordPlayed(state, step.video, limits);

      const paths = state.recent.map((entry) => entry.originalPath);
      assert.equal(new Set(paths).size, paths.length, 'history must never hold a duplicate');
      assert.ok(state.recent.length <= limits.recentLimit, 'history must stay bounded');
      assert.ok(state.persisted.length <= limits.persistedLimit);
    }
  });

  it('replaying a video moves it to the front rather than duplicating it', () => {
    let state = EMPTY_HISTORY;
    for (const name of ['a', 'b', 'c']) state = recordPlayed(state, preprocessed(name), limits);
    state = recordPlayed(state, preprocessed('a'), limits);

    assert.deepEqual(
      state.recent.map((entry) => entry.filename),
      ['a.mp4', 'c.mp4', 'b.mp4'],
    );
  });

  it('drops the oldest entry once the limit is reached', () => {
    let state = EMPTY_HISTORY;
    for (let i = 0; i < 20; i += 1) state = recordPlayed(state, preprocessed(`v${i}`), limits);

    assert.equal(state.recent.length, limits.recentLimit);
    assert.equal(state.recent[0]?.filename, 'v19.mp4');
  });
});
