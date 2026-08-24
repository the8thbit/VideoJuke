/**
 * Nominal typing helper. Two aliases of `string` are interchangeable to the
 * compiler; two `Brand`ed aliases are not, which lets the type system keep
 * distinct-but-similar values (source paths vs. transcoded paths) apart.
 */
declare const brandTag: unique symbol;

export type Brand<TValue, TBrand extends string> = TValue & {
  readonly [brandTag]: TBrand;
};

/** Absolute path of a video file inside a user-configured source directory. */
export type SourceVideoPath = Brand<string, 'SourceVideoPath'>;

/** Absolute path of a transcoded video file inside the temp directory. */
export type ProcessedVideoPath = Brand<string, 'ProcessedVideoPath'>;

/** Opaque identifier of a single transcode result. */
export type VideoId = Brand<string, 'VideoId'>;

/** An ISO-8601 timestamp, e.g. `2026-08-21T14:03:59.123Z`. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

export const asSourceVideoPath = (value: string): SourceVideoPath => value as SourceVideoPath;

export const asProcessedVideoPath = (value: string): ProcessedVideoPath =>
  value as ProcessedVideoPath;

export const asVideoId = (value: string): VideoId => value as VideoId;

export const asIsoTimestamp = (value: string): IsoTimestamp => value as IsoTimestamp;
