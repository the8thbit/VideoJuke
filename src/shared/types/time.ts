export type MinuteParity = 'even' | 'odd';

/** Inclusive-start, exclusive-end hour window; may wrap past midnight. */
export interface HourRange {
  readonly startHour: number;
  readonly endHour: number;
}

/** Inclusive calendar-date window, expressed as epoch milliseconds. */
export interface DateRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A time predicate in canonical form: the raw config allows either a scalar or
 * an array for each field, and normalisation collapses both onto arrays so the
 * evaluator has exactly one shape to reason about. Every present field must
 * match for the condition to hold; a condition with no fields is vacuously
 * true, which is how a seasonal directory declares itself always eligible.
 */
export interface NormalizedTimeCondition {
  readonly daysOfWeek: readonly number[] | null;
  readonly hours: readonly number[] | null;
  readonly hourRange: HourRange | null;
  readonly minutes: readonly number[] | null;
  readonly minuteParity: MinuteParity | null;
  readonly daysOfMonth: readonly number[] | null;
  readonly months: readonly number[] | null;
  readonly years: readonly number[] | null;
  readonly dateRange: DateRange | null;
  /**
   * Set when a field was written but could not be understood.
   *
   * A gate that cannot be read must not become no gate at all. `hourRange: [9]`
   * or `dateRange: ["not a date", ...]` used to decode to null, which the
   * evaluator reads as "no constraint" - so a seasonal directory meant to appear
   * for two weeks in December became eligible every minute of the year, and
   * started winning slots from the main library on the strength of a typo. The
   * evaluator refuses such a condition outright instead.
   */
  readonly unsatisfiable: boolean;
}

/** Calendar fields of an instant, in the host's local time zone. */
export interface LocalTimeFacts {
  readonly epochMs: number;
  /** 0 = Sunday, 6 = Saturday. */
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfMonth: number;
  /** 1-12, unlike the 0-11 returned by the Date API. */
  readonly month: number;
  readonly year: number;
}

export const EMPTY_TIME_CONDITION: NormalizedTimeCondition = {
  daysOfWeek: null,
  hours: null,
  hourRange: null,
  minutes: null,
  minuteParity: null,
  daysOfMonth: null,
  months: null,
  years: null,
  dateRange: null,
  unsatisfiable: false,
};
