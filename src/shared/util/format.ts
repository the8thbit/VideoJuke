import type { IsoTimestamp } from '../types/brand';
import type { VideoMetadata } from '../types/video';
import { clampFraction, isFiniteNumber } from './numbers';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_SECOND = 1000;

/** Decimal, not binary: users compare these numbers with the ones on the box. */
const BYTES_PER_UNIT = 1000;
const LARGE_FILE_SIZE_UNITS: readonly string[] = ['KB', 'MB', 'GB', 'TB'];

/** Bullet separator between the parts of {@link formatVideoSummary}. */
const SUMMARY_SEPARATOR = ' • ';

/** `padStart` is ES2017 and the client compiles against the ES2015 lib. */
const padTwo = (value: number): string => (value < 10 ? `0${value}` : `${value}`);

/**
 * Guards the fields of a summary. Zero is treated as absent because a zero
 * width, frame rate or duration means ffprobe had nothing to report, not that
 * the video genuinely has one.
 */
const isPositive = (value: number | null): value is number => isFiniteNumber(value) && value > 0;

/**
 * Renders a media duration as `1:02:03`, dropping the hours segment when there
 * is none. Unusable input yields `Unknown` rather than a broken clock reading:
 * the original produced strings like `-1:-5` for a negative duration.
 */
export const formatDurationSeconds = (seconds: number | null): string => {
  if (!isFiniteNumber(seconds) || seconds < 0) return 'Unknown';

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainingSeconds = whole % SECONDS_PER_MINUTE;

  if (hours > 0) return `${hours}:${padTwo(minutes)}:${padTwo(remainingSeconds)}`;
  return `${minutes}:${padTwo(remainingSeconds)}`;
};

/**
 * Renders a coarse elapsed time as `1h 5m`, `5m 3s` or `12s`. Only the two
 * largest non-zero units appear, which is all the debug overlay has room for.
 */
export const formatElapsedMs = (milliseconds: number | null): string => {
  if (!isFiniteNumber(milliseconds) || milliseconds < 0) return 'N/A';

  const seconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);

  if (hours > 0) return `${hours}h ${minutes % MINUTES_PER_HOUR}m`;
  if (minutes > 0) return `${minutes}m ${seconds % SECONDS_PER_MINUTE}s`;
  return `${seconds}s`;
};

/** Formats an instant in the host's locale; `Never` stands in for a missing one. */
export const formatTimestamp = (timestamp: IsoTimestamp | null): string =>
  timestamp === null ? 'Never' : new Date(timestamp).toLocaleString();

/**
 * One-line description of a video for the info overlay, for example
 * `1920×1080 • 2:05 • 30fps • Audio: 6ch`. Absent fields are omitted, but the
 * audio part is always present so that a silent video is visibly silent rather
 * than merely unannotated.
 */
export const formatVideoSummary = (metadata: VideoMetadata | null): string => {
  if (metadata === null) return '';

  const { width, height, framesPerSecond } = metadata.video;
  const parts: string[] = [];

  if (isPositive(width) && isPositive(height)) parts.push(`${width}×${height}`);
  if (isPositive(metadata.duration)) parts.push(formatDurationSeconds(metadata.duration));
  if (isPositive(framesPerSecond)) parts.push(`${Math.round(framesPerSecond)}fps`);
  parts.push(metadata.audio === null ? 'No audio' : `Audio: ${metadata.audio.channels}ch`);

  return parts.join(SUMMARY_SEPARATOR);
};

/** Renders a 0..1 fraction as a whole-number percentage, e.g. `42%`. */
export const formatPercent = (fraction: number): string => {
  // NaN survives clamping, so it has to be rejected before it reaches the string.
  const safe = isFiniteNumber(fraction) ? fraction : 0;
  return `${Math.round(clampFraction(safe) * 100)}%`;
};

/** Renders a byte count in decimal units, e.g. `12.4 MB`. */
export const formatFileSize = (bytes: number | null): string => {
  if (!isFiniteNumber(bytes) || bytes < 0) return 'Unknown';

  let scaled = bytes;
  let unit = 'B';
  for (const largerUnit of LARGE_FILE_SIZE_UNITS) {
    if (scaled < BYTES_PER_UNIT) break;
    scaled = scaled / BYTES_PER_UNIT;
    unit = largerUnit;
  }

  // Fractions of a byte are noise; fractions of a kilobyte are the whole point.
  return unit === 'B' ? `${Math.round(scaled)} B` : `${scaled.toFixed(1)} ${unit}`;
};
