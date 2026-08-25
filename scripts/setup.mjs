/**
 * `npm run setup`: build once, then put VideoJuke in the Start Menu.
 *
 * Run it once. After that the Start Menu entry runs `scripts/launch.mjs`, which
 * rebuilds only when something has actually changed and then starts the app.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureDirectory, fromRoot, logStep, main, pathExists, projectRoot, run } from './lib/run.mjs';
import { createShortcut, readShortcut, startMenuDirectory } from './lib/shortcut.mjs';
import { inspectBuild } from './lib/staleness.mjs';

const SHORTCUT_NAME = 'VideoJuke.lnk';

const readFlag = (name, fallback = null) => {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

/**
 * The Electron runtime's own icon.
 *
 * The project ships a PNG rather than an `.ico`, and a `.lnk` wants an icon
 * resource, so this borrows the icon from the executable that actually puts the
 * window on screen. Better than the generic Node icon, and it costs nothing.
 */
const iconLocation = async () => {
  const electron = fromRoot('node_modules', 'electron', 'dist', 'electron.exe');
  return (await pathExists(electron)) ? electron : '';
};

main(async () => {
  if (process.platform !== 'win32') {
    logStep('Nothing to do');
    process.stdout.write(
      '\n  A Start Menu shortcut is a Windows idea, and this is not Windows.\n' +
        '  Start VideoJuke with `npm start`, or point a launcher at:\n\n' +
        `      ${process.execPath} ${fromRoot('scripts', 'launch.mjs')}\n\n`,
    );
    return;
  }

  const mode = readFlag('mode', 'electron');
  if (mode !== 'electron' && mode !== 'web') {
    throw new Error(`unknown --mode=${mode}; expected electron or web`);
  }

  // Overridable so the install can be exercised without writing into a real
  // Start Menu; the default is the only one anybody should need.
  const directory = readFlag('target', startMenuDirectory());
  const shortcutPath = join(directory, SHORTCUT_NAME);

  if (readFlag('build', 'yes') !== 'no') {
    const build = await inspectBuild();
    if (build.stale) {
      // Unconditionally, as the launcher does: node_modules existing is not the
      // same as it matching the lockfile, and a build against a mismatch fails
      // in ways that read as source errors.
      logStep('Installing dependencies');
      await run('npm', ['install']);
      // Built here rather than on the first click, so the shortcut is only ever
      // created for a build that is known to work - and so that first click is
      // instant rather than a minute of console.
      logStep(`Building: ${build.reason}`);
      await run(process.execPath, [fromRoot('scripts', 'build.mjs')]);
    } else {
      logStep(build.reason);
    }
  }

  logStep(`Creating the Start Menu shortcut`);
  await ensureDirectory(directory);

  const args = [`"${fromRoot('scripts', 'launch.mjs')}"`, `--mode=${mode}`].join(' ');
  await createShortcut({
    shortcutPath,
    // The absolute path to the Node that ran this, not a bare `node`: the Start
    // Menu does not run with a shell profile, and PATH there is not necessarily
    // the PATH this was installed from.
    targetPath: process.execPath,
    args,
    workingDirectory: projectRoot,
    description: 'Play videos at random from your configured directories',
    iconLocation: await iconLocation(),
  });

  // Read back rather than trusting the write: a COM call that quietly did
  // nothing would otherwise be discovered by a shortcut that does nothing.
  const written = await readShortcut(shortcutPath);
  if (written.TargetPath.toLowerCase() !== process.execPath.toLowerCase()) {
    throw new Error(`the shortcut was created but points at ${written.TargetPath}`);
  }

  const entries = await readdir(directory).catch(() => []);
  if (!entries.includes(SHORTCUT_NAME)) {
    throw new Error(`the shortcut is not in ${directory}`);
  }

  process.stdout.write(
    `\n  VideoJuke is in your Start Menu.\n\n` +
      `      ${shortcutPath}\n\n` +
      '  It rebuilds only when something has changed, then starts the app.\n' +
      '  Remove it again with `npm run setup:remove`.\n\n',
  );
});
