import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger, formatLogEntry } from '../src/shared/logging/logger';
import { createExclusiveTask, createStore } from '../src/shared/state/store';
import { asIsoTimestamp } from '../src/shared/types/brand';
import type { LogEntry } from '../src/shared/types/logging';
import { allOk, attempt, err, mapResult, ok, okValues } from '../src/shared/types/result';
import type { VideoMetadata } from '../src/shared/types/video';
import { pickRandom, prependBounded, takeRandom, uniqueBy } from '../src/shared/util/arrays';
import { createIssueCollector, readEnum, readNumber, readSection } from '../src/shared/util/decode';
import {
  formatDurationSeconds,
  formatElapsedMs,
  formatFileSize,
  formatPercent,
  formatVideoSummary,
} from '../src/shared/util/format';
import { easeInOut, parseRationalNumber, ratio } from '../src/shared/util/numbers';
import { deepMerge, readPath, stableStringify } from '../src/shared/util/objects';

describe('deepMerge', () => {
  it('merges nested objects field by field', () => {
    assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  });

  it('replaces arrays wholesale rather than concatenating them', () => {
    // A user listing three directories means exactly those three.
    assert.deepEqual(deepMerge({ dirs: ['a', 'b'] }, { dirs: ['c'] }), { dirs: ['c'] });
  });

  it('ignores undefined overrides but respects an explicit null', () => {
    assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
    assert.deepEqual(deepMerge({ a: 1 }, { a: null }), { a: null });
  });
});

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  });

  it('keeps array order significant', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });

  it('omits undefined members', () => {
    assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe('readPath', () => {
  it('returns undefined as soon as the trail goes cold', () => {
    assert.equal(readPath({ a: { b: 1 } }, ['a', 'b']), 1);
    assert.equal(readPath({ a: null }, ['a', 'b']), undefined);
    assert.equal(readPath(undefined, ['a']), undefined);
  });
});

describe('Result', () => {
  it('maps only the successful case', () => {
    assert.deepEqual(mapResult(ok(2), (value) => value * 2), ok(4));
    const failure = err(new Error('boom'));
    assert.equal(mapResult(failure, () => 1), failure);
  });

  it('collects successes and short-circuits failures', () => {
    assert.deepEqual(okValues([ok(1), err('x'), ok(2)]), [1, 2]);
    assert.deepEqual(allOk([ok(1), ok(2)]), ok([1, 2]));
    assert.deepEqual(allOk([ok(1), err('x')]), err('x'));
  });

  it('captures a throw as an error value', () => {
    const result = attempt(() => {
      throw new Error('nope');
    });
    assert.equal(result.ok, false);
  });
});

describe('numbers', () => {
  it('divides safely by zero', () => {
    assert.equal(ratio(1, 0), 0);
    assert.equal(ratio(1, 4), 0.25);
  });

  it('eases symmetrically about the midpoint', () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(0.5), 0.5);
    assert.equal(easeInOut(1), 1);
  });

  it('evaluates ffprobe frame-rate fractions without eval', () => {
    assert.equal(parseRationalNumber('30/1'), 30);
    assert.equal(Math.round((parseRationalNumber('30000/1001') ?? 0) * 100) / 100, 29.97);
    assert.equal(parseRationalNumber('0/0'), null);
    assert.equal(parseRationalNumber('process.exit(1)'), null);
  });
});

describe('arrays', () => {
  const constantRandom = (value: number) => () => value;

  it('picks nothing from an empty list', () => {
    assert.equal(pickRandom([], constantRandom(0)), null);
  });

  it('never runs off the end when the source returns almost one', () => {
    assert.equal(pickRandom([1, 2, 3], constantRandom(0.999999)), 3);
  });

  it('removes the taken element from the remainder', () => {
    const { removed, rest } = takeRandom(['a', 'b', 'c'], constantRandom(0));
    assert.equal(removed, 'a');
    assert.deepEqual(rest, ['b', 'c']);
  });

  it('bounds a list as it grows at the head', () => {
    assert.deepEqual(prependBounded(['b', 'c'], 'a', 2), ['a', 'b']);
  });

  it('de-duplicates while preserving order', () => {
    assert.deepEqual(uniqueBy(['a', 'b', 'a'], (value) => value), ['a', 'b']);
  });
});

describe('decode readers', () => {
  it('reports the dotted path of an offending field', () => {
    const collector = createIssueCollector();
    const section = collector.context.at('video');
    readNumber(section.at('queueSize'), 'ten', 5);

    assert.equal(collector.issues()[0]?.path, 'video.queueSize');
  });

  it('clamps rather than rejecting an out-of-range number', () => {
    const collector = createIssueCollector();
    assert.equal(readNumber(collector.context, 99, 5, { min: 1, max: 8 }), 8);
    assert.equal(collector.issues().length, 1);
  });

  it('falls back for an unknown enum member', () => {
    const collector = createIssueCollector();
    assert.equal(readEnum(collector.context, 'turbo', ['slow', 'fast'] as const, 'slow'), 'slow');
    assert.equal(collector.issues().length, 1);
  });

  it('treats a non-object section as absent', () => {
    const collector = createIssueCollector();
    assert.deepEqual(readSection(collector.context, 'nope'), {});
    assert.equal(collector.issues().length, 1);
  });
});

describe('formatting', () => {
  it('formats durations with hours only when there are hours', () => {
    assert.equal(formatDurationSeconds(125), '2:05');
    assert.equal(formatDurationSeconds(3725), '1:02:05');
    assert.equal(formatDurationSeconds(null), 'Unknown');
  });

  it('formats elapsed time at a human scale', () => {
    assert.equal(formatElapsedMs(3_900_000), '1h 5m');
    assert.equal(formatElapsedMs(63_000), '1m 3s');
    assert.equal(formatElapsedMs(12_000), '12s');
    assert.equal(formatElapsedMs(null), 'N/A');
  });

  it('summarises the parts of a video that are known', () => {
    const withAudio: VideoMetadata = {
      duration: 125,
      video: { width: 1920, height: 1080, framesPerSecond: 29.97, codec: 'h264' },
      audio: {
        channels: 6,
        channelLayout: '5.1',
        codec: 'aac',
        sampleRate: 48000,
        bitrate: null,
        profile: '5.1-surround',
      },
      container: { fileSize: null, bitrate: null, formatName: 'mp4' },
    };

    assert.equal(formatVideoSummary(withAudio), '1920×1080 • 2:05 • 30fps • Audio: 6ch');
    assert.equal(formatVideoSummary({ ...withAudio, audio: null }).endsWith('No audio'), true);
    assert.equal(formatVideoSummary(null), '');
  });

  it('renders progress and file sizes', () => {
    assert.equal(formatPercent(0.425), '43%');
    assert.equal(formatPercent(2), '100%');
    assert.equal(formatFileSize(null), 'Unknown');
    assert.equal(formatFileSize(12_400_000), '12.4 MB');
  });
});

describe('store', () => {
  it('applies pure transitions', () => {
    const store = createStore({ count: 0 });
    store.update((previous) => ({ count: previous.count + 1 }));
    assert.deepEqual(store.get(), { count: 1 });
  });

  it('notifies subscribers only when the value actually changes', () => {
    const store = createStore(1);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.set(1);
    assert.equal(notifications, 0);
    store.set(2);
    assert.equal(notifications, 1);

    unsubscribe();
    store.set(3);
    assert.equal(notifications, 1);
  });

  it('survives a listener unsubscribing during notification', () => {
    const store = createStore(0);
    const seen: string[] = [];
    const first = store.subscribe(() => {
      seen.push('first');
      first();
    });
    store.subscribe(() => seen.push('second'));

    store.set(1);
    assert.deepEqual(seen, ['first', 'second']);
  });
});

describe('exclusive task', () => {
  it('skips a task that is already running', async () => {
    const task = createExclusiveTask();
    let runs = 0;
    const slow = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runs;
    };

    const [first, second] = await Promise.all([task.runExclusive(slow), task.runExclusive(slow)]);
    assert.equal(first, 1);
    assert.equal(second, null);
    assert.equal(task.isRunning(), false);
  });

  it('releases the guard when the task throws', async () => {
    const task = createExclusiveTask();
    await assert.rejects(task.runExclusive(async () => Promise.reject(new Error('boom'))));
    assert.equal(task.isRunning(), false);
  });
});

describe('logger', () => {
  const collect = () => {
    const entries: LogEntry[] = [];
    return { entries, sink: (entry: LogEntry) => entries.push(entry) };
  };

  const now = () => asIsoTimestamp('2026-08-21T00:00:00.000Z');

  it('drops entries below the configured level', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ scope: 'app', minLevel: 'info', sink, now });

    logger.debug('quiet');
    logger.warn('loud');

    assert.deepEqual(entries.map((entry) => entry.level), ['warn']);
  });

  it('nests child scopes', () => {
    const { entries, sink } = collect();
    createLogger({ scope: 'server', minLevel: 'debug', sink, now }).child('index').info('built');

    assert.equal(entries[0]?.scope, 'server.index');
  });

  it('appends the cause of an error', () => {
    const { entries, sink } = collect();
    createLogger({ scope: 'app', minLevel: 'debug', sink, now }).error(
      'failed',
      new Error('disk full'),
    );

    assert.equal(entries[0]?.message.includes('disk full'), true);
  });

  it('formats an entry for the console', () => {
    assert.equal(
      formatLogEntry({
        timestamp: asIsoTimestamp('2026-08-21T00:00:00.000Z'),
        level: 'warn',
        scope: 'app',
        message: 'careful',
      }),
      '[2026-08-21T00:00:00.000Z] [WARN] [app] careful',
    );
  });
});
