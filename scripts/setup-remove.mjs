/**
 * `npm run setup:remove`: takes the Start Menu entry away again.
 *
 * The counterpart to `npm run setup`. It removes only the shortcut - the build,
 * the cache and the configuration are the user's and stay where they are.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { logStep, main, pathExists } from './lib/run.mjs';
import { startMenuDirectory } from './lib/shortcut.mjs';

const SHORTCUT_NAME = 'VideoJuke.lnk';

const readFlag = (name, fallback = null) => {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

main(async () => {
  if (process.platform !== 'win32') {
    logStep('Nothing to do: there is no Windows Start Menu here');
    return;
  }

  const shortcutPath = join(readFlag('target', startMenuDirectory()), SHORTCUT_NAME);
  if (!(await pathExists(shortcutPath))) {
    logStep(`Nothing to remove: there is no shortcut at ${shortcutPath}`);
    return;
  }

  logStep('Removing the Start Menu shortcut');
  await rm(shortcutPath, { force: true });
  process.stdout.write(`\n  Removed ${shortcutPath}\n\n`);
});
