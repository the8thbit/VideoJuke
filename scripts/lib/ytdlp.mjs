/**
 * Keeps yt-dlp present and current, because a stale one is the usual reason a
 * download stops working: sites change, and yt-dlp answers with a release
 * rather than a fix you can wait for.
 *
 * VideoJuke itself never calls it - the player indexes directories and knows
 * nothing about where their contents came from - so nothing here is allowed to
 * fail a launch. Every path below ends in "carry on and start the app".
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';

import { capture, fromRoot, pathExists } from './run.mjs';

/**
 * How long yt-dlp gets to check, download and verify.
 *
 * Generous, because on the day a release lands this transfers about twenty
 * megabytes; still bounded, because the alternative is a Start Menu shortcut
 * that appears to do nothing.
 */
export const UPDATE_TIMEOUT_MS = 120000;

/** Where a copy this launcher installed lives. Gitignored; see `.gitignore`. */
const TOOLS_DIRECTORY = 'tools';

/**
 * The release asset for this platform, and the name it has in the checksum
 * file. Windows is the only one this project is really run on, but naming the
 * others costs two lines and makes the failure on a Mac a clear message rather
 * than a mysterious 404.
 */
const ASSETS = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp',
};

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

const assetName = () => ASSETS[process.platform] ?? null;

const managedPath = () => fromRoot(TOOLS_DIRECTORY, assetName() ?? 'yt-dlp');

/** yt-dlp installed through pip cannot replace its own binary, and says so. */
const isPackageManaged = (output) =>
  /you installed yt-dlp with pip|use that to update|not able to update/i.test(output);

const summarise = (output) => {
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .pop();
  return line ?? 'no output';
};

const versionOf = async (command) => {
  const asked = await capture(command, ['--version'], { timeoutMs: 15000 });
  return asked.ok ? asked.stdout : null;
};

/**
 * Finds the yt-dlp this machine should be using.
 *
 * PATH first and deliberately: a copy the user installed themselves is the one
 * their own scripts and shells reach, so that is the one worth keeping current.
 * The managed copy is only a fallback for a machine that had none.
 */
const locate = async () => {
  const onPath = await versionOf('yt-dlp');
  if (onPath !== null) return { command: 'yt-dlp', version: onPath, managed: false };

  const managed = managedPath();
  if (await pathExists(managed)) {
    const version = await versionOf(managed);
    if (version !== null) return { command: managed, version, managed: true };
  }
  return null;
};

/**
 * Reads one file from the release over HTTPS, with a deadline.
 *
 * `fetch` follows redirects by default, which this needs: the `latest/download`
 * URL is a redirect to whatever the current tag is.
 */
const download = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** The expected digest for `name`, out of the release's SHA2-256SUMS file. */
const expectedDigest = (sums, name) => {
  for (const line of sums.split('\n')) {
    const [digest, file] = line.trim().split(/\s+/);
    if (file === name && typeof digest === 'string' && /^[0-9a-f]{64}$/i.test(digest)) {
      return digest.toLowerCase();
    }
  }
  return null;
};

/**
 * Installs yt-dlp from its official release, checking it before it is ever run.
 *
 * The checksum is the point of this function. Downloading an executable and
 * running it unattended is exactly the operation worth being careful about, so
 * the digest is fetched from the same release, compared against the bytes that
 * arrived, and the file only reaches its final name once it matches. A mismatch
 * leaves nothing behind. It is not protection against a compromised upstream -
 * nothing here could be - but it does mean a truncated transfer or a mangling
 * proxy is caught rather than executed.
 */
const install = async () => {
  const name = assetName();
  if (name === null) {
    return [`yt-dlp is not installed, and there is no release build for ${process.platform}.`];
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  const target = managedPath();
  const scratch = `${target}.partial`;

  try {
    const sums = await download(`${RELEASE_BASE}/SHA2-256SUMS`, controller.signal);
    const expected = expectedDigest(sums.toString('utf8'), name);
    if (expected === null) {
      return [`yt-dlp was not installed: the release lists no checksum for ${name}.`];
    }

    const binary = await download(`${RELEASE_BASE}/${name}`, controller.signal);
    const actual = createHash('sha256').update(binary).digest('hex');
    if (actual !== expected) {
      return [
        'yt-dlp was not installed: the download did not match the published checksum.',
        `  expected ${expected}`,
        `  received ${actual}`,
      ];
    }

    await mkdir(fromRoot(TOOLS_DIRECTORY), { recursive: true });
    // Written under a scratch name and renamed, so an interrupted download can
    // never leave a half-written executable sitting at the real path.
    await writeFile(scratch, binary);
    await chmod(scratch, 0o755).catch(() => undefined);
    await rename(scratch, target);

    const version = await versionOf(target);
    if (version === null) {
      return ['yt-dlp was installed but would not run; leaving it in place to look at.'];
    }
    return [
      `yt-dlp ${version} installed to ${target}`,
      '  checksum verified against the release.',
      '  Add that folder to your PATH to use it from a shell.',
    ];
  } catch (error) {
    await rm(scratch, { force: true }).catch(() => undefined);
    const reason = controller.signal.aborted
      ? `no answer within ${UPDATE_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error));
    return [`yt-dlp could not be installed: ${reason}`];
  } finally {
    clearTimeout(deadline);
  }
};

/** Brings an existing yt-dlp forward through its own self-update. */
const update = async (found) => {
  const updated = await capture(found.command, ['-U'], { timeoutMs: UPDATE_TIMEOUT_MS });
  const output = `${updated.stdout}\n${updated.stderr}`;

  if (isPackageManaged(output)) {
    return {
      updated: false,
      lines: [
        `yt-dlp ${found.version} was installed by a package manager, so it updates through that.`,
        '  Run `pip install -U yt-dlp` to bring it forward.',
      ],
    };
  }
  if (updated.timedOut) {
    return { updated: false, lines: [`yt-dlp ${found.version}: the update did not finish in time.`] };
  }
  if (!updated.ok) {
    // A locked binary is the everyday case: yt-dlp cannot replace itself while
    // another copy is running, and that is not worth stopping a launch for.
    return {
      updated: false,
      lines: [`yt-dlp ${found.version} could not update: ${summarise(output)}`],
    };
  }

  const version = (await versionOf(found.command)) ?? found.version;
  return {
    updated: version !== found.version,
    lines: [
      version === found.version
        ? `yt-dlp ${version} is up to date.`
        : `yt-dlp updated to ${version}.`,
    ],
  };
};

/**
 * Makes sure yt-dlp is present and current, and reports what happened in lines
 * the caller can print. Never throws, and never fails a launch.
 */
export const updateYtDlp = async () => {
  const found = await locate();
  if (found === null) return { updated: true, lines: await install() };
  return update(found);
};
