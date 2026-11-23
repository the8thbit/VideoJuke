import { classifyConfigChange } from '../../shared/config/changeImpact';
import { DEFAULT_CONFIG } from '../../shared/config/defaults';
import { normalizeConfig } from '../../shared/config/normalize';
import { applyConfigPatch, isWithinPath, requiresRestart } from '../../shared/config/patch';
import { createSerialTask, createStore } from '../../shared/state/store';
import type { AppConfig, ConfigIssue } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
import { attempt } from '../../shared/types/result';
import type { ConfigPatch, ConfigSaveResult, EditableConfig } from '../../shared/types/settings';
import { isPlainObject, readProperty } from '../../shared/util/objects';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';

export interface ConfigServiceDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly logger: Logger;
  /**
   * Registers a change listener on a path and returns its unsubscribe. The
   * concrete node watcher comes from the composition root, so tests and any
   * host that does not want a watcher simply leave this out.
   */
  readonly watchFile?: (path: string, onChange: () => void) => () => void;
}

export interface ConfigService {
  readonly current: () => AppConfig;
  readonly issues: () => readonly ConfigIssue[];
  readonly reload: () => Promise<AppConfig>;
  /**
   * Hears every change to the settings: a save from the options panel, and an
   * edit to config.json by hand while the file watcher is on.
   */
  readonly watch: (onChange: (config: AppConfig) => void | Promise<void>) => () => void;
  /** Bumped by every change, so clients can tell their copy is stale. */
  readonly revision: () => number;
  readonly editable: () => Promise<EditableConfig>;
  /** Writes a patch into config.json and applies it, or refuses it whole. */
  readonly save: (patch: ConfigPatch) => Promise<ConfigSaveResult>;
}

interface ConfigState {
  readonly config: AppConfig;
  readonly issues: readonly ConfigIssue[];
  readonly revision: number;
  /**
   * The text the current config was read from or written as. A watcher event
   * whose file still holds exactly this text is the echo of our own save - or
   * an editor touching the file without changing it - and is not a change.
   */
  readonly text: string | null;
}

type Listener = (config: AppConfig) => void | Promise<void>;

/** A raw file that could not be read: missing, unreadable or not JSON. */
interface RawRead {
  readonly text: string | null;
  readonly value: unknown;
  readonly error: Error | null;
}

/** Two-space JSON with a final newline, which is how config.default.json is laid out. */
const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A leading byte-order mark, which Notepad writes and `JSON.parse` rejects. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const withoutSecret = (config: AppConfig): AppConfig => ({
  ...config,
  network: {
    ...config.network,
    server: { ...config.network.server, authToken: '' },
  },
});

/**
 * Owns config.json: creating it on first run, reading it, watching it, and
 * writing the changes made in the options panel.
 *
 * Merging and validation are not here; they belong to `normalizeConfig`, which
 * is pure and tested on its own. This module is the thin effectful shell around
 * that call, and it deliberately never writes the merged result back. The
 * previous implementation saved the fully merged config after every load, which
 * copied every default into the user's file and made a later change to a
 * default invisible to anyone who had already run the app once. A save from the
 * panel keeps to the same rule: it lays only the changed fields over the file
 * as it stands.
 */
export const createConfigService = async (deps: ConfigServiceDeps): Promise<ConfigService> => {
  const { fileSystem, paths, logger } = deps;
  const state = createStore<ConfigState>({
    config: DEFAULT_CONFIG,
    issues: [],
    revision: 0,
    text: null,
  });
  const listeners = createStore<readonly Listener[]>([]);
  const stopWatching = createStore<(() => void) | null>(null);
  /** Saves and watcher reloads, one at a time, so neither reads a half-written file. */
  const writing = createSerialTask();

  const logIssue = (issue: ConfigIssue): void => {
    const line = `${issue.path}: ${issue.message}`;
    if (issue.severity === 'error') {
      logger.error(line);
      return;
    }
    logger.warn(line);
  };

  /**
   * Copies config.default.json verbatim so the user's first edit happens in the
   * documented file they were meant to get; serialising DEFAULT_CONFIG is the
   * fallback for an install where that file is missing.
   */
  const createConfigFile = async (): Promise<void> => {
    const template = await fileSystem.readText(paths.defaultConfigFile);
    if (!template.ok) {
      logger.warn(`${paths.defaultConfigFile} is unreadable, writing built-in defaults instead`);
    }

    const written = template.ok
      ? await fileSystem.writeText(paths.configFile, template.value)
      : await fileSystem.writeJson(paths.configFile, DEFAULT_CONFIG);

    if (!written.ok) {
      logger.error(`could not create ${paths.configFile}`, written.error);
      return;
    }
    logger.info(`created ${paths.configFile}`);
  };

  const readRaw = async (): Promise<RawRead> => {
    if (!(await fileSystem.exists(paths.configFile))) {
      await createConfigFile();
    }

    const read = await fileSystem.readText(paths.configFile);
    if (!read.ok) return { text: null, value: undefined, error: read.error };
    const parsed = attempt(() => JSON.parse(stripBom(read.value)) as unknown);
    if (!parsed.ok) {
      return {
        text: read.value,
        value: undefined,
        error: new Error(`${paths.configFile} is not valid JSON: ${parsed.error.message}`),
      };
    }
    return { text: read.value, value: parsed.value, error: null };
  };

  /** Normalises and installs a raw value; returns whether anything changed. */
  const install = (raw: unknown, text: string | null): AppConfig => {
    const { config, issues } = normalizeConfig(raw);
    state.update((previous) => ({
      config,
      issues,
      text,
      revision: previous.revision + 1,
    }));
    for (const issue of issues) {
      logIssue(issue);
    }
    return config;
  };

  const loadConfig = async (): Promise<AppConfig> => {
    const raw = await readRaw();
    if (raw.error !== null) {
      // A broken user file must not stop the app: every field falls back to its
      // default, and the error says exactly which file to fix.
      logger.error(`could not read ${paths.configFile}, continuing with defaults`, raw.error);
    }
    const config = install(raw.value, raw.text);
    logger.info(
      `configuration loaded: ${config.directories.length} directories, ` +
        `${config.seasonalDirectories.length} seasonal directories`,
    );
    return config;
  };

  const notify = async (config: AppConfig): Promise<void> => {
    for (const listener of listeners.get()) {
      try {
        await listener(config);
      } catch (thrown) {
        logger.error('a config change handler failed', thrown);
      }
    }
  };

  const handleFileChange = (): Promise<void> =>
    writing.run(async () => {
      const read = await fileSystem.readText(paths.configFile);
      if (read.ok && read.value === state.get().text) {
        logger.debug(`${paths.configFile} changed on disk but its contents did not`);
        return;
      }
      logger.info(`${paths.configFile} changed, reloading`);
      await notify(await loadConfig());
    });

  const startWatching = (): void => {
    const { watchFile } = deps;
    if (watchFile === undefined || stopWatching.get() !== null) return;
    if (!state.get().config.system.enableFileWatcher) {
      logger.debug('config file watching is disabled');
      return;
    }

    logger.info(`watching ${paths.configFile} for changes`);
    stopWatching.set(
      watchFile(paths.configFile, () => {
        void handleFileChange();
      }),
    );
  };

  const watch = (onChange: Listener): (() => void) => {
    listeners.update((previous) => [...previous, onChange]);
    startWatching();
    return () => {
      listeners.update((previous) => previous.filter((listener) => listener !== onChange));
      if (listeners.get().length > 0) return;
      stopWatching.get()?.();
      stopWatching.set(null);
    };
  };

  const editable = async (): Promise<EditableConfig> => {
    const raw = await readRaw();
    const current = state.get();
    const seasonal = readProperty(raw.value, 'seasonalDirectories');
    return {
      config: withoutSecret(current.config),
      seasonalDirectories: seasonal === undefined ? [] : seasonal,
      issues: current.issues,
      configFile: paths.configFile,
      revision: current.revision,
    };
  };

  const save = (patch: ConfigPatch): Promise<ConfigSaveResult> =>
    writing.run(async (): Promise<ConfigSaveResult> => {
      const raw = await readRaw();
      // Writing over a file that does not parse would throw away whatever the
      // user was in the middle of typing into it. They can fix it, or delete
      // it and let it be recreated, but not have it silently replaced.
      if (raw.error !== null || (raw.value !== undefined && !isPlainObject(raw.value))) {
        return {
          ok: false,
          message: `${paths.configFile} could not be read, so it was not changed: ${
            raw.error?.message ?? 'it is not a JSON object'
          }`,
          issues: [],
        };
      }

      const patched = applyConfigPatch(raw.value, patch);
      for (const path of patched.ignored) {
        logger.warn(`ignoring the setting ${path} in a save: it is not a setting that can be saved`);
      }
      if (patched.touched.length === 0) {
        const current = state.get();
        return {
          ok: true,
          revision: current.revision,
          impact: 'none',
          restartRequired: [],
          issues: current.issues,
        };
      }

      // A warning on a field the save wrote means the value was not taken as
      // given - clamped, or replaced by its default - and saving it anyway would
      // leave the panel showing something other than what the user typed.
      const checked = normalizeConfig(patched.value);
      const rejected = checked.issues.filter(
        (issue) =>
          issue.severity === 'warning' &&
          patched.touched.some((path) => isWithinPath(issue.path, path)),
      );
      if (rejected.length > 0) {
        return { ok: false, message: 'Some values are not valid', issues: rejected };
      }

      const text = serialise(patched.value);
      const written = await fileSystem.writeText(paths.configFile, text);
      if (!written.ok) {
        logger.error(`could not write ${paths.configFile}`, written.error);
        return {
          ok: false,
          message: `Could not write ${paths.configFile}: ${written.error.message}`,
          issues: [],
        };
      }

      const previous = state.get().config;
      const config = install(patched.value, text);
      logger.info(`saved ${patched.touched.join(', ')} to ${paths.configFile}`);
      await notify(config);

      const current = state.get();
      return {
        ok: true,
        revision: current.revision,
        impact: classifyConfigChange(previous, config),
        restartRequired: patched.touched.filter(requiresRestart),
        issues: current.issues,
      };
    });

  await loadConfig();

  return {
    current: () => state.get().config,
    issues: () => state.get().issues,
    reload: loadConfig,
    watch,
    revision: () => state.get().revision,
    editable,
    save,
  };
};
