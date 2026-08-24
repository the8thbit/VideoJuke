import type {
  DateRange,
  HourRange,
  LocalTimeFacts,
  MinuteParity,
  NormalizedTimeCondition,
} from '../types/time';
import {
  readEnum,
  readField,
  readNumberArray,
  readScalarOrArray,
  readSection,
  type DecodeContext,
} from '../util/decode';
import { toIsoTimestamp } from './clock';

const MINUTE_PARITIES: readonly MinuteParity[] = ['even', 'odd'];

/** Last hour boundary an `hourRange` may name; 24 is midnight as an end point. */
const HOURS_PER_DAY = 24;

/**
 * Membership test written with indexOf because `Array.prototype.includes` is
 * ES2016 and shared/ is also compiled against the ES2015 lib for the clients.
 */
const contains = (values: readonly number[], value: number): boolean =>
  values.indexOf(value) !== -1;

/**
 * Narrows a decoded list to exactly two entries. The explicit undefined checks
 * are what noUncheckedIndexedAccess requires, not redundant defence.
 */
const asPair = (values: readonly number[]): readonly [number, number] | null => {
  const [first, second] = values;
  if (values.length !== 2 || first === undefined || second === undefined) return null;
  return [first, second];
};

/**
 * `null` for an absent range, `'unreadable'` for one that was written but could
 * not be understood. Those two must not collapse together: the first means no
 * constraint, the second means a constraint the user intended and we cannot
 * apply, which has to close the gate rather than open it.
 */
type OptionalHourRange = HourRange | null | 'unreadable';
type OptionalDateRange = DateRange | null | 'unreadable';

const readHourRange = (context: DecodeContext, value: unknown): OptionalHourRange => {
  if (value === undefined || value === null) return null;

  const pair = asPair(readNumberArray(context, value, [], { min: 0, max: HOURS_PER_DAY }));
  if (pair === null) {
    context.report('warning', 'expected a [startHour, endHour] pair; the condition cannot match');
    return 'unreadable';
  }
  return { startHour: pair[0], endHour: pair[1] };
};

/** `YYYY-MM-DD` with no time of day, which is how a holiday window is written. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Which end of the range a bound is, which decides where a bare date lands. */
type RangeEdge = 'start' | 'end';

/**
 * Turns one bound of a `dateRange` into an instant.
 *
 * A bare `2026-12-26` is a calendar day, and `Date.parse` reads it as UTC
 * midnight. Both halves of that are wrong here. The facts it is compared against
 * are local, so the whole window slid by the machine's offset - west of
 * Greenwich a "Dec 1 to Dec 26" folder woke up on the evening of Nov 30. And
 * midnight is the *start* of the 26th, so the end day was excluded entirely: the
 * range quietly stopped a day early, every year.
 *
 * A date is therefore read as local, and an end date covers its own day right up
 * to the last millisecond. A string that spells out a time is left alone, since
 * someone who wrote one meant it.
 */
const readDateBound = (
  context: DecodeContext,
  value: unknown,
  edge: RangeEdge,
): number | null => {
  if (typeof value !== 'string') {
    context.report('warning', `ignoring unparseable date ${String(value)}`);
    return null;
  }

  const dateOnly = DATE_ONLY.exec(value.trim());
  if (dateOnly === null) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      context.report('warning', `ignoring unparseable date ${value}`);
      return null;
    }
    return parsed;
  }

  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]);
  const day = Number(dateOnly[3]);

  // `new Date` rolls an impossible day over into the next month rather than
  // refusing it, so 2026-02-30 would silently become 2026-03-02.
  const midnight = new Date(year, month - 1, day);
  if (
    midnight.getFullYear() !== year ||
    midnight.getMonth() !== month - 1 ||
    midnight.getDate() !== day
  ) {
    context.report('warning', `ignoring ${value}: there is no such date`);
    return null;
  }

  if (edge === 'start') return midnight.getTime();
  // The last millisecond of the same local day, found from the next midnight so
  // a daylight-saving change on either side cannot shift it.
  return new Date(year, month - 1, day + 1).getTime() - 1;
};

const readDateRange = (context: DecodeContext, value: unknown): OptionalDateRange => {
  if (value === undefined || value === null) return null;

  if (!Array.isArray(value) || value.length !== 2) {
    context.report('warning', 'expected a [startDate, endDate] pair; the condition cannot match');
    return 'unreadable';
  }

  const startMs = readDateBound(context.at(0), value[0], 'start');
  const endMs = readDateBound(context.at(1), value[1], 'end');
  if (startMs === null || endMs === null) return 'unreadable';

  // Unlike an hour range, a backwards date range is not a window that wraps -
  // there is nothing for it to wrap around - so it is a typo, and one that would
  // otherwise silently never match.
  if (endMs < startMs) {
    context.report('warning', 'the end of the date range precedes its start');
    return 'unreadable';
  }

  return { startMs, endMs };
};

/**
 * `readEnum` always yields a value, so an unrecognised parity cannot simply be
 * taken: imposing the `even` fallback would make a directory active every other
 * minute, which is not what the typo asked for either.
 *
 * It reads as `unreadable` rather than as "no constraint", which is the rule the
 * ranges above already follow and the one `readScalarOrArray` spells out: a gate
 * nobody can satisfy is what a mistyped gate should be. Dropping the constraint
 * instead opens it, and a seasonal directory meant for every other minute played
 * continuously - the failure that rule exists to prevent.
 */
const readMinuteParity = (
  context: DecodeContext,
  value: unknown,
): MinuteParity | 'unreadable' | null => {
  if (value === undefined || value === null) return null;
  const parity = readEnum(context, value, MINUTE_PARITIES, 'even');
  return value === parity ? parity : 'unreadable';
};

/**
 * Reads the raw config shape into canonical form. Raw field names are singular
 * (`hour`, `month`) and accept a scalar or a list; the normalised names are
 * plural and always hold a list. Absent and unusable fields become null, which
 * the evaluator reads as "no constraint".
 */
export const decodeTimeCondition = (
  context: DecodeContext,
  value: unknown,
): NormalizedTimeCondition => {
  const raw = readSection(context, value);

  const hourRange = readHourRange(context.at('hourRange'), readField(raw, 'hourRange'));
  const dateRange = readDateRange(context.at('dateRange'), readField(raw, 'dateRange'));
  const minuteParity = readMinuteParity(
    context.at('minuteParity'),
    readField(raw, 'minuteParity'),
  );

  return {
    daysOfWeek: readScalarOrArray(context.at('dayOfWeek'), readField(raw, 'dayOfWeek'), {
      min: 0,
      max: 6,
    }),
    hours: readScalarOrArray(context.at('hour'), readField(raw, 'hour'), { min: 0, max: 23 }),
    hourRange: hourRange === 'unreadable' ? null : hourRange,
    minutes: readScalarOrArray(context.at('minute'), readField(raw, 'minute'), { min: 0, max: 59 }),
    minuteParity: minuteParity === 'unreadable' ? null : minuteParity,
    daysOfMonth: readScalarOrArray(context.at('dayOfMonth'), readField(raw, 'dayOfMonth'), {
      min: 1,
      max: 31,
    }),
    months: readScalarOrArray(context.at('month'), readField(raw, 'month'), { min: 1, max: 12 }),
    years: readScalarOrArray(context.at('year'), readField(raw, 'year')),
    dateRange: dateRange === 'unreadable' ? null : dateRange,
    unsatisfiable:
      hourRange === 'unreadable' || dateRange === 'unreadable' || minuteParity === 'unreadable',
  };
};

/** True when the condition constrains nothing, and so matches every instant. */
export const isEmptyTimeCondition = (condition: NormalizedTimeCondition): boolean =>
  !condition.unsatisfiable &&
  condition.daysOfWeek === null &&
  condition.hours === null &&
  condition.hourRange === null &&
  condition.minutes === null &&
  condition.minuteParity === null &&
  condition.daysOfMonth === null &&
  condition.months === null &&
  condition.years === null &&
  condition.dateRange === null;

export const minuteParityOf = (minute: number): MinuteParity =>
  minute % 2 === 0 ? 'even' : 'odd';

const allows = (allowed: readonly number[] | null, actual: number): boolean =>
  allowed === null || contains(allowed, actual);

const allowsHour = (range: HourRange | null, hour: number): boolean => {
  if (range === null) return true;
  // A range whose start is past its end wraps midnight, e.g. 22..6 for a night shift.
  return range.startHour <= range.endHour
    ? hour >= range.startHour && hour < range.endHour
    : hour >= range.startHour || hour < range.endHour;
};

const allowsDate = (range: DateRange | null, epochMs: number): boolean =>
  range === null || (epochMs >= range.startMs && epochMs <= range.endMs);

/**
 * Conjunction over the constraints that are present. An empty condition is
 * vacuously true, which is how a seasonal directory declares itself always
 * eligible and matches the legacy evaluator's treatment of `{}`.
 *
 * A condition the decoder could not read is false instead: the user wrote a gate
 * and we cannot honour it, so the safe answer is that it does not open. An empty
 * list of allowed values - `month: [13]`, every entry rejected - is likewise
 * false, because `allows` cannot find the actual value in it.
 */
export const matchesTimeCondition = (
  condition: NormalizedTimeCondition,
  facts: LocalTimeFacts,
): boolean =>
  !condition.unsatisfiable &&
  allows(condition.daysOfWeek, facts.dayOfWeek) &&
  allows(condition.hours, facts.hour) &&
  allowsHour(condition.hourRange, facts.hour) &&
  allows(condition.minutes, facts.minute) &&
  (condition.minuteParity === null || condition.minuteParity === minuteParityOf(facts.minute)) &&
  allows(condition.daysOfMonth, facts.dayOfMonth) &&
  allows(condition.months, facts.month) &&
  allows(condition.years, facts.year) &&
  allowsDate(condition.dateRange, facts.epochMs);

const padTwo = (value: number): string => (value < 10 ? `0${value}` : String(value));

/**
 * One-line summary for debug logs, e.g.
 * `2026-08-21T14:03:59.000Z dow=4 14:03 dom=21 month=8 year=2026 parity=odd`.
 * The timestamp is UTC; every other field is local, because those are the
 * values the conditions are actually compared against.
 */
export const describeTimeFacts = (facts: LocalTimeFacts): string =>
  [
    toIsoTimestamp(facts.epochMs),
    `dow=${facts.dayOfWeek}`,
    `${padTwo(facts.hour)}:${padTwo(facts.minute)}`,
    `dom=${facts.dayOfMonth}`,
    `month=${facts.month}`,
    `year=${facts.year}`,
    `parity=${minuteParityOf(facts.minute)}`,
  ].join(' ');
