/**
 * The handful of standard methods missing from the Chromium on older webOS TVs.
 *
 * The client is compiled to ES5, so the syntax is safe everywhere; what a 2015
 * TV does not have is the ES2015 *library*. Rather than forbid these methods
 * across `shared/` and `client/core/` (`videoLocation.ts` reaches for
 * `String.prototype.startsWith`, and `Array.prototype.indexOf` is not always
 * the clearer spelling), the entry point installs the few that are missing.
 *
 * Each one is installed only when it is absent, so a modern engine keeps its
 * own native implementation. These are the only `function` expressions in the
 * client: a prototype method needs a dynamic `this`, which an arrow cannot give
 * it.
 */

/**
 * Installs a method only when the target does not already have one.
 *
 * `defineProperty` rather than assignment so the method is non-enumerable: a
 * `for..in` over an array must not suddenly yield "includes".
 */
const defineMissing = (target: object, name: string, implementation: unknown): void => {
  const holder = target as Record<string, unknown>;
  if (typeof holder[name] === 'function') return;
  Object.defineProperty(target, name, {
    value: implementation,
    writable: true,
    configurable: true,
    enumerable: false,
  });
};

type ArrayPredicate = (value: unknown, index: number, array: readonly unknown[]) => boolean;

const ownKeys = (value: unknown): string[] => {
  const source = Object(value) as Record<string, unknown>;
  const names: string[] = [];
  for (const name in source) {
    if (Object.prototype.hasOwnProperty.call(source, name)) names.push(name);
  }
  return names;
};

const assignPolyfill = (target: unknown, ...sources: readonly unknown[]): unknown => {
  if (target === null || target === undefined) {
    throw new TypeError('Object.assign: the target must not be null or undefined');
  }

  const output = Object(target) as Record<string, unknown>;
  sources.forEach((source) => {
    if (source === null || source === undefined) return;
    const from = Object(source) as Record<string, unknown>;
    ownKeys(from).forEach((key) => {
      output[key] = from[key];
    });
  });
  return output;
};

/**
 * Array-likes only. Nothing in this client passes `Array.from` an iterable that
 * is not already an array, and a faithful iterator protocol implementation on
 * an engine old enough to lack `Array.from` would be pretending.
 */
const arrayFromPolyfill = (
  source: unknown,
  transform?: (value: unknown, index: number) => unknown,
  thisArg?: unknown,
): unknown[] => {
  if (source === null || source === undefined) {
    throw new TypeError('Array.from: the source must not be null or undefined');
  }

  const items = Object(source) as Record<string, unknown> & { length?: unknown };
  const length = Math.floor(Number(items.length));
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const value = items[index];
    result.push(transform === undefined ? value : transform.call(thisArg, value, index));
  }
  return result;
};

const findIndexPolyfill = function (
  this: readonly unknown[],
  predicate: ArrayPredicate,
  thisArg?: unknown,
): number {
  if (typeof predicate !== 'function') {
    throw new TypeError('Array.prototype.findIndex: the predicate must be a function');
  }
  for (let index = 0; index < this.length; index += 1) {
    if (predicate.call(thisArg, this[index], index, this)) return index;
  }
  return -1;
};

const findPolyfill = function (
  this: readonly unknown[],
  predicate: ArrayPredicate,
  thisArg?: unknown,
): unknown {
  const index = findIndexPolyfill.call(this, predicate, thisArg);
  return index === -1 ? undefined : this[index];
};

const arrayIncludesPolyfill = function (
  this: readonly unknown[],
  search: unknown,
  fromIndex?: number,
): boolean {
  const length = this.length;
  const offset = fromIndex === undefined ? 0 : fromIndex;
  let index = offset < 0 ? Math.max(length + offset, 0) : offset;

  for (; index < length; index += 1) {
    const value = this[index];
    // The NaN case is the whole reason `includes` exists next to `indexOf`.
    if (value === search || (value !== value && search !== search)) return true;
  }
  return false;
};

const startsWithPolyfill = function (this: string, search: string, position?: number): boolean {
  const offset = position === undefined ? 0 : position;
  return String(this).indexOf(search, offset) === offset;
};

const endsWithPolyfill = function (this: string, search: string, position?: number): boolean {
  const text = String(this);
  const end = position === undefined || position > text.length ? text.length : position;
  const start = end - search.length;
  return start >= 0 && text.indexOf(search, start) === start;
};

const stringIncludesPolyfill = function (this: string, search: string, position?: number): boolean {
  return String(this).indexOf(search, position === undefined ? 0 : position) !== -1;
};

/**
 * Called as the very first statement of the webOS entry point. Module bodies
 * are evaluated before it runs, so nothing at module scope anywhere in the
 * bundle may use one of these methods; today nothing does.
 */
export const installPolyfills = (): void => {
  defineMissing(Object, 'keys', ownKeys);
  defineMissing(Object, 'assign', assignPolyfill);
  defineMissing(Array, 'from', arrayFromPolyfill);
  defineMissing(Array.prototype, 'find', findPolyfill);
  defineMissing(Array.prototype, 'findIndex', findIndexPolyfill);
  defineMissing(Array.prototype, 'includes', arrayIncludesPolyfill);
  defineMissing(String.prototype, 'startsWith', startsWithPolyfill);
  defineMissing(String.prototype, 'endsWith', endsWithPolyfill);
  defineMissing(String.prototype, 'includes', stringIncludesPolyfill);
};
