import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { createLengthWeight, toLengthRange } from '../src/shared/queue/lengthBias';
import {
  pickWeighted,
  selectVideo,
  type DirectoryCandidate,
} from '../src/shared/queue/selection';
import { asIsoTimestamp, asSourceVideoPath } from '../src/shared/types/brand';
import type { LengthBiasConfig } from '../src/shared/types/config';
import type { LocalTimeFacts } from '../src/shared/types/time';
import type { IndexedVideo } from '../src/shared/types/video';
import { toDirectoryCandidates } from '../src/server/domain/videoIndex';

const FACTS: LocalTimeFacts = {
  epochMs: Date.UTC(2026, 5, 18, 14, 35),
  dayOfWeek: 4,
  hour: 14,
  minute: 35,
  dayOfMonth: 18,
  month: 6,
  year: 2026,
};

const video = (path: string): IndexedVideo => ({
  originalPath: asSourceVideoPath(path),
  filename: path.slice(path.lastIndexOf('/') + 1),
  directory: path.slice(0, path.lastIndexOf('/')),
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory: null,
});

const directory = (name: string, bias: number, count: number): DirectoryCandidate => ({
  directory: `/${name}`,
  bias,
  videos: Array.from({ length: count }, (_, index) => video(`/${name}/${index}.mp4`)),
});

/** A seeded generator, so the proportions below are the same on every run. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

/** How often each directory wins over many picks. */
const shares = (
  regular: readonly DirectoryCandidate[],
  { scaled, picks = 20000 }: { readonly scaled: boolean; readonly picks?: number },
) => {
  const random = seeded(7);
  const counts: Record<string, number> = {};
  for (let index = 0; index < picks; index += 1) {
    const outcome = selectVideo({
      regular,
      seasonal: [],
      excludedPaths: new Set(),
      facts: FACTS,
      random,
      scaleBiasByDirectorySize: scaled,
    });
    if (outcome.kind !== 'regular') throw new Error(`expected a pick, got ${outcome.kind}`);
    counts[outcome.directory] = (counts[outcome.directory] ?? 0) + 1;
  }
  const result: Record<string, number> = {};
  for (const key of Object.keys(counts)) result[key] = (counts[key] ?? 0) / picks;
  return result;
};

const near = (actual: number | undefined, expected: number, tolerance = 0.02): void => {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    `expected about ${expected}, got ${actual}`,
  );
};

describe('pickWeighted', () => {
  it('picks in proportion to the weights', () => {
    const random = seeded(3);
    let heavy = 0;
    for (let index = 0; index < 20000; index += 1) {
      if (pickWeighted(['a', 'b'], (value) => (value === 'a' ? 3 : 1), random) === 'a') heavy += 1;
    }
    near(heavy / 20000, 0.75);
  });

  it('falls back to an even pick when every weight is zero', () => {
    const picked = pickWeighted(['a', 'b'], () => 0, () => 0.99);
    assert.equal(picked, 'b');
  });

  it('never picks a zero-weight value while another has weight', () => {
    for (const draw of [0, 0.25, 0.5, 0.999]) {
      assert.equal(pickWeighted(['zero', 'one'], (v) => (v === 'zero' ? 0 : 1), () => draw), 'one');
    }
  });
});

describe('directory bias, scaled by directory size (the default)', () => {
  const scaled = { scaled: true };

  it('makes every video equally likely when the biases are equal', () => {
    const result = shares([directory('small', 1, 10), directory('large', 1, 100)], scaled);
    near(result['/small'], 10 / 110);
    near(result['/large'], 100 / 110);
  });

  it('is what an omitted setting means', () => {
    const regular = [directory('small', 1, 10), directory('large', 1, 100)];
    const random = seeded(5);
    let small = 0;
    for (let index = 0; index < 20000; index += 1) {
      const outcome = selectVideo({
        regular,
        seasonal: [],
        excludedPaths: new Set(),
        facts: FACTS,
        random,
      });
      if (outcome.kind === 'regular' && outcome.directory === '/small') small += 1;
    }
    near(small / 20000, 10 / 110);
  });

  it('multiplies the bias by the number of videos', () => {
    // 2 x 10 against 1 x 30: the smaller directory still wins 20 to 30.
    const result = shares([directory('double', 2, 10), directory('single', 1, 30)], scaled);
    near(result['/double'], 20 / 50);
    near(result['/single'], 30 / 50);
  });

  it('counts only the videos still available', () => {
    const large = directory('large', 1, 30);
    const random = seeded(9);
    let fromLarge = 0;
    for (let index = 0; index < 20000; index += 1) {
      const outcome = selectVideo({
        regular: [directory('small', 1, 10), large],
        seasonal: [],
        // Twenty of the thirty are already queued, leaving ten against ten.
        excludedPaths: new Set(large.videos.slice(0, 20).map((entry) => entry.originalPath)),
        facts: FACTS,
        random,
        scaleBiasByDirectorySize: true,
      });
      if (outcome.kind === 'regular' && outcome.directory === '/large') fromLarge += 1;
    }
    near(fromLarge / 20000, 0.5);
  });

  it('only draws from a zero-bias directory once the others are used up', () => {
    const zero = directory('zero', 0, 300);
    const one = directory('one', 1, 1);
    const result = shares([zero, one], { scaled: true, picks: 2000 });
    assert.equal(result['/zero'], undefined);
  });

  it('shares the leftovers by size once only zero-bias directories remain', () => {
    const result = shares([directory('few', 0, 10), directory('many', 0, 30)], scaled);
    near(result['/few'], 0.25);
    near(result['/many'], 0.75);
  });
});

describe('directory bias, unscaled', () => {
  const unscaled = { scaled: false };

  it('makes equally biased directories equally likely whatever their size', () => {
    const result = shares([directory('small', 1, 5), directory('large', 1, 500)], unscaled);
    near(result['/small'], 0.5);
    near(result['/large'], 0.5);
  });

  it('makes a bias of 2 twice as likely as a bias of 1', () => {
    const result = shares([directory('double', 2, 10), directory('single', 1, 30)], unscaled);
    near(result['/double'], 2 / 3);
  });

  it('takes fractional biases at their word', () => {
    const result = shares([directory('more', 2.3, 10), directory('less', 1, 10)], unscaled);
    near(result['/more'], 2.3 / 3.3);
  });

  it('balances several biased directories against one another', () => {
    const result = shares(
      [
        directory('a', 1, 3),
        directory('b', 2, 30),
        directory('c', 2, 300),
        directory('d', 0.5, 3000),
      ],
      unscaled,
    );
    near(result['/a'], 1 / 5.5);
    near(result['/b'], 2 / 5.5);
    near(result['/c'], 2 / 5.5);
    near(result['/d'], 0.5 / 5.5);
  });

  it('only draws from a zero-bias directory once the others are used up', () => {
    const zero = directory('zero', 0, 3);
    const one = directory('one', 1, 1);
    const result = shares([zero, one], { scaled: false, picks: 2000 });
    assert.equal(result['/zero'], undefined);

    const outcome = selectVideo({
      regular: [zero, one],
      seasonal: [],
      excludedPaths: new Set(one.videos.map((entry) => entry.originalPath)),
      facts: FACTS,
      random: () => 0.5,
      scaleBiasByDirectorySize: false,
    });
    assert.equal(outcome.kind === 'regular' ? outcome.directory : null, '/zero');
  });

  it('skips a directory with nothing left rather than failing the pick', () => {
    const empty = directory('empty', 100, 0);
    const outcome = selectVideo({
      regular: [empty, directory('full', 1, 2)],
      seasonal: [],
      excludedPaths: new Set(),
      facts: FACTS,
      random: () => 0,
    });
    assert.equal(outcome.kind === 'regular' ? outcome.directory : null, '/full');
  });
});

describe('directory candidates', () => {
  it('gives each video to the deepest configured directory that holds it', () => {
    const candidates = toDirectoryCandidates(
      [video('/media/a.mp4'), video('/media/kids/b.mp4'), video('/media/kids/c.mp4')],
      [
        { directory: '/media', bias: 1 },
        { directory: '/media/kids', bias: 3 },
      ],
    );
    assert.deepEqual(
      candidates.map((entry) => [entry.directory, entry.bias, entry.videos.length]),
      [
        ['/media', 1, 1],
        ['/media/kids', 3, 2],
      ],
    );
  });
});

describe('length bias', () => {
  const enabled: LengthBiasConfig = { enabled: true, favor: 'shorter', maxRatio: 10 };
  const range = { shortest: 60, longest: 3600 };

  it('makes the shortest video ten times as likely as the longest by default', () => {
    const weight = createLengthWeight(enabled, range);
    near(weight(60) / weight(3600), 10, 1e-9);
  });

  it('turns around when longer videos are favoured', () => {
    const weight = createLengthWeight({ ...enabled, favor: 'longer', maxRatio: 4 }, range);
    near(weight(3600) / weight(60), 4, 1e-9);
  });

  it('is a straight line on a log scale', () => {
    // Doubling a length costs the same factor wherever it happens.
    const weight = createLengthWeight(enabled, range);
    near(weight(120) / weight(240), weight(900) / weight(1800), 1e-9);
  });

  it('puts a video of unknown length in the geometric middle', () => {
    const weight = createLengthWeight(enabled, range);
    near(weight(null), Math.sqrt(10), 1e-9);
  });

  it('keeps lengths outside the measured range at its ends', () => {
    const weight = createLengthWeight(enabled, range);
    near(weight(1), weight(60), 1e-9);
    near(weight(99999), weight(3600), 1e-9);
  });

  it('is neutral when disabled, flat, or with nothing measured', () => {
    assert.equal(createLengthWeight({ ...enabled, enabled: false }, range)(60), 1);
    assert.equal(createLengthWeight(enabled, { shortest: 300, longest: 300 })(300), 1);
    assert.equal(createLengthWeight(enabled, null)(300), 1);
    assert.equal(createLengthWeight({ ...enabled, maxRatio: 1 }, range)(60), 1);
  });

  it('measures its range from the known lengths only', () => {
    assert.deepEqual(toLengthRange([null, 300, 30, null, 900]), { shortest: 30, longest: 900 });
    assert.equal(toLengthRange([null, null]), null);
  });

  it('applies across the whole library when biases scale with size', () => {
    // One video per directory, so any difference between them is the length.
    const short = video('/a/short.mp4');
    const long = video('/b/long.mp4');
    const lengths: Record<string, number> = { [short.originalPath]: 60, [long.originalPath]: 3600 };
    const weight = createLengthWeight(enabled, range);
    const random = seeded(13);
    let shortPicks = 0;
    for (let index = 0; index < 20000; index += 1) {
      const outcome = selectVideo({
        regular: [
          { directory: '/a', bias: 1, videos: [short] },
          { directory: '/b', bias: 1, videos: [long] },
        ],
        seasonal: [],
        excludedPaths: new Set(),
        facts: FACTS,
        random,
        weightOf: (entry) => weight(lengths[entry.originalPath] ?? null),
        scaleBiasByDirectorySize: true,
      });
      if (outcome.kind === 'regular' && outcome.video.originalPath === short.originalPath) {
        shortPicks += 1;
      }
    }
    near(shortPicks / 20000, 10 / 11);
  });

  it('applies within a directory without disturbing the share when biases do not scale', () => {
    const short = video('/a/short.mp4');
    const long = video('/a/long.mp4');
    const lengths: Record<string, number> = { [short.originalPath]: 60, [long.originalPath]: 3600 };
    const weight = createLengthWeight(enabled, range);
    const random = seeded(11);
    let fromA = 0;
    let shortPicks = 0;
    for (let index = 0; index < 20000; index += 1) {
      const outcome = selectVideo({
        regular: [
          { directory: '/a', bias: 1, videos: [short, long] },
          directory('b', 1, 5),
        ],
        seasonal: [],
        excludedPaths: new Set(),
        facts: FACTS,
        random,
        weightOf: (entry) => weight(lengths[entry.originalPath] ?? null),
        scaleBiasByDirectorySize: false,
      });
      if (outcome.kind !== 'regular' || outcome.directory !== '/a') continue;
      fromA += 1;
      if (outcome.video.originalPath === short.originalPath) shortPicks += 1;
    }
    near(fromA / 20000, 0.5);
    near(shortPicks / fromA, 10 / 11);
  });
});

describe('selection settings', () => {
  it('reads a bare directory as a bias of 1 and an object as written', () => {
    const { config, issues } = normalizeConfig({
      directories: ['/plain', { directory: '/biased', bias: 2.3 }],
    });
    assert.deepEqual(config.directories, [
      { directory: '/plain', bias: 1 },
      { directory: '/biased', bias: 2.3 },
    ]);
    assert.deepEqual(issues, []);
  });

  it('refuses a negative bias', () => {
    const { config, issues } = normalizeConfig({
      directories: [{ directory: '/negative', bias: -1 }],
    });
    assert.equal(config.directories[0]?.bias, 0);
    assert.equal(issues.length, 1);
  });

  it('ships biases scaled by directory size, and reads them unscaled when asked', () => {
    const shipped = normalizeConfig({ directories: ['/videos'] }).config;
    assert.equal(shipped.selection.scaleBiasByDirectorySize, true);
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      selection: { scaleBiasByDirectorySize: false },
    });
    assert.equal(config.selection.scaleBiasByDirectorySize, false);
    assert.deepEqual(issues, []);
  });

  it('ships the length bias off, favouring shorter videos ten to one', () => {
    const { config } = normalizeConfig({ directories: ['/videos'] });
    assert.deepEqual(config.selection.lengthBias, { enabled: false, favor: 'shorter', maxRatio: 10 });
  });

  it('ships both startup chains off', () => {
    const { config } = normalizeConfig({ directories: ['/videos'] });
    assert.deepEqual(config.startup, { autoQueueAfterIndex: false, autoPlayAfterQueue: false });
  });

  it('rejects a direction it does not know', () => {
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      selection: { lengthBias: { favor: 'sideways' } },
    });
    assert.equal(config.selection.lengthBias.favor, 'shorter');
    assert.equal(issues.length, 1);
  });
});
