import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLOCK_SAMPLE_LIMIT,
  DEFAULT_CONVERGENCE,
  addClockSample,
  bestOffsetMs,
  decideCorrection,
  leaderPositionAt,
  sampleFrom,
  type ClockSample,
} from '../src/client/core/sync/convergence';
import { toScreenRole } from '../src/client/core/app/playerApp';
import { decodeLeaderPublication } from '../src/server/domain/leaderPublication';
import { UNCHECKED_VIDEO_PATHS } from '../src/server/domain/videoPaths';
import { asIsoTimestamp, asProcessedVideoPath, asSourceVideoPath } from '../src/shared/types/brand';
import type { LeaderState } from '../src/shared/types/protocol';
import type { PreprocessedVideo } from '../src/shared/types/video';

const video: PreprocessedVideo = {
  originalPath: asSourceVideoPath('/videos/a.mp4'),
  filename: 'a.mp4',
  directory: '/videos',
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory: null,
  processedPath: asProcessedVideoPath('/temp/processed_a.mp4'),
  processedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  metadata: {
    duration: 300,
    video: { width: 1920, height: 1080, framesPerSecond: 30, codec: 'h264' },
    audio: null,
    container: { fileSize: null, bitrate: null, formatName: null },
  },
  crossfadeTiming: null,
};

const leader = (overrides: Partial<LeaderState> = {}): LeaderState => ({
  sequence: 1,
  video,
  positionSeconds: 100,
  paused: false,
  rate: 1,
  anchorMs: 1_000_000,
  ...overrides,
});

describe('screen roles', () => {
  it('reads the three names, however they are cased or padded', () => {
    assert.equal(toScreenRole('leader'), 'leader');
    assert.equal(toScreenRole(' Follower '), 'follower');
    assert.equal(toScreenRole('INDEPENDENT'), 'independent');
  });

  it('treats anything else as a screen that plays on its own', () => {
    // A typo must not silently make a screen follow something.
    for (const value of ['', '   ', 'lead', 'primary', null, undefined]) {
      assert.equal(toScreenRole(value), 'independent', String(value));
    }
  });
});

describe('leader position', () => {
  it('advances with the server clock', () => {
    const state = leader();
    assert.equal(leaderPositionAt(state, 1_000_000), 100);
    assert.equal(leaderPositionAt(state, 1_002_000), 102);
  });

  it('scales by the rate the leader reported, not an assumed one', () => {
    assert.equal(leaderPositionAt(leader({ rate: 2 }), 1_002_000), 104);
    assert.equal(leaderPositionAt(leader({ rate: 0.5 }), 1_002_000), 101);
  });

  it('stays put while the leader is paused', () => {
    const paused = leader({ paused: true });
    assert.equal(leaderPositionAt(paused, 1_000_000), 100);
    assert.equal(leaderPositionAt(paused, 9_999_999), 100);
  });

  it('never runs backwards if a clock estimate lands before the anchor', () => {
    assert.equal(leaderPositionAt(leader(), 999_000), 100);
  });
});

describe('clock offset', () => {
  it('measures the offset from the midpoint of a round trip', () => {
    // Sent at 1000, server said 5000, back at 1200: the midpoint is 1100, so
    // the server is 3900ms ahead of this device.
    assert.deepEqual(sampleFrom(1000, 5000, 1200), { offsetMs: 3900, roundTripMs: 200 });
  });

  it('prefers the fastest round trip rather than averaging', () => {
    // The asymmetry between the two legs is the entire error, and a slow trip
    // has more room to be asymmetric. An average would be dragged by the worst.
    const samples: readonly ClockSample[] = [
      { offsetMs: 500, roundTripMs: 900 },
      { offsetMs: 100, roundTripMs: 12 },
      { offsetMs: 400, roundTripMs: 600 },
    ];
    assert.equal(bestOffsetMs(samples), 100);
  });

  it('answers zero before it has measured anything', () => {
    assert.equal(bestOffsetMs([]), 0);
  });

  it('keeps only the most recent handful', () => {
    let samples: readonly ClockSample[] = [];
    for (let i = 0; i < 40; i += 1) {
      samples = addClockSample(samples, { offsetMs: i, roundTripMs: 100 });
    }
    assert.equal(samples.length, CLOCK_SAMPLE_LIMIT);
    assert.equal(samples[samples.length - 1]?.offsetMs, 39, 'the newest survives');
  });
});

describe('convergence', () => {
  it('does nothing when it is already close enough', () => {
    // Under two frames at 50fps: correcting here would be visible fidgeting to
    // fix something nobody can see.
    assert.deepEqual(decideCorrection(0), { kind: 'hold' });
    assert.deepEqual(decideCorrection(0.03), { kind: 'hold' });
    assert.deepEqual(decideCorrection(-0.03), { kind: 'hold' });
  });

  it('speeds up when behind and slows down when ahead', () => {
    const behind = decideCorrection(0.5);
    const ahead = decideCorrection(-0.5);
    assert.equal(behind.kind, 'trim');
    assert.equal(ahead.kind, 'trim');
    assert.ok(behind.kind === 'trim' && behind.trim > 1, 'behind must play faster');
    assert.ok(ahead.kind === 'trim' && ahead.trim < 1, 'ahead must play slower');
  });

  it('never bends the rate further than the configured limit', () => {
    for (const error of [0.9, -0.9, 0.5, -0.5, 0.2]) {
      const correction = decideCorrection(error);
      if (correction.kind !== 'trim') continue;
      assert.ok(
        Math.abs(correction.trim - 1) <= DEFAULT_CONVERGENCE.maxTrim + 1e-9,
        `error ${error} produced ${correction.trim}`,
      );
    }
  });

  it('jumps rather than nudging once the gap is large', () => {
    // A second of error would take twenty to remove at the maximum trim.
    assert.deepEqual(decideCorrection(1), { kind: 'seek', seconds: 1 });
    assert.deepEqual(decideCorrection(-30), { kind: 'seek', seconds: -30 });
  });

  it('converges instead of oscillating', () => {
    // The plant is a pure integrator, so a proportional law is enough; this is
    // the assertion that would fail if an integral term were ever added.
    let error = 0.9;
    const tickSeconds = 0.25;
    let ticks = 0;

    while (Math.abs(error) > DEFAULT_CONVERGENCE.deadbandSeconds && ticks < 2000) {
      const correction = decideCorrection(error);
      if (correction.kind === 'seek') break;
      const trim = correction.kind === 'trim' ? correction.trim : 1;
      // The follower plays at `trim` while the leader plays at 1, so the gap
      // closes by the difference over the tick.
      error -= (trim - 1) * tickSeconds;
      ticks += 1;
    }

    assert.ok(ticks < 2000, 'it must actually converge');
    assert.ok(Math.abs(error) <= DEFAULT_CONVERGENCE.deadbandSeconds, `settled at ${error}`);
  });

  it('does not overshoot into a correction the other way', () => {
    let error = 0.6;
    const tickSeconds = 0.25;
    for (let i = 0; i < 400; i += 1) {
      const correction = decideCorrection(error);
      if (correction.kind !== 'trim') break;
      const next = error - (correction.trim - 1) * tickSeconds;
      // Approaching zero from above must never cross to below it.
      assert.ok(next >= -DEFAULT_CONVERGENCE.deadbandSeconds, `overshot to ${next}`);
      error = next;
    }
  });

  it('shrugs off a position it cannot make sense of', () => {
    assert.deepEqual(decideCorrection(Number.NaN), { kind: 'hold' });
    assert.deepEqual(decideCorrection(Number.POSITIVE_INFINITY), { kind: 'hold' });
  });
});

describe('decoding what a leader publishes', () => {
  const publication = (overrides: Record<string, unknown> = {}) => ({
    video,
    positionSeconds: 12.5,
    paused: false,
    rate: 1,
    ...overrides,
  });

  it('reads the record out of the wrapper both transports send', () => {
    // The Electron handler used to decode the wrapper itself, find no
    // `originalPath` on it, and answer null - so an Electron leader published
    // nothing at all and every follower saw an empty leader state.
    const decoded = decodeLeaderPublication(publication(), UNCHECKED_VIDEO_PATHS);
    assert.equal(decoded?.video.filename, 'a.mp4');
    assert.equal(decoded?.positionSeconds, 12.5);
    assert.equal(decoded?.rate, 1);
    assert.equal(decoded?.paused, false);
  });

  it('still reads a record sent bare, as the browser client used to send it', () => {
    const flattened = { ...video, positionSeconds: 3, paused: true, rate: 2 };
    const decoded = decodeLeaderPublication(flattened, UNCHECKED_VIDEO_PATHS);
    assert.equal(decoded?.video.filename, 'a.mp4');
    assert.equal(decoded?.paused, true);
    assert.equal(decoded?.rate, 2);
  });

  it('brings every number into a range a player can act on', () => {
    // A follower writes these onto its own element, so the clamping has to
    // happen on both transports rather than only on the one that had it.
    for (const rate of [0, -1, 1000, Number.NaN, 'fast', null]) {
      assert.equal(decodeLeaderPublication(publication({ rate }), UNCHECKED_VIDEO_PATHS)?.rate, 1);
    }
    assert.equal(
      decodeLeaderPublication(publication({ positionSeconds: -50 }), UNCHECKED_VIDEO_PATHS)
        ?.positionSeconds,
      0,
    );
    assert.equal(
      decodeLeaderPublication(publication({ positionSeconds: 'nonsense' }), UNCHECKED_VIDEO_PATHS)
        ?.positionSeconds,
      0,
    );
  });

  it('treats anything but a literal true as playing', () => {
    assert.equal(
      decodeLeaderPublication(publication({ paused: 'yes' }), UNCHECKED_VIDEO_PATHS)?.paused,
      false,
    );
  });

  it('refuses a payload that carries no usable record', () => {
    assert.equal(decodeLeaderPublication(publication({ video: null }), UNCHECKED_VIDEO_PATHS), null);
    assert.equal(decodeLeaderPublication({}, UNCHECKED_VIDEO_PATHS), null);
    assert.equal(decodeLeaderPublication(null, UNCHECKED_VIDEO_PATHS), null);
  });
});
