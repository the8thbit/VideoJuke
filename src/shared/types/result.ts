/**
 * A total alternative to throwing: every fallible operation in the codebase
 * returns a `Result`, so callers cannot forget that failure is possible.
 */
export interface Ok<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface Err<TError> {
  readonly ok: false;
  readonly error: TError;
}

export type Result<TValue, TError = Error> = Ok<TValue> | Err<TError>;

export const ok = <TValue>(value: TValue): Ok<TValue> => ({ ok: true, value });

export const err = <TError>(error: TError): Err<TError> => ({ ok: false, error });

export const isOk = <TValue, TError>(result: Result<TValue, TError>): result is Ok<TValue> =>
  result.ok;

export const mapResult = <TIn, TOut, TError>(
  result: Result<TIn, TError>,
  transform: (value: TIn) => TOut,
): Result<TOut, TError> => (result.ok ? ok(transform(result.value)) : result);

/** Keeps only the successful values, discarding failures. */
export const okValues = <TValue, TError>(
  results: readonly Result<TValue, TError>[],
): readonly TValue[] => results.filter(isOk).map((result) => result.value);

/** Short-circuits on the first failure, otherwise collects every value. */
export const allOk = <TValue, TError>(
  results: readonly Result<TValue, TError>[],
): Result<readonly TValue[], TError> => {
  const values: TValue[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
};

/** Normalises an unknown thrown value into an `Error`. */
export const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

/** Runs a throwing function and captures the failure as an `Err`. */
export const attempt = <TValue>(operation: () => TValue): Result<TValue, Error> => {
  try {
    return ok(operation());
  } catch (thrown) {
    return err(toError(thrown));
  }
};

/** Awaits a promise and captures a rejection as an `Err`. */
export const attemptAsync = async <TValue>(
  operation: () => Promise<TValue>,
): Promise<Result<TValue, Error>> => {
  try {
    return ok(await operation());
  } catch (thrown) {
    return err(toError(thrown));
  }
};
