import { isFiniteNumber } from './numbers';
import { isPlainObject, readProperty, type UnknownRecord } from './objects';

export type DecodeSeverity = 'warning' | 'error';

/** A single problem found while reading untrusted JSON. */
export interface DecodeIssue {
  readonly severity: DecodeSeverity;
  /** Dotted path of the offending field, e.g. video.preprocessedQueueSize. */
  readonly path: string;
  readonly message: string;
}

/**
 * Threads the current field path and an issue sink through a decode.
 *
 * The sink is the one deliberately effectful part of this module: decoding a
 * deeply nested config while returning `{ value, issues }` at every level makes
 * the call sites unreadable, so issues are appended to a collector that the
 * caller owns and reads once at the end.
 */
export interface DecodeContext {
  readonly path: string;
  readonly report: (severity: DecodeSeverity, message: string) => void;
  /** Derives a context for a child field. */
  readonly at: (segment: string | number) => DecodeContext;
}

export interface IssueCollector {
  readonly context: DecodeContext;
  readonly issues: () => readonly DecodeIssue[];
}

const joinPath = (parent: string, segment: string | number): string => {
  if (typeof segment === 'number') return `${parent}[${segment}]`;
  return parent === '' ? segment : `${parent}.${segment}`;
};

export const createIssueCollector = (): IssueCollector => {
  const issues: DecodeIssue[] = [];

  const contextAt = (path: string): DecodeContext => ({
    path,
    report: (severity, message) => issues.push({ severity, path, message }),
    at: (segment) => contextAt(joinPath(path, segment)),
  });

  return { context: contextAt(''), issues: () => issues };
};

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

const describe = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value);

export const readBoolean = (context: DecodeContext, value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  context.report('warning', `expected a boolean, got ${describe(value)}; using ${fallback}`);
  return fallback;
};

export const readNumber = (
  context: DecodeContext,
  value: unknown,
  fallback: number,
  options: NumberOptions = {},
): number => {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value)) {
    context.report('warning', `expected a number, got ${describe(value)}; using ${fallback}`);
    return fallback;
  }

  const rounded = options.integer === true ? Math.round(value) : value;
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (rounded < min || rounded > max) {
    const clamped = Math.min(Math.max(rounded, min), max);
    context.report('warning', `${rounded} is outside ${min}..${max}; using ${clamped}`);
    return clamped;
  }
  return rounded;
};

export const readString = (context: DecodeContext, value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '') return value;
  context.report('warning', `expected a non-empty string, got ${describe(value)}`);
  return fallback;
};

/**
 * Reads a secret, without ever putting it in a message.
 *
 * Two things make `readString` wrong for this. It rejects `''`, but an empty
 * secret is the legitimate way to say "not chosen yet", so a fresh install would
 * be warned about a field it is supposed to leave blank. And on a bad value it
 * calls `describe`, which `JSON.stringify`s that value straight into the issue
 * text - which is logged, and every log entry is broadcast to every connected
 * client. A user who quoted their token oddly would have it read out to the
 * whole house.
 */
export const readSecret = (context: DecodeContext, value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value.trim();
  context.report('warning', 'expected a string; treating the access token as unset');
  return fallback;
};

export const readNullableString = (
  context: DecodeContext,
  value: unknown,
  fallback: string | null,
): string | null => {
  if (value === undefined || value === null) return value === null ? null : fallback;
  if (typeof value === 'string') return value;
  context.report('warning', `expected a string or null, got ${describe(value)}`);
  return fallback;
};

export const readEnum = <TValue extends string>(
  context: DecodeContext,
  value: unknown,
  allowed: readonly TValue[],
  fallback: TValue,
): TValue => {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).indexOf(value) !== -1) {
    return value as TValue;
  }
  context.report(
    'warning',
    `expected one of ${allowed.join(', ')}, got ${describe(value)}; using ${fallback}`,
  );
  return fallback;
};

/** Reads a nested object, reporting when the field holds something else. */
export const readSection = (context: DecodeContext, value: unknown): UnknownRecord => {
  if (value === undefined) return {};
  if (isPlainObject(value)) return value;
  context.report('warning', `expected an object, got ${describe(value)}; ignoring it`);
  return {};
};

/**
 * Reads an array, dropping items that `readItem` rejects by returning null.
 * A non-array value falls back rather than throwing away the whole config.
 */
export const readArray = <TValue>(
  context: DecodeContext,
  value: unknown,
  readItem: (itemContext: DecodeContext, item: unknown) => TValue | null,
  fallback: readonly TValue[],
): readonly TValue[] => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    context.report('warning', `expected an array, got ${describe(value)}`);
    return fallback;
  }

  const items: TValue[] = [];
  value.forEach((item, index) => {
    const decoded = readItem(context.at(index), item);
    if (decoded !== null) items.push(decoded);
  });
  return items;
};

export const readStringArray = (
  context: DecodeContext,
  value: unknown,
  fallback: readonly string[],
): readonly string[] =>
  readArray(
    context,
    value,
    (itemContext, item) => {
      if (typeof item === 'string' && item.trim() !== '') return item;
      itemContext.report('warning', `ignoring non-string entry ${describe(item)}`);
      return null;
    },
    fallback,
  );

export const readNumberArray = (
  context: DecodeContext,
  value: unknown,
  fallback: readonly number[],
  options: NumberOptions = {},
): readonly number[] =>
  readArray(
    context,
    value,
    (itemContext, item) => {
      if (!isFiniteNumber(item)) {
        itemContext.report('warning', `ignoring non-numeric entry ${describe(item)}`);
        return null;
      }
      const min = options.min ?? Number.NEGATIVE_INFINITY;
      const max = options.max ?? Number.POSITIVE_INFINITY;
      if (item < min || item > max) {
        itemContext.report('warning', `ignoring ${item}, outside ${min}..${max}`);
        return null;
      }
      return item;
    },
    fallback,
  );

/**
 * Accepts either a single value or a list of them and always yields a list.
 * Returns null when the field is absent, which callers read as "no constraint".
 *
 * A field that is present but whose every entry was rejected yields an empty
 * list, not null. The two are not the same thing: an absent field imposes no
 * constraint, while `month: 13` is a constraint nothing can satisfy. Collapsing
 * the second onto the first - as this used to - meant a mistyped gate opened
 * instead of closing, and the seasonal directory behind it played all year.
 * Every rejected entry has already been reported by `readNumberArray`.
 */
export const readScalarOrArray = (
  context: DecodeContext,
  value: unknown,
  options: NumberOptions = {},
): readonly number[] | null => {
  if (value === undefined || value === null) return null;
  return readNumberArray(context, isFiniteNumber(value) ? [value] : value, [], options);
};

export const readField = (value: unknown, key: string): unknown => readProperty(value, key);
