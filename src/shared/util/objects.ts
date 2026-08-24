export type UnknownRecord = Readonly<Record<string, unknown>>;

/** True for object literals only: arrays, null and class instances are excluded. */
export const isPlainObject = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a property from an unknown value without narrowing it first. */
export const readProperty = (value: unknown, key: string): unknown =>
  isPlainObject(value) ? value[key] : undefined;

/** Walks a dotted path, returning undefined as soon as the trail goes cold. */
export const readPath = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => readProperty(current, key), value);

/**
 * Recursively overlays `overrides` onto `base`. Object values merge; arrays and
 * scalars replace wholesale, because a user listing three directories means
 * exactly those three, not those three appended to the defaults.
 */
export const deepMerge = (base: unknown, overrides: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides === undefined ? base : overrides;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const override = overrides[key];
    if (override === undefined) continue;
    merged[key] = key in base ? deepMerge(base[key], override) : override;
  }
  return merged;
};

/** Builds a record from entries, preserving key types. */
export const fromEntries = <TKey extends string, TValue>(
  entries: readonly (readonly [TKey, TValue])[],
): Record<TKey, TValue> => {
  const result = {} as Record<TKey, TValue>;
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
};

/** Maps every value of a record, leaving the keys untouched. */
export const mapValues = <TKey extends string, TIn, TOut>(
  record: Readonly<Record<TKey, TIn>>,
  transform: (value: TIn, key: TKey) => TOut,
): Record<TKey, TOut> =>
  fromEntries(
    (Object.keys(record) as TKey[]).map((key) => [key, transform(record[key], key)] as const),
  );

/**
 * Produces a stable JSON encoding: object keys are emitted in sorted order so
 * that two structurally equal values always hash identically.
 */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
};
