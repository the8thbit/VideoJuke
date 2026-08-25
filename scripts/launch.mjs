/**
 * What the Start Menu shortcut runs: bring everything up to date, then start.
 *
 * Three things can be out of date by the time somebody clicks the icon: the
 * source (behind the branch it tracks), the build (older than the source), and
 * yt-dlp (which stops working when it ages). Each is checked here, and none of
 * them can stop the app opening: a laptop that is offline, a repository with
 * local edits, a downloader that is busy - all of those are reasons to start
 * what is already installed, not reasons to show an error instead of television.
 */
import { spawn } from 'node:child_process';

import { fromRoot, logStep, projectRoot, run } from './lib/run.mjs';
import { inspectRemote, pullFastForward } from './lib/remote.mjs';
import { inspectBuild } from './lib/staleness.mjs';
import { updateYtDlp } from './lib/ytdlp.mjs';

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

/**
 * Brings the working copy up to date with the branch it tracks, if it safely
 * can. Returns its output rather than printing it, so the two update checks can
 * run at the same time without interleaving their lines.
 */
const updateFromRemote = async () => {
  const decision = await inspectRemote();
  if (decision.action !== 'pull') {
    return {
      pulled: false,
      lines: [decision.action === 'current' ? decision.reason : `not updating: ${decision.reason}`],
    };
  }

  const pull = await pullFastForward();
  return pull.pulled
    ? { pulled: true, lines: [`pulled ${decision.reason}`, `  ${pull.reason}`] }
    : { pulled: false, lines: [`could not update: ${pull.reason}`] };
};

const main = async () => {
  const mode = readMode();
  const skipUpdates = process.argv.includes('--no-update');

  let pulled = false;
  if (skipUpdates) {
    logStep('Skipping the update checks (--no-update)');
  } else {
    logStep('Checking for updates');
    // Together: both talk to the network, and running them one after the other
    // would add one round trip to every launch for no reason. Their output is
    // collected and printed in a fixed order rather than as it arrives.
    const [remote, ytdlp] = await Promise.all([updateFromRemote(), updateYtDlp()]);
    for (const line of [...remote.lines, ...ytdlp.lines]) {
      process.stdout.write(`  ${line}\n`);
    }
    pulled = remote.pulled;
  }

  const build = await inspectBuild();

  // Source that arrived in a pull is newer than dist, so `inspectBuild` reports
  // it stale - but only because git happens to stamp checked-out files with the
  // time of the checkout. That is a true fact about git rather than a promise it
  // makes, so a pull forces the build rather than inferring it from mtimes.
  if (build.stale || pulled) {
    // Before every build, not only when node_modules is missing: a pull can
    // move the lockfile, and a build against dependencies that no longer match
    // it fails in ways that look like source errors. An install with nothing to
    // do costs a couple of seconds; diagnosing that costs an evening.
    logStep('Installing dependencies');
    await run('npm', ['install']);

    logStep(`Building: ${pulled && !build.stale ? 'new commits were pulled' : build.reason}`);
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
