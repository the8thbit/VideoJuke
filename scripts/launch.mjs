/**
 * What the Start Menu shortcut runs: build if anything has changed, then start.
 *
 * A shortcut that only started the app would run yesterday's code after an edit,
 * and one that always built would take a minute every time. This checks, which
 * costs a few milliseconds when there is nothing to do - which is almost always.
 */
import { spawn } from 'node:child_process';

import { fromRoot, logStep, projectRoot, run } from './lib/run.mjs';
import { inspectBuild } from './lib/staleness.mjs';

const MODES = {
  electron: ['node_modules/electron/cli.js', 'dist/server/electron/main.js'],
  web: [null, 'dist/server/web/main.js'],
};

const readMode = () => {
  const found = process.argv.find((argument) => argument.startsWith('--mode='));
  const mode = found === undefined ? 'electron' : found.slice('--mode='.length);
  if (mode in MODES) return mode;
  throw new Error(`unknown --mode=${mode}; expected electron or web`);
};

/** Everything after `--` is passed on to the app, e.g. `-- --role=follower`. */
const appArguments = () => {
  const separator = process.argv.indexOf('--');
  return separator === -1 ? [] : process.argv.slice(separator + 1);
};

/**
 * Waits for a key before returning, so a console the shortcut opened does not
 * vanish with the error still on it.
 */
const pause = async (message) => {
  process.stdout.write(`\n${message}\n\nPress any key to close this window.`);
  if (!process.stdin.isTTY) return;

  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
};

const main = async () => {
  const mode = readMode();
  const build = await inspectBuild();

  if (build.stale) {
    logStep(`Building: ${build.reason}`);
    if (build.reason === 'dependencies are not installed') {
      await run('npm', ['install']);
    }
    await run(process.execPath, [fromRoot('scripts', 'build.mjs')]);
  } else {
    logStep(build.reason);
  }

  logStep(`Starting VideoJuke (${mode})`);
  const [runtime, entry] = MODES[mode];
  const command = runtime === null ? process.execPath : process.execPath;
  const args = runtime === null
    ? [fromRoot(entry), ...appArguments()]
    : [fromRoot(runtime), fromRoot(entry), ...appArguments()];

  // Detached, so this console can close and leave the app running. A shortcut
  // that left a terminal sitting behind the player for the rest of the evening
  // is not what anyone means by "start the app".
  const child = spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
};

main().catch(async (error) => {
  process.exitCode = 1;
  // Held open on purpose: this window was opened by a shortcut, so closing it
  // immediately would take the only explanation with it.
  await pause(`VideoJuke could not start.\n\n${error instanceof Error ? error.message : String(error)}`);
});
