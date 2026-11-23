import { isPlainObject, type UnknownRecord } from '../util/objects';
import { DEFAULT_CONFIG } from './defaults';

/**
 * The older spellings `normalizeConfig` still accepts, by the canonical path
 * that replaced each one.
 *
 * Normalising prefers the canonical key, so a save that wrote the new spelling
 * would already win; the old key is removed as well so the file does not go on
 * saying two different things about one setting.
 */
const LEGACY_SIBLINGS: Readonly<Record<string, string>> = {
  'audio.surroundProcessingEnabled': 'enabled51Processing',
  'audio.outputChannels': 'forceOutputChannels',
  'audio.normalization.targetLufs': 'targetLUFS',
  'audio.normalization.loudnessRange': 'LRA',
  'audio.compatibility.forceAac': 'forceAAC',
};

/**
 * Fields no save may touch.
 *
 * The access token is the key to the API itself. The panel never shows it, so a
 * patch carrying one is either a mistake or someone holding today's token
 * trying to swap it for one the owner does not know.
 */
const PROTECTED_PATHS: readonly string[] = ['network.server.authToken'];

/**
 * Fields read once, when the process starts. A save still writes them, but
 * nothing running looks at them again until the next start.
 */
export const RESTART_REQUIRED_PATHS: readonly string[] = [
  'network',
  'system.tempDirectory',
  'system.cacheDirectory',
  'system.archiveDirectory',
  'system.logLevel',
  'system.enableFileWatcher',
  'ui.startFullscreen',
  'timeouts.streamUrlLifetime',
  'timeouts.connectionTimeout',
  'timeouts.browserOpenDelay',
];

/** True when `path` is `prefix` itself or sits somewhere inside it. */
export const isWithinPath = (path: string, prefix: string): boolean =>
  path === prefix ||
  path.startsWith(`${prefix}.`) ||
  path.startsWith(`${prefix}[`);

export const requiresRestart = (path: string): boolean =>
  RESTART_REQUIRED_PATHS.some((prefix) => isWithinPath(path, prefix));

export interface PatchOutcome {
  /** The raw config.json content with the patch laid over it. */
  readonly value: UnknownRecord;
  /** Every leaf the patch wrote, as dotted paths. */
  readonly touched: readonly string[];
  /** Fields the patch named that are not settings, or that may not be saved. */
  readonly ignored: readonly string[];
}

const joinPath = (parent: string, key: string): string =>
  parent === '' ? key : `${parent}.${key}`;

/**
 * Writes a directory with the neutral bias as the bare path it has always been,
 * so a save that only touched a timeout does not rewrite every library entry
 * into the longer form.
 */
const compactDirectories = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown) => {
    if (!isPlainObject(entry)) return entry;
    const keys = Object.keys(entry);
    const onlyDirectoryAndBias = keys.every((key) => key === 'directory' || key === 'bias');
    return onlyDirectoryAndBias && entry.bias === 1 && typeof entry.directory === 'string'
      ? entry.directory
      : entry;
  });
};

/**
 * Lays a settings patch over the raw contents of config.json.
 *
 * Pure, and deliberately raw-to-raw: the result is what gets written, so it
 * keeps everything the user put in the file - comments in `_comment` keys,
 * fields this version does not know, every override the patch did not mention.
 * Writing the normalised config instead would copy every default into the file,
 * which is the mistake `ConfigService` exists to avoid.
 *
 * The shape of `DEFAULT_CONFIG` decides what is a section and what is a value:
 * objects are walked into, and anything else - arrays included - is replaced
 * wholesale. Validation is left to `normalizeConfig`, which the caller runs on
 * the result, so an out-of-range number is reported exactly as it would be had
 * the user typed it into the file.
 */
export const applyConfigPatch = (raw: unknown, patch: unknown): PatchOutcome => {
  const touched: string[] = [];
  const ignored: string[] = [];

  const overlay = (target: unknown, changes: unknown, shape: unknown, path: string): UnknownRecord => {
    const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
    if (!isPlainObject(changes) || !isPlainObject(shape)) return result;

    for (const key of Object.keys(changes)) {
      const fieldPath = joinPath(path, key);
      const change = changes[key];
      if (change === undefined) continue;
      if (!(key in shape) || PROTECTED_PATHS.indexOf(fieldPath) !== -1) {
        ignored.push(fieldPath);
        continue;
      }

      const fieldShape = shape[key];
      if (isPlainObject(fieldShape)) {
        if (!isPlainObject(change)) {
          ignored.push(fieldPath);
          continue;
        }
        result[key] = overlay(result[key], change, fieldShape, fieldPath);
        continue;
      }

      result[key] = fieldPath === 'directories' ? compactDirectories(change) : change;
      touched.push(fieldPath);
      const legacy = LEGACY_SIBLINGS[fieldPath];
      if (legacy !== undefined) delete result[legacy];
    }
    return result;
  };

  const value = overlay(raw, patch, DEFAULT_CONFIG, '');
  return { value, touched, ignored };
};
