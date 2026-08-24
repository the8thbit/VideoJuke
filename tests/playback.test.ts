import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import {
  EMPTY_HISTORY,
  historyGauges,
  recordPlayed,
  takePrevious,
  trimHistory,
} from '../src/shared/queue/history';
import { selectVideo, type SeasonalCandidate } from '../src/shared/queue/selection';
import {
  asIsoTimestamp,
  asProcessedVideoPath,
  asSourceVideoPath,
} from '../src/shared/types/brand';
import { EMPTY_TIME_CONDITION, type LocalTimeFacts } from '../src/shared/types/time';
import type { IndexedVideo, PreprocessedVideo, VideoMetadata } from '../src/shared/types/video';
import {
  computeCrossfadeDurationSeconds,
  computeCrossfadeTiming,
  toCrossfadeSettings,
  withCrossfadeTiming,
} from '../src/shared/video/crossfadeTiming';
import {
  fileLocation,
  httpLocation,
  resolveVideoUrl,
} from '../src/shared/video/videoLocation';

const CONFIG = normalizeConfig({ directories: ['/videos'] }).config;

const indexed = (name: string, seasonalDirectory: string | null = null): IndexedVideo => ({
  originalPath: asSourceVideoPath(`/videos/${name}.mp4`),
  filename: `${name}.mp4`,
  directory: '/videos',
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory,
});

const metadata = (duration: number | null): VideoMetadata => ({
  duration,
  video: { width: 1920, height: 1080, framesPerSecond: 30, codec: 'h264' },
  audio: null,
  container: { fileSize: null, bitrate: null, formatName: 'mp4' },
});

const preprocessed = (name: string, duration: number | null = 120): PreprocessedVideo => ({
  ...indexed(name),
  processedPath: asProcessedVideoPath(`/temp/processed_${name}.mp4`),
  processedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  metadata: metadata(duration),
  crossfadeTiming: null,
});

const FACTS: LocalTimeFacts = {
  epochMs: Date.UTC(2026, 5, 18, 14, 35),
  dayOfWeek: 4,
  hour: 14,
  minute: 35,
  dayOfMonth: 18,
  month: 6,
  year: 2026,
};

/** A random source that replays a fixed script, so selection is deterministic. */
const scriptedRandom = (values: readonly number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

describe('crossfade timing', () => {
  const settings = toCrossfadeSettings(CONFIG);

  it('reads its parameters from the config', () => {
    assert.deepEqual(settings, { durationMs: 500, minDurationMs: 200, bufferSeconds: 0.5 });
  });

  it('uses the configured duration for a comfortably long video', () => {
    assert.equal(computeCrossfadeDurationSeconds(120, settings), 0.5);
  });

  it('halves the crossfade when the video is shorter than two crossfades', () => {
    assert.equal(computeCrossfadeDurationSeconds(0.8, settings), 0.4);
  });

  it('never goes below the configured minimum', () => {
    assert.equal(computeCrossfadeDurationSeconds(0.1, settings), 0.2);
  });

  it('starts the fade a buffer ahead of the end', () => {
    assert.deepEqual(computeCrossfadeTiming(120, settings), { duration: 0.5, startTime: 119 });
  });

  it('has no timing for a video of unknown length', () => {
    assert.equal(computeCrossfadeTiming(null, settings), null);
    assert.equal(computeCrossfadeTiming(0, settings), null);
  });

  it('leaves an already-timed video untouched', () => {
    const timed = { ...preprocessed('a'), crossfadeTiming: { duration: 9, startTime: 1 } };
    assert.equal(withCrossfadeTiming(timed, settings).crossfadeTiming?.duration, 9);
  });

  it('fills in timing from the probed duration', () => {
    const result = withCrossfadeTiming(preprocessed('a', 60), settings);
    assert.deepEqual(result.crossfadeTiming, { duration: 0.5, startTime: 59 });
  });
});

describe('video location', () => {
  it('addresses local files with a file URL', () => {
    assert.equal(
      resolveVideoUrl(fileLocation(asProcessedVideoPath('/temp/a.mp4')), null),
      'file:///temp/a.mp4',
    );
  });

  it('leaves an absolute http URL alone', () => {
    assert.equal(
      resolveVideoUrl(httpLocation('http://tv.local:3123/videos?filename=a.mp4'), 'http://x'),
      'http://tv.local:3123/videos?filename=a.mp4',
    );
  });

  it('joins a relative URL onto the origin with exactly one slash', () => {
    assert.equal(
      resolveVideoUrl(httpLocation('/videos?filename=a.mp4'), 'http://host:3123'),
      'http://host:3123/videos?filename=a.mp4',
    );
    assert.equal(
      resolveVideoUrl(httpLocation('videos?filename=a.mp4'), 'http://host:3123/'),
      'http://host:3123/videos?filename=a.mp4',
    );
  });

  it('keeps a relative URL relative when there is no origin', () => {
    assert.equal(resolveVideoUrl(httpLocation('/videos?x=1'), null), '/videos?x=1');
  });

  it('escapes a Windows path into a file URL the browser can parse', () => {
    // The temp directory sits under the working directory, so punctuation in it
    // is ordinary. Concatenating the path used to truncate the URL at the `#`,
    // and every video in that install failed to load.
    const url = resolveVideoUrl(
      fileLocation(asProcessedVideoPath('C:\\Users\\Ann Smith\\My #1 Videos\\processed_a.mp4')),
      null,
    );
    assert.equal(url, 'file:///C:/Users/Ann%20Smith/My%20%231%20Videos/processed_a.mp4');

    const parsed = new URL(url);
    assert.equal(parsed.hash, '');
    assert.equal(decodeURIComponent(parsed.pathname), '/C:/Users/Ann Smith/My #1 Videos/processed_a.mp4');
  });

  it('escapes the other characters a URL would otherwise eat', () => {
    const percent = resolveVideoUrl(
      fileLocation(asProcessedVideoPath('/home/ann/100% real ?.mp4')),
      null,
    );
    assert.equal(percent, 'file:///home/ann/100%25%20real%20%3F.mp4');
    assert.equal(new URL(percent).search, '');
  });
});

describe('history', () => {
  const limits = { recentLimit: 3, persistedLimit: 5 };

  it('records a played video at the head of both lists', () => {
    const state = recordPlayed(EMPTY_HISTORY, preprocessed('a'), limits);
    assert.deepEqual(state.recent.map((video) => video.filename), ['a.mp4']);
    assert.deepEqual(state.persisted.map((video) => video.filename), ['a.mp4']);
  });

  it('moves a repeat play back to the head instead of duplicating it', () => {
    const state = ['a', 'b', 'a']
      .map((name) => preprocessed(name))
      .reduce((history, video) => recordPlayed(history, video, limits), EMPTY_HISTORY);

    assert.deepEqual(state.recent.map((video) => video.filename), ['a.mp4', 'b.mp4']);
  });

  it('bounds each list independently', () => {
    const state = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((name) => preprocessed(name))
      .reduce((history, video) => recordPlayed(history, video, limits), EMPTY_HISTORY);

    assert.equal(state.recent.length, 3);
    assert.equal(state.persisted.length, 5);
    assert.equal(state.recent[0]?.filename, 'f.mp4');
  });

  it('takes the most recent video and forgets it everywhere', () => {
    const state = ['a', 'b'].reduce(
      (history, name) => recordPlayed(history, preprocessed(name), limits),
      EMPTY_HISTORY,
    );

    const { video, state: next } = takePrevious(state);
    assert.equal(video?.filename, 'b.mp4');
    assert.deepEqual(next.recent.map((entry) => entry.filename), ['a.mp4']);
    // Taken from recent means taken from persisted too, or pressing "previous"
    // twice would hand back the same video.
    assert.deepEqual(next.persisted.map((entry) => entry.filename), ['a.mp4']);
  });

  it('falls back to the long-term list once the recent one runs out', () => {
    const state = { recent: [], persisted: [preprocessed('old')] };
    const { video, state: next } = takePrevious(state);
    assert.equal(video?.filename, 'old.mp4');
    assert.deepEqual(next.persisted, []);
  });

  it('reports nothing when both lists are empty', () => {
    const { video, state } = takePrevious(EMPTY_HISTORY);
    assert.equal(video, null);
    assert.equal(state, EMPTY_HISTORY);
  });

  it('trims to new limits without reordering', () => {
    const state = { recent: [preprocessed('a'), preprocessed('b')], persisted: [] };
    assert.deepEqual(
      trimHistory(state, { recentLimit: 1, persistedLimit: 1 }).recent.map((v) => v.filename),
      ['a.mp4'],
    );
  });

  it('reports gauges for the debug overlay', () => {
    const state = recordPlayed(EMPTY_HISTORY, preprocessed('a'), limits);
    assert.deepEqual(historyGauges(state, limits), {
      playback: { current: 1, target: 3 },
      persisted: { current: 1, target: 5 },
    });
  });
});

describe('selectVideo', () => {
  const seasonal = (
    directory: string,
    likelihood: number,
    videos: readonly IndexedVideo[],
  ): SeasonalCandidate => ({
    directory,
    likelihood,
    conditions: EMPTY_TIME_CONDITION,
    videos,
  });

  it('picks from the regular pool when no seasonal directory fires', () => {
    const outcome = selectVideo({
      regular: [indexed('a')],
      seasonal: [],
      excludedPaths: new Set(),
      facts: FACTS,
      random: scriptedRandom([0]),
    });

    assert.equal(outcome.kind, 'regular');
    assert.equal(outcome.kind === 'regular' ? outcome.video.filename : '', 'a.mp4');
  });

  it('prefers a seasonal directory that wins its likelihood roll', () => {
    const outcome = selectVideo({
      regular: [indexed('regular')],
      seasonal: [seasonal('/holiday', 0.5, [indexed('holiday', '/holiday')])],
      excludedPaths: new Set(),
      facts: FACTS,
      random: scriptedRandom([0.1, 0]),
    });

    assert.equal(outcome.kind, 'seasonal');
    assert.equal(outcome.kind === 'seasonal' ? outcome.directory : '', '/holiday');
  });

  it('falls through when the likelihood roll loses', () => {
    const outcome = selectVideo({
      regular: [indexed('regular')],
      seasonal: [seasonal('/holiday', 0.5, [indexed('holiday', '/holiday')])],
      excludedPaths: new Set(),
      facts: FACTS,
      random: scriptedRandom([0.9, 0]),
    });

    assert.equal(outcome.kind, 'regular');
  });

  it('skips a seasonal directory whose videos are all excluded', () => {
    const holiday = indexed('holiday', '/holiday');
    const outcome = selectVideo({
      regular: [indexed('regular')],
      seasonal: [seasonal('/holiday', 1, [holiday])],
      excludedPaths: new Set([holiday.originalPath]),
      facts: FACTS,
      random: scriptedRandom([0, 0]),
    });

    assert.equal(outcome.kind, 'regular');
  });

  it('ignores a seasonal directory whose conditions do not hold', () => {
    const outcome = selectVideo({
      regular: [indexed('regular')],
      seasonal: [
        {
          ...seasonal('/holiday', 1, [indexed('holiday', '/holiday')]),
          conditions: { ...EMPTY_TIME_CONDITION, months: [12] },
        },
      ],
      excludedPaths: new Set(),
      facts: FACTS,
      random: scriptedRandom([0, 0]),
    });

    assert.equal(outcome.kind, 'regular');
  });

  it('distinguishes an empty library from an exhausted one', () => {
    const empty = selectVideo({
      regular: [],
      seasonal: [],
      excludedPaths: new Set(),
      facts: FACTS,
      random: scriptedRandom([0]),
    });
    assert.deepEqual(empty, { kind: 'none', reason: 'no-videos' });

    const only = indexed('a');
    const exhausted = selectVideo({
      regular: [only],
      seasonal: [],
      excludedPaths: new Set([only.originalPath]),
      facts: FACTS,
      random: scriptedRandom([0]),
    });
    assert.deepEqual(exhausted, { kind: 'none', reason: 'all-excluded' });
  });
});
