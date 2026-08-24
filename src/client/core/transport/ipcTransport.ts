import type { Logger } from '../../../shared/types/logging';
import type { PlayerApi } from '../../../shared/types/protocol';

declare global {
  interface Window {
    /** Installed by the Electron preload script; absent everywhere else. */
    readonly videojuke?: PlayerApi;
  }
}

/**
 * The Electron half of the transport is written once, in the preload script,
 * and handed to the page over the context bridge. There is nothing left to
 * build here: this only reports whether the bridge has arrived, which is why it
 * returns null rather than throwing.
 */
export const createIpcTransport = (logger: Logger): PlayerApi | null => {
  const bridge = window.videojuke;
  if (bridge === undefined) {
    logger.debug('window.videojuke is not present yet');
    return null;
  }

  logger.info('ipc transport ready');
  return bridge;
};

/**
 * Waits for the preload script to expose the bridge.
 *
 * The renderer can run before the bridge is installed, so the legacy client
 * called itself again through setTimeout every 100ms and had no way to stop:
 * a preload that failed to load left the page retrying for the life of the
 * process, showing nothing. A fixed poll with a deadline resolves to null
 * instead, so the caller can say what went wrong.
 */
export const waitForIpcBridge = (options: {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly logger: Logger;
}): Promise<PlayerApi | null> => {
  const { timeoutMs, pollMs, logger } = options;

  const immediate = createIpcTransport(logger);
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    // A zero interval would starve the very task that installs the bridge.
    const interval = Math.max(pollMs, 1);

    const timer = setInterval(() => {
      const bridge = createIpcTransport(logger);
      if (bridge !== null) {
        clearInterval(timer);
        resolve(bridge);
        return;
      }

      if (Date.now() >= deadline) {
        clearInterval(timer);
        logger.warn(`no ipc bridge after ${timeoutMs}ms`);
        resolve(null);
      }
    }, interval);
  });
};
