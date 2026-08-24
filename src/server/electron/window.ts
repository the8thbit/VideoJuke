import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'path';

import { createStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/types/config';
import type { Logger } from '../../shared/types/logging';

const WINDOWED_WIDTH = 1200;
const WINDOWED_HEIGHT = 800;

/**
 * How long the renderer is given to run its unload handlers before the window
 * is taken away from it. A page wedged in a script must not be able to stop the
 * application from quitting, so the wait always ends.
 */
const RENDERER_UNLOAD_TIMEOUT_MS = 2000;

export interface PlayerWindowDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly isDevMode: boolean;
  /**
   * `leader`, `follower` or empty for a screen that plays on its own.
   *
   * Carried to the renderer as a query parameter because the page is loaded from
   * a file and a renderer cannot read `process.argv`. The role cannot come from
   * config.json either: that is shared by every client, and the whole point is
   * that one particular screen leads.
   */
  readonly role: string;
}

export interface PlayerWindow {
  /** Null once the window has been closed; callers must handle that. */
  readonly instance: () => BrowserWindow | null;
  readonly send: (channel: string, payload: unknown) => void;
  /** Work to await before the window is allowed to go away. One handler only. */
  readonly onClose: (handler: () => Promise<void>) => void;
  readonly close: () => void;
  /**
   * Closes the window and resolves once its close work has finished, including
   * the close already in flight when it is called.
   *
   * `before-quit` needs this. Quitting from the menu, from `requestShutdown` or
   * from the dock never went through the window at all, so the renderer's unload
   * handler - the only thing that mirrors the client's playback queue to the
   * server - did not run, and every restart resumed from a queue one sync tick
   * out of date.
   */
  readonly closeAndWait: () => Promise<void>;
}

/**
 * Resolves a file next to the compiled renderer. This module ends up at
 * `dist/server/electron/window.js` and the page at `dist/client/electron`, so
 * both live two levels up. `node:path` is otherwise confined to `server/infra`,
 * but the location is relative to this file and the deps carry no paths, so the
 * join has to happen here.
 */
const clientFile = (name: string): string =>
  join(__dirname, '..', '..', 'client', 'electron', name);

const toWindowOptions = (startFullscreen: boolean): BrowserWindowConstructorOptions => ({
  show: false,
  autoHideMenuBar: true,
  transparent: false,
  ...(startFullscreen
    ? { fullscreen: true, frame: false }
    : { width: WINDOWED_WIDTH, height: WINDOWED_HEIGHT, frame: true }),
  webPreferences: {
    preload: clientFile('preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});

/**
 * The player window and nothing else: it owns the BrowserWindow, forwards
 * messages to the renderer and sequences the shutdown work that has to finish
 * before the window disappears.
 */
export const createPlayerWindow = (deps: PlayerWindowDeps): PlayerWindow => {
  const { config, logger, isDevMode, role } = deps;
  const startFullscreen = config.ui.startFullscreen;

  const browserWindow = new BrowserWindow(toWindowOptions(startFullscreen));
  const current = createStore<BrowserWindow | null>(browserWindow);
  const closeHandler = createStore<(() => Promise<void>) | null>(null);
  const closing = createStore<Promise<void> | null>(null);

  logger.info(
    `opening the player window: ` +
      (startFullscreen ? 'fullscreen' : `${WINDOWED_WIDTH}x${WINDOWED_HEIGHT}`),
  );

  browserWindow.once('ready-to-show', () => {
    // Re-applied after creation: a window manager that ignored the constructor
    // flag still honours the explicit call, which is why the legacy code did it.
    if (startFullscreen) browserWindow.setFullScreen(true);
    browserWindow.show();
  });

  browserWindow.on('closed', () => {
    current.set(null);
  });

  /**
   * Unloads the page and resolves once it is gone, or once the deadline passes.
   *
   * `destroy()` force-closes without dispatching `beforeunload`, so the
   * renderer's unload listener - whose last act is mirroring the playback queue
   * to the server - never ran on a normal close, and the client-side queue was
   * lost every time. `webContents.close` dispatches it. What that buys is the
   * chance for the renderer to send that last mirror, not a guarantee the
   * server has applied it: a page cannot await anything during unload, so the
   * mirror is best effort on both sides of the boundary.
   */
  const unloadPage = (): Promise<void> =>
    new Promise<void>((resolve) => {
      // Reading `webContents` off a destroyed window throws, so the window is
      // checked before the page is.
      if (browserWindow.isDestroyed()) {
        resolve();
        return;
      }
      const contents = browserWindow.webContents;
      if (contents.isDestroyed()) {
        resolve();
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        contents.removeListener('destroyed', settle);
        resolve();
      };

      timer = setTimeout(() => {
        logger.warn('the renderer did not unload in time; closing the window anyway');
        settle();
      }, RENDERER_UNLOAD_TIMEOUT_MS);

      contents.once('destroyed', settle);
      // A page that refuses to unload keeps its window; the deadline above is
      // what makes that survivable.
      contents.close({ waitForBeforeUnload: true });
    });

  const runClose = async (handler: () => Promise<void>): Promise<void> => {
    // The page goes first: its unload work mirrors the playback queue to the
    // server, and the handler is what persists the state that mirror feeds.
    await unloadPage();
    try {
      await handler();
    } catch (thrown) {
      // A failed save must not strand the window open with no way to quit.
      logger.error('the window close handler failed', thrown);
    }
    // Usually gone already, since closing the page closes the window that owns
    // it. The destroy is for the page that missed its deadline.
    if (!browserWindow.isDestroyed()) browserWindow.destroy();
  };

  /** Starts the close work, or hands back the one already running. */
  const beginClose = (): Promise<void> => {
    const started = closing.get();
    if (started !== null) return started;

    const handler = closeHandler.get();
    const work = handler === null ? Promise.resolve() : runClose(handler);
    closing.set(work);
    return work;
  };

  browserWindow.on('close', (event) => {
    if (closeHandler.get() === null) return;

    // The shutdown work is asynchronous, so this close is cancelled and
    // `runClose` becomes the only thing that closes the window: it unloads the
    // page, awaits the handler, then destroys whatever is left. Every later
    // close is cancelled too: the legacy version called preventDefault and then
    // destroy without a guard, so a second click on the close button while the
    // save was in flight ran the whole save again.
    event.preventDefault();
    void beginClose();
  });

  if (isDevMode) {
    logger.debug('opening devtools');
    browserWindow.webContents.openDevTools();
  }

  const page = clientFile('index.html');
  const query = role === '' ? {} : { query: { role } };
  void browserWindow.loadFile(page, query).catch((thrown: unknown) => {
    logger.error(`could not load ${page}`, thrown);
  });

  return {
    instance: current.get,

    /**
     * Silent about a missing window on purpose: log entries are forwarded
     * through here, so reporting a failed send would log again and recurse.
     */
    send: (channel, payload) => {
      const window = current.get();
      if (window === null || window.isDestroyed()) return;
      if (window.webContents.isDestroyed()) return;
      window.webContents.send(channel, payload);
    },

    onClose: (handler) => {
      closeHandler.set(handler);
    },

    close: () => {
      current.get()?.close();
    },

    closeAndWait: () => {
      const window = current.get();
      // Already gone: `runClose` destroyed it, and whatever it was waiting for
      // has finished. `beginClose` would still resolve, but going through a
      // destroyed BrowserWindow is not worth the risk of it throwing.
      if (window === null || window.isDestroyed()) return closing.get() ?? Promise.resolve();
      return beginClose();
    },
  };
};
