import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { fromRoot, pathExists } from './run.mjs';

/**
 * Everything a build reads. A change to any of it makes `dist` out of date.
 *
 * `package.json` and the tsconfigs are in here because they decide what the
 * build produces, and `config.default.json` because the build copies it. Files
 * are listed rather than globbed so that adding an input is a deliberate act,
 * not something that quietly starts mattering.
 */
export const BUILD_INPUTS = [
  'src',
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.server.json',
  'tsconfig.client.json',
  'config.default.json',
];

/** What a successful build leaves behind, and where its freshness is read from. */
export const BUILD_OUTPUT = 'dist';

/**
 * One artefact from each stage of `build.mjs`, so a half-finished build cannot
 * be mistaken for a complete one.
 *
 * The server entry point alone used to answer this, and it is written by the
 * *first* of four stages. `npm run typecheck` emits it on its own - tsconfig.
 * server.json has an `outDir` and no `noEmit` - and so does a build interrupted
 * during "Bundling clients". Either leaves a dist with no renderer in it whose
 * mtimes beat every source file, so `launch` skipped the build and started an
 * Electron app whose window has nothing to load. `createPlayerWindow` only shows
 * itself from `ready-to-show`, which never fires, so what the user gets is an
 * invisible process rather than an error.
 *
 * The static copies are the last thing `build.mjs` writes, which makes them the
 * honest completion marker; the rest are here so a stage that failed on its own
 * is still caught.
 */
const REQUIRED_OUTPUTS = [
  join('dist', 'server', 'electron', 'main.js'),
  join('dist', 'server', 'web', 'main.js'),
  join('dist', 'client', 'electron', 'client.js'),
  join('dist', 'client', 'electron', 'preload.js'),
  join('dist', 'client', 'web', 'client.js'),
  join('dist', 'client', 'electron', 'index.html'),
  join('dist', 'client', 'web', 'index.html'),
];

/**
 * The most recent modification time anywhere under `path`.
 *
 * Directory mtimes are deliberately ignored: on Windows they move when
 * unrelated things happen inside them, which would report a rebuild as needed
 * on every run. Only files count.
 */
const newestFileTime = async (path) => {
  const entry = await stat(path).catch(() => null);
  if (entry === null) return 0;
  if (entry.isFile()) return entry.mtimeMs;
  if (!entry.isDirectory()) return 0;

  const names = await readdir(path).catch(() => []);
  let newest = 0;
  for (const name of names) {
    const found = await newestFileTime(join(path, name));
    if (found > newest) newest = found;
  }
  return newest;
};

/**
 * Whether the build needs running, and why.
 *
 * Compares the newest source file against the newest built file. That is a
 * coarse test - it cannot tell a comment from a rewrite - but it is the right
 * kind of coarse: it never claims a stale build is fresh, and being wrong the
 * other way costs a rebuild the user was about to trigger by hand anyway.
 */
export const inspectBuild = async () => {
  if (!(await pathExists(fromRoot('node_modules')))) {
    return { stale: true, reason: 'dependencies are not installed' };
  }
  if (!(await pathExists(fromRoot(BUILD_OUTPUT)))) {
    return { stale: true, reason: 'there is no build yet' };
  }
  for (const output of REQUIRED_OUTPUTS) {
    if (!(await pathExists(fromRoot(output)))) {
      return { stale: true, reason: `the last build did not finish: ${output} is missing` };
    }
  }

  const builtAt = await newestFileTime(fromRoot(BUILD_OUTPUT));
  if (builtAt === 0) return { stale: true, reason: 'the build is empty' };

  for (const input of BUILD_INPUTS) {
    const changedAt = await newestFileTime(fromRoot(input));
    if (changedAt > builtAt) {
      return { stale: true, reason: `${input} changed since the last build` };
    }
  }

  return { stale: false, reason: 'the build is up to date' };
};
