import { DEFAULT_CONFIG } from '../../shared/config/defaults';
import { normalizeConfig } from '../../shared/config/normalize';
import { createStore } from '../../shared/state/store';
import type { AppConfig, ConfigIssue } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';
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
  readonly watch: (onChange: (config: AppConfig) => void | Promise<void>) => () => void;
}

interface ConfigState {
  readonly config: AppConfig;
  readonly issues: readonly ConfigIssue[];
}

const NO_OP = (): void => {};

/**
 * Owns config.json: creating it on first run, reading it, and watching it.
 *
 * Merging and validation are not here; they belong to `normalizeConfig`, which
 * is pure and tested on its own. This module is the thin effectful shell around
 * that call, and it deliberately never writes the merged result back. The
 * previous implementation saved the fully merged config after every load, which
 * copied every default into the user's file and made a later change to a
 * default invisible to anyone who had already run the app once.
 */
export const createConfigService = async (deps: ConfigServiceDeps): Promise<ConfigService> => {
  const { fileSystem, paths, logger } = deps;
  const state = createStore<ConfigState>({ config: DEFAULT_CONFIG, issues: [] });

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

  const readRawConfig = async (): Promise<unknown> => {
    if (!(await fileSystem.exists(paths.configFile))) {
      await createConfigFile();
    }

    const read = await fileSystem.readJson(paths.configFile);
    if (read.ok) return read.value;

    // A broken user file must not stop the app: every field falls back to its
    // default, and the error above says exactly which file to fix.
    logger.error(`could not read ${paths.configFile}, continuing with defaults`, read.error);
    return undefined;
  };

  const loadConfig = async (): Promise<AppConfig> => {
    const { config, issues } = normalizeConfig(await readRawConfig());
    state.set({ config, issues });

    for (const issue of issues) {
      logIssue(issue);
    }

    logger.info(
      `configuration loaded: ${config.directories.length} directories, ` +
        `${config.seasonalDirectories.length} seasonal directories`,
    );
    return config;
  };

  const watch = (onChange: (config: AppConfig) => void | Promise<void>): (() => void) => {
    const { watchFile } = deps;
    if (watchFile === undefined) return NO_OP;
    if (!state.get().config.system.enableFileWatcher) {
      logger.debug('config file watching is disabled');
      return NO_OP;
    }

    const handleChange = async (): Promise<void> => {
      logger.info(`${paths.configFile} changed, reloading`);
      const config = await loadConfig();
      try {
        await onChange(config);
      } catch (thrown) {
        logger.error('a config change handler failed', thrown);
      }
    };

    logger.info(`watching ${paths.configFile} for changes`);
    return watchFile(paths.configFile, () => {
      void handleChange();
    });
  };

  await loadConfig();

  return {
    current: () => state.get().config,
    issues: () => state.get().issues,
    reload: loadConfig,
    watch,
  };
};
