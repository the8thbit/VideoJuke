import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFixedClock, toLocalTimeFacts } from '../src/shared/time/clock';
import {
  decodeTimeCondition,
  isEmptyTimeCondition,
  matchesTimeCondition,
  minuteParityOf,
} from '../src/shared/time/timeConditions';
import { EMPTY_TIME_CONDITION, type LocalTimeFacts } from '../src/shared/types/time';
import { createIssueCollector } from '../src/shared/util/decode';

const decode = (value: unknown) => {
  const collector = createIssueCollector();
  const condition = decodeTimeCondition(collector.context, value);
  return { condition, issues: collector.issues() };
};

const factsAt = (
  overrides: Partial<LocalTimeFacts> = {},
): LocalTimeFacts => ({
  epochMs: Date.UTC(2026, 5, 18, 14, 35),
  dayOfWeek: 4,
  hour: 14,
  minute: 35,
  dayOfMonth: 18,
  month: 6,
  year: 2026,
  ...overrides,
});

describe('decodeTimeCondition', () => {
  it('accepts a scalar wherever a list is allowed', () => {
    const { condition, issues } = decode({ dayOfWeek: 3, month: [6, 7] });
    assert.deepEqual(condition.daysOfWeek, [3]);
    assert.deepEqual(condition.months, [6, 7]);
    assert.deepEqual(issues, []);
  });

  it('leaves absent fields unconstrained', () => {
    const { condition } = decode({});
    assert.deepEqual(condition, EMPTY_TIME_CONDITION);
    assert.equal(isEmptyTimeCondition(condition), true);
  });

  it('reads an hour range as a half-open window', () => {
    const { condition } = decode({ hourRange: [9, 17] });
    assert.deepEqual(condition.hourRange, { startHour: 9, endHour: 17 });
  });

  it('rejects a malformed hour range with a warning rather than a throw', () => {
    const { condition, issues } = decode({ hourRange: [9] });
    assert.equal(condition.hourRange, null);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, 'warning');
  });

  it('closes a gate it cannot read instead of removing it', () => {
    // A gate the user wrote and we cannot honour must not become no gate at
    // all: this used to leave `hourRange: null`, which reads as "any hour", so a
    // seasonal directory meant for one evening became eligible around the clock.
    const { condition } = decode({ hourRange: [9] });
    assert.equal(condition.unsatisfiable, true);
    assert.equal(isEmptyTimeCondition(condition), false);
    assert.equal(matchesTimeCondition(condition, factsAt()), false);

    const dates = decode({ dateRange: ['2026-12-01', 'not a date'] }).condition;
    assert.equal(dates.unsatisfiable, true);
    assert.equal(matchesTimeCondition(dates, factsAt()), false);
  });

  it('parses a bare date as a local calendar day, end included', () => {
    // Not `Date.parse`, which reads a bare date as UTC midnight. The facts these
    // bounds are compared against are local, so that slid the whole window by
    // the machine's offset and cut the final day off entirely.
    const { condition } = decode({ dateRange: ['2026-12-01', '2026-12-26'] });
    assert.equal(condition.dateRange?.startMs, new Date(2026, 11, 1).getTime());
    assert.equal(condition.dateRange?.endMs, new Date(2026, 11, 27).getTime() - 1);
  });

  it('leaves a bound alone when it spells out a time', () => {
    const { condition } = decode({ dateRange: ['2026-12-24T18:00:00', '2026-12-24T23:00:00'] });
    assert.equal(condition.dateRange?.startMs, Date.parse('2026-12-24T18:00:00'));
    assert.equal(condition.dateRange?.endMs, Date.parse('2026-12-24T23:00:00'));
  });

  it('drops out-of-range values instead of silently matching them', () => {
    const { condition, issues } = decode({ dayOfWeek: [1, 9], month: 13 });
    assert.deepEqual(condition.daysOfWeek, [1]);
    // Present but empty, not absent. `month: 13` is a constraint nothing can
    // satisfy; collapsing it to null would have made it match every month,
    // which is the opposite of what the user asked for.
    assert.deepEqual(condition.months, []);
    assert.equal(issues.length, 2);
    assert.equal(matchesTimeCondition(condition, factsAt({ dayOfWeek: 1, month: 6 })), false);
  });
});

describe('matchesTimeCondition', () => {
  it('is vacuously true when nothing is constrained', () => {
    assert.equal(matchesTimeCondition(EMPTY_TIME_CONDITION, factsAt()), true);
  });

  it('requires every constrained field to match', () => {
    const { condition } = decode({ month: 6, dayOfWeek: [4, 5] });
    assert.equal(matchesTimeCondition(condition, factsAt()), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ dayOfWeek: 1 })), false);
    assert.equal(matchesTimeCondition(condition, factsAt({ month: 7 })), false);
  });

  it('treats an hour range as start-inclusive and end-exclusive', () => {
    const { condition } = decode({ hourRange: [9, 17] });
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 9 })), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 16 })), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 17 })), false);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 8 })), false);
  });

  it('wraps an overnight hour range past midnight', () => {
    const { condition } = decode({ hourRange: [22, 6] });
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 23 })), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 2 })), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 6 })), false);
    assert.equal(matchesTimeCondition(condition, factsAt({ hour: 12 })), false);
  });

  it('matches minute parity', () => {
    const { condition } = decode({ minuteParity: 'odd' });
    assert.equal(matchesTimeCondition(condition, factsAt({ minute: 35 })), true);
    assert.equal(matchesTimeCondition(condition, factsAt({ minute: 34 })), false);
  });

  it('includes every hour of both end days', () => {
    const { condition } = decode({ dateRange: ['2026-06-01', '2026-06-30'] });
    const at = (...parts: readonly number[]): number =>
      new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1, parts[3] ?? 0).getTime();

    for (const inside of [
      at(2026, 6, 1, 0),
      at(2026, 6, 1, 23),
      at(2026, 6, 30, 0),
      // The last day used to fall outside the range altogether.
      at(2026, 6, 30, 23),
    ]) {
      assert.equal(matchesTimeCondition(condition, factsAt({ epochMs: inside })), true);
    }

    for (const outside of [at(2026, 5, 31, 23), at(2026, 7, 1, 0)]) {
      assert.equal(matchesTimeCondition(condition, factsAt({ epochMs: outside })), false);
    }
  });
});

describe('clock', () => {
  it('reports months as 1-12', () => {
    const facts = toLocalTimeFacts(new Date(2026, 0, 15, 3, 4));
    assert.equal(facts.month, 1);
    assert.equal(facts.dayOfMonth, 15);
    assert.equal(facts.hour, 3);
  });

  it('freezes time so selection logic is reproducible in tests', () => {
    const clock = createFixedClock(1_000_000);
    assert.equal(clock.now(), 1_000_000);
    assert.equal(clock.now(), 1_000_000);
    assert.equal(clock.nowIso(), new Date(1_000_000).toISOString());
  });
});

describe('minuteParityOf', () => {
  it('classifies even and odd minutes', () => {
    assert.equal(minuteParityOf(0), 'even');
    assert.equal(minuteParityOf(59), 'odd');
  });
});

describe('a constraint nobody can read', () => {
  const conditionFor = (conditions: Record<string, unknown>) => decode(conditions).condition;

  /**
   * A mistyped gate has to close, not open. The same rule the scalar-or-array
   * reader spells out: dropping an unreadable constraint leaves the directory
   * behind it playing all year, which is the opposite of what was asked for.
   */
  it('closes the gate on a parity it cannot read', () => {
    const condition = conditionFor({ minuteParity: 'Even' });
    assert.equal(condition.unsatisfiable, true);
    assert.equal(condition.minuteParity, null);
  });

  it('still reads the two spellings it knows', () => {
    assert.equal(conditionFor({ minuteParity: 'even' }).minuteParity, 'even');
    assert.equal(conditionFor({ minuteParity: 'odd' }).minuteParity, 'odd');
    assert.equal(conditionFor({ minuteParity: 'even' }).unsatisfiable, false);
  });

  it('leaves an absent parity as no constraint at all', () => {
    const condition = conditionFor({ month: [12] });
    assert.equal(condition.minuteParity, null);
    assert.equal(condition.unsatisfiable, false);
  });

  it('never matches an instant once the condition is unsatisfiable', () => {
    const condition = conditionFor({ minuteParity: 'Even' });
    assert.equal(matchesTimeCondition(condition, factsAt()), false);
    assert.equal(matchesTimeCondition(condition, factsAt({ minute: 34 })), false);
    assert.equal(isEmptyTimeCondition(condition), false);
  });
});
