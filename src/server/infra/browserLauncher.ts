import { spawn } from 'child_process';

import { attempt, err, ok, type Result } from '../../shared/types/result';

/**
 * Opens a URL in the user's default browser.
 *
 * This replaces the `open` package, which is ESM-only and therefore could not
 * be required from the CommonJS server bundle without a dynamic-import dance
 * that TypeScript rewrites back into a `require`. Three platform commands are
 * all that dependency provided.
 */
const launchCommand = (
  url: string,
): { readonly command: string; readonly args: readonly string[] } => {
  switch (process.platform) {
    case 'win32':
      // The empty title argument keeps `start` from treating the URL as one.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'darwin':
      return { command: 'open', args: [url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
};

/**
 * Resolves once the launcher has either started or failed to start.
 *
 * A missing command - `xdg-open` on a headless Linux box is the usual one - is
 * not a throw. `spawn` returns a `ChildProcess` and reports the failure later
 * by emitting `error` on it, and an `EventEmitter` that emits `error` with no
 * listener rethrows it as an uncaught exception, which would take the whole
 * server down moments after it started listening. Listening for that event is
 * what turns the failure back into a value, and because it arrives
 * asynchronously the answer has to be a promise.
 */
export const openInBrowser = (url: string): Promise<Result<void>> => {
  const { command, args } = launchCommand(url);
  const spawned = attempt(() => spawn(command, [...args], { detached: true, stdio: 'ignore' }));
  if (!spawned.ok) return Promise.resolve(spawned);

  const child = spawned.value;
  return new Promise<Result<void>>((resolve) => {
    // Exactly one of these two events fires, so the promise always settles.
    child.once('error', (thrown) => {
      resolve(err(thrown));
    });
    child.once('spawn', () => {
      resolve(ok(undefined));
    });
    // Detached and unreffed so an open browser cannot hold the server process
    // alive; the listeners above are attached first because unreffing does not
    // suppress the events, it only stops them from keeping the loop running.
    child.unref();
  });
};

/** `0.0.0.0` is a bind address, not something a browser can navigate to. */
export const toBrowsableHost = (host: string): string =>
  host === '0.0.0.0' || host === '::' ? 'localhost' : host;

export const toServerUrl = (host: string, port: number): string =>
  `http://${toBrowsableHost(host)}:${port}`;
