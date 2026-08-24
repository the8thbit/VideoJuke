import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectVideo, type SeasonalCandidate } from '../src/shared/queue/selection';
import { toLocalTimeFacts } from '../src/shared/time/clock';
import { decodeTimeCondition } from '../src/shared/time/timeConditions';
import { asIsoTimestamp, asSourceVideoPath } from '../src/shared/types/brand';
import { createIssueCollector } from '../src/shared/util/decode';
import type { IndexedVideo } from '../src/shared/types/video';
import type { NormalizedTimeCondition } from '../src/shared/types/time';

const video = (path: string, seasonalDirectory: string | null = null): IndexedVideo => ({
  originalPath: asSourceVideoPath(path),
  filename: path.slice(path.lastIndexOf('/') + 1),
  directory: path.slice(0, path.lastIndexOf('/')),
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory,
});

const conditionOf = (raw: unknown): NormalizedTimeCondition => {
  const collector = createIssueCollector();
  return decodeTimeCondition(collector.context, raw);
};

const issuesOf = (raw: unknown): readonly string[] => {
  const collector = createIssueCollector();
  decodeTimeCondition(collector.context, raw);
  return collector.issues().map((issue) => issue.message);
};

const factsAt = (local: string) => toLocalTimeFacts(new Date(local));

/** Deterministic, so a distribution assertion is reproducible. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const REGULAR = [video('X:/videos/a.mp4'), video('X:/videos/b.mp4')];

const christmas = (
  raw: unknown,
  likelihood = 1,
  videos = [video('X:/videos/christmas/santa.mp4', 'X:/videos/christmas')],
): SeasonalCandidate => ({
  directory: 'X:/videos/christmas',
  likelihood,
  conditions: conditionOf(raw),
  videos,
});

const pick = (seasonal: readonly SeasonalCandidate[], at: string, random = seeded(1)) =>
  selectVideo({
    regular: REGULAR,
    seasonal,
    excludedPaths: new Set<string>(),
    facts: factsAt(at),
    random,
  });

describe('seasonal date ranges', () => {
  it('covers both endpoint days in full, in local time', () => {
    // A holiday range is written in calendar days. Parsing the bounds as UTC
    // instants shifted the whole window by the machine's offset and cut the end
    // day off entirely: west of Greenwich a "Dec 1 to Dec 26" folder started on
    // the evening of Nov 30 and stopped on the evening of Dec 25.
    const range = christmas({ dateRange: ['2026-12-01', '2026-12-26'] });

    for (const inside of [
      '2026-12-01T00:00:00',
      '2026-12-01T12:00:00',
      '2026-12-25T23:59:00',
      '2026-12-26T00:00:00',
      '2026-12-26T12:00:00',
      '2026-12-26T23:59:59',
    ]) {
      assert.equal(pick([range], inside).kind, 'seasonal', `should be active at ${inside}`);
    }

    for (const outside of [
      '2026-11-30T12:00:00',
      '2026-11-30T23:59:59',
      '2026-12-27T00:00:00',
      '2026-12-27T12:00:00',
    ]) {
      assert.equal(pick([range], outside).kind, 'regular', `should be inactive at ${outside}`);
    }
  });

  it('honours an explicit time when one is written', () => {
    const evening = christmas({ dateRange: ['2026-12-24T18:00:00', '2026-12-24T23:00:00'] });
    assert.equal(pick([evening], '2026-12-24T19:00:00').kind, 'seasonal');
    assert.equal(pick([evening], '2026-12-24T17:00:00').kind, 'regular');
    assert.equal(pick([evening], '2026-12-24T23:30:00').kind, 'regular');
  });

  it('refuses a range whose end precedes its start', () => {
    const backwards = christmas({ dateRange: ['2026-12-26', '2026-12-01'] });
    assert.equal(backwards.conditions.unsatisfiable, true);
    assert.equal(pick([backwards], '2026-12-10T12:00:00').kind, 'regular');
    assert.ok(issuesOf({ dateRange: ['2026-12-26', '2026-12-01'] }).length > 0);
  });

  it('refuses a date that is not a real day', () => {
    assert.equal(conditionOf({ dateRange: ['2026-02-30', '2026-03-05'] }).unsatisfiable, true);
    assert.equal(conditionOf({ dateRange: ['nonsense', '2026-03-05'] }).unsatisfiable, true);
  });
});

describe('seasonal gating', () => {
  it('fires only inside a month window', () => {
    const october = christmas({ month: 10 });
    assert.equal(pick([october], '2026-10-15T12:00:00').kind, 'seasonal');
    assert.equal(pick([october], '2026-09-30T12:00:00').kind, 'regular');
    assert.equal(pick([october], '2026-11-01T12:00:00').kind, 'regular');
  });

  it('handles an hour window that wraps past midnight', () => {
    const lateNight = christmas({ hourRange: [22, 6] });
    assert.equal(pick([lateNight], '2026-06-01T23:00:00').kind, 'seasonal');
    assert.equal(pick([lateNight], '2026-06-01T02:00:00').kind, 'seasonal');
    assert.equal(pick([lateNight], '2026-06-01T12:00:00').kind, 'regular');
    // The window is half-open at the end, so 06:00 itself is out.
    assert.equal(pick([lateNight], '2026-06-01T06:00:00').kind, 'regular');
  });

  it('never fires on a gate it could not read', () => {
    const broken = christmas({ hourRange: [9] });
    assert.equal(pick([broken], '2026-06-01T09:30:00').kind, 'regular');
  });

  it('falls through to regular when the holiday folder is exhausted', () => {
    const empty = christmas({ month: 12 }, 1, []);
    assert.equal(pick([empty], '2026-12-10T12:00:00').kind, 'regular');
  });

  it('falls through when every holiday video is already queued', () => {
    const santa = video('X:/videos/christmas/santa.mp4', 'X:/videos/christmas');
    const outcome = selectVideo({
      regular: REGULAR,
      seasonal: [christmas({ month: 12 }, 1, [santa])],
      excludedPaths: new Set([santa.originalPath]),
      facts: factsAt('2026-12-10T12:00:00'),
      random: seeded(3),
    });
    assert.equal(outcome.kind, 'regular');
  });

  it('offers directories in configured order', () => {
    const first = { ...christmas({ month: 12 }, 1), directory: 'first' };
    const second = { ...christmas({ month: 12 }, 1), directory: 'second' };
    const outcome = pick([first, second], '2026-12-10T12:00:00');
    assert.equal(outcome.kind, 'seasonal');
    assert.equal(outcome.kind === 'seasonal' ? outcome.directory : '', 'first');
  });
});

describe('seasonal likelihood', () => {
  const rate = (likelihood: number, trials = 4000): number => {
    const random = seeded(12345);
    const candidate = christmas({ month: 12 }, likelihood);
    let seasonal = 0;
    for (let i = 0; i < trials; i += 1) {
      const outcome = selectVideo({
        regular: REGULAR,
        seasonal: [candidate],
        excludedPaths: new Set<string>(),
        facts: factsAt('2026-12-10T12:00:00'),
        random,
      });
      if (outcome.kind === 'seasonal') seasonal += 1;
    }
    return seasonal / trials;
  };

  it('never picks a directory whose likelihood is zero', () => {
    assert.equal(rate(0), 0);
  });

  it('always picks an active directory whose likelihood is one', () => {
    assert.equal(rate(1), 1);
  });

  it('lands near the configured probability in between', () => {
    for (const likelihood of [0.25, 0.5, 0.75]) {
      const observed = rate(likelihood);
      assert.ok(
        Math.abs(observed - likelihood) < 0.03,
        `likelihood ${likelihood} produced ${observed}`,
      );
    }
  });

  it('is unreachable while the gate is shut, whatever the likelihood', () => {
    const random = seeded(7);
    const candidate = christmas({ month: 12 }, 1);
    for (let i = 0; i < 200; i += 1) {
      const outcome = selectVideo({
        regular: REGULAR,
        seasonal: [candidate],
        excludedPaths: new Set<string>(),
        facts: factsAt('2026-07-04T12:00:00'),
        random,
      });
      assert.equal(outcome.kind, 'regular');
    }
  });
});

describe('empty pools', () => {
  it('reports no-videos when there is nothing anywhere', () => {
    const outcome = selectVideo({
      regular: [],
      seasonal: [],
      excludedPaths: new Set<string>(),
      facts: factsAt('2026-12-10T12:00:00'),
      random: seeded(1),
    });
    assert.deepEqual(outcome, { kind: 'none', reason: 'no-videos' });
  });

  it('distinguishes an exhausted pool from an empty one', () => {
    const outcome = selectVideo({
      regular: REGULAR,
      seasonal: [],
      excludedPaths: new Set(REGULAR.map((entry) => entry.originalPath)),
      facts: factsAt('2026-12-10T12:00:00'),
      random: seeded(1),
    });
    assert.deepEqual(outcome, { kind: 'none', reason: 'all-excluded' });
  });
});
