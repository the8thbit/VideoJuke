/** A source of randomness, injected so that selection logic stays testable. */
export type RandomSource = () => number;

/** Picks one element uniformly at random, or null when there is nothing to pick. */
export const pickRandom = <T>(values: readonly T[], random: RandomSource): T | null => {
  if (values.length === 0) return null;
  const index = Math.floor(random() * values.length);
  return values[Math.min(index, values.length - 1)] ?? null;
};

/** Removes the element at `index`, returning it alongside the remaining values. */
export const removeAt = <T>(
  values: readonly T[],
  index: number,
): { readonly removed: T | null; readonly rest: readonly T[] } => {
  const removed = values[index];
  if (removed === undefined) return { removed: null, rest: values };
  return { removed, rest: [...values.slice(0, index), ...values.slice(index + 1)] };
};

/** Takes one element at random and returns it with the remaining values. */
export const takeRandom = <T>(
  values: readonly T[],
  random: RandomSource,
): { readonly removed: T | null; readonly rest: readonly T[] } => {
  if (values.length === 0) return { removed: null, rest: values };
  return removeAt(values, Math.floor(random() * values.length));
};

/** Keeps the first `count` elements; a non-positive count yields an empty list. */
export const takeFirst = <T>(values: readonly T[], count: number): readonly T[] =>
  count <= 0 ? [] : values.slice(0, count);

/** Prepends a value and trims the result to `maxLength`. */
export const prependBounded = <T>(
  values: readonly T[],
  value: T,
  maxLength: number,
): readonly T[] => takeFirst([value, ...values], maxLength);

/** Removes every element matching `predicate`. */
export const removeWhere = <T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): readonly T[] => values.filter((value) => !predicate(value));

/** De-duplicates while preserving order, using `keyOf` for identity. */
export const uniqueBy = <T>(values: readonly T[], keyOf: (value: T) => string): readonly T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Sums the results of `valueOf` across the collection. */
export const sumBy = <T>(values: readonly T[], valueOf: (value: T) => number): number =>
  values.reduce((total, value) => total + valueOf(value), 0);
