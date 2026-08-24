export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

/** Clamps into 0..1, the range every progress value in the app uses. */
export const clampFraction = (value: number): number => clamp(value, 0, 1);

/** Safe division that yields 0 rather than NaN or Infinity for a zero divisor. */
export const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export const roundTo = (value: number, decimals: number): number => {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

/** Linear interpolation between `from` and `to` at progress `t` in 0..1. */
export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/**
 * Quadratic ease-in-out. Used for every fade in the player so that blur,
 * opacity and volume all move on the same curve.
 */
export const easeInOut = (t: number): number => {
  const progress = clampFraction(t);
  return progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
};

/** Parses a value that may arrive as a number or a numeric string. */
export const parseNumber = (value: unknown): number | null => {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Evaluates an ffprobe frame-rate expression such as `30000/1001`.
 * The original code passed these to `eval`, which is both slower and a
 * remote-code-execution hazard on untrusted media.
 */
export const parseRationalNumber = (value: unknown): number | null => {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const fraction = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }
    return numerator / denominator;
  }

  return parseNumber(trimmed);
};
