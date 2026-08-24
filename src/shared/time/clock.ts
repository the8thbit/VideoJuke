import { asIsoTimestamp, type IsoTimestamp } from '../types/brand';
import type { LocalTimeFacts } from '../types/time';

/**
 * The single source of "now". Every module that needs the time takes one of
 * these as a parameter, which is what lets seasonal conditions, crossfade
 * timing and history stamps be tested without waiting for the wall clock.
 */
export interface Clock {
  readonly now: () => number;
  readonly nowIso: () => IsoTimestamp;
  readonly localFacts: () => LocalTimeFacts;
}

/**
 * Splits an instant into the local calendar fields time conditions compare
 * against. Local rather than UTC: a directory scheduled for "weekday evenings"
 * means evenings where the machine is, not in Greenwich.
 */
export const toLocalTimeFacts = (date: Date): LocalTimeFacts => ({
  epochMs: date.getTime(),
  dayOfWeek: date.getDay(),
  hour: date.getHours(),
  minute: date.getMinutes(),
  dayOfMonth: date.getDate(),
  month: date.getMonth() + 1,
  year: date.getFullYear(),
});

export const toIsoTimestamp = (epochMs: number): IsoTimestamp =>
  asIsoTimestamp(new Date(epochMs).toISOString());

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => toIsoTimestamp(Date.now()),
  localFacts: () => toLocalTimeFacts(new Date()),
};

/**
 * A clock frozen at one instant. Its facts are derived once, so repeated reads
 * within a test cannot straddle a minute boundary the way the real clock can.
 */
export const createFixedClock = (epochMs: number): Clock => {
  const isoTimestamp = toIsoTimestamp(epochMs);
  const facts = toLocalTimeFacts(new Date(epochMs));

  return {
    now: () => epochMs,
    nowIso: () => isoTimestamp,
    localFacts: () => facts,
  };
};
