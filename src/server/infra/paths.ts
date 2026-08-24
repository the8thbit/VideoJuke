import { isAbsolute, join, resolve } from 'path';

import type { SystemConfig } from '../../shared/types/config';

/** Every filesystem location the application reads or writes. */
export interface AppPaths {
  /** Where user data lives: the config file, the cache and the temp directory. */
  readonly workingDirectory: string;
  /** Where the application itself is installed, holding the shipped defaults. */
  readonly installDirectory: string;
  readonly configFile: string;
  readonly defaultConfigFile: string;
  readonly cacheDirectory: string;
  readonly tempDirectory: string;
  /** Where archived videos are moved to; never scanned. */
  readonly archiveDirectory: string;
  readonly videoIndexFile: string;
  readonly queueStateFile: string;
  readonly historyFile: string;
  /**
   * The archive list, beside config.json rather than in the cache.
   *
   * It records what the viewer asked for, not something this application can
   * recompute, so it must outlive a cache that is safe to delete - and it is
   * meant to be read, and edited, before `npm run archive` acts on it.
   */
  readonly archiveFlagsFile: string;
}

export type DirectoryOverrides = Pick<
  SystemConfig,
  'cacheDirectory' | 'tempDirectory' | 'archiveDirectory'
>;

export interface AppPathsOptions {
  /** Normally process.cwd(), so a user can keep several libraries side by side. */
  readonly workingDirectory: string;
  /** Derived from the compiled bundle's location; read-only once packaged. */
  readonly installDirectory: string;
  readonly directories?: DirectoryOverrides;
}

const DEFAULT_OVERRIDES: DirectoryOverrides = {
  cacheDirectory: './cache',
  tempDirectory: './temp',
  archiveDirectory: './archive',
};

const resolveAgainst = (root: string, path: string): string =>
  isAbsolute(path) ? path : resolve(root, path);

/**
 * Resolves the layout in one place so no module has to guess where the cache
 * lives.
 *
 * User data is anchored to the working directory, which is what lets the same
 * installation serve different video libraries from different directories, and
 * is where the original code put it. The shipped `config.default.json` is
 * anchored to the install directory instead, because once the app is packaged
 * that tree is read-only and may be nowhere near the working directory.
 */
export const resolveAppPaths = ({
  workingDirectory,
  installDirectory,
  directories = DEFAULT_OVERRIDES,
}: AppPathsOptions): AppPaths => {
  const cacheDirectory = resolveAgainst(workingDirectory, directories.cacheDirectory);
  const tempDirectory = resolveAgainst(workingDirectory, directories.tempDirectory);
  const archiveDirectory = resolveAgainst(workingDirectory, directories.archiveDirectory);

  return {
    workingDirectory,
    installDirectory,
    configFile: join(workingDirectory, 'config.json'),
    defaultConfigFile: join(installDirectory, 'config.default.json'),
    cacheDirectory,
    tempDirectory,
    archiveDirectory,
    videoIndexFile: join(cacheDirectory, 'video-index.json'),
    queueStateFile: join(cacheDirectory, 'queue-state.json'),
    historyFile: join(cacheDirectory, 'persisted-history.json'),
    archiveFlagsFile: join(workingDirectory, 'flagged_for_archive.json'),
  };
};
