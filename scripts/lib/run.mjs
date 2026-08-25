import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const fromRoot = (...segments) => join(projectRoot, ...segments);

/**
 * Characters cmd.exe passes through untouched. Anything else - a space above all
 * - has to carry its own quotes.
 */
const SHELL_SAFE = /^[A-Za-z0-9_,:=+.@/\\-]+$/;

/**
 * Quotes one argument for a shell invocation.
 *
 * `spawn` with `shell: true` on Windows quotes nothing: it joins the command and
 * its arguments with plain spaces and hands the result to `cmd /d /s /c`. So
 * `-o C:\\Users\\Ann Smith\\repo\\release\\webos` arrived at ares-package as three
 * arguments - the output path truncated at the first space, with two stray
 * operands after it - and `package-webos.mjs` reported the resulting failure as
 * "ares-package is unavailable" and exited 0. A clone path containing a space is
 * an ordinary Windows setup; a user name or an "OneDrive - Acme" folder is enough.
 */
const quoteForShell = (argument) => {
  const text = String(argument);
  return SHELL_SAFE.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
};

/** Runs a command, inheriting stdio, and rejects when it exits non-zero. */
export const run = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    // `.exe` takes the no-shell path, where libuv does the escaping correctly.
    const useShell = process.platform === 'win32' && !command.endsWith('.exe');
    const child = spawn(command, useShell ? args.map(quoteForShell) : args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: useShell,
      ...options,
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      // The code travels with the failure so a caller can tell "this tool is not
      // installed" from "this tool ran and refused", which look identical in the
      // message and mean very different things.
      const failure = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
      failure.exitCode = code;
      rejectPromise(failure);
    });
  });

/** Runs the project's local TypeScript compiler. */
export const runTsc = (args) =>
  run(process.execPath, [fromRoot('node_modules', 'typescript', 'bin', 'tsc'), ...args]);

/**
 * Runs a command for its output rather than its effect, and never throws.
 *
 * `run` is wrong for anything whose failure is an answer rather than a problem:
 * it inherits stdio, so the output cannot be read, and it rejects, so every
 * caller would need a try/catch around a question it merely wanted answered.
 * This reports the exit code instead, and enforces a deadline - which `run`
 * has no need of and this does, because the one caller talks to a network.
 */
export const capture = (command, args, options = {}) =>
  new Promise((resolvePromise) => {
    const useShell = process.platform === 'win32' && !command.endsWith('.exe');
    const child = spawn(command, useShell ? args.map(quoteForShell) : args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      ...options,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    // Node's own `timeout` option signals the child but does not tell the
    // caller why it died, and "the network hung" has to be distinguishable from
    // "the command failed", or a launcher would report an offline laptop as a
    // broken repository.
    const deadline =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);

    const settle = (code, error) => {
      if (deadline !== null) clearTimeout(deadline);
      resolvePromise({
        ok: !timedOut && error === undefined && code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        error,
      });
    };

    child.on('error', (error) => settle(null, error));
    child.on('close', (code) => settle(code));
  });

/**
 * Whether a `run` failure means the command was not there to begin with.
 *
 * Without a shell, `spawn` reports that as an `ENOENT` error. Through cmd.exe it
 * is exit code 9009 ("is not recognized as an internal or external command"),
 * and through a POSIX shell it is 127 - neither of which is distinguishable from
 * a real failure by message alone.
 */
export const isMissingCommand = (error) =>
  error?.code === 'ENOENT' || error?.exitCode === 9009 || error?.exitCode === 127;

export const removeDirectory = (path) => rm(path, { recursive: true, force: true });

export const ensureDirectory = (path) => mkdir(path, { recursive: true });

export const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Copies a file or directory, creating the destination's parent as needed. */
export const copyInto = async (source, destination) => {
  if (!(await pathExists(source))) return false;
  await ensureDirectory(dirname(destination));
  await cp(source, destination, { recursive: true });
  return true;
};

export const logStep = (message) => {
  process.stdout.write(`\n> ${message}\n`);
};

/** Wraps a script body so failures print cleanly and set a non-zero exit code. */
export const main = (task) => {
  task().catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  });
};
