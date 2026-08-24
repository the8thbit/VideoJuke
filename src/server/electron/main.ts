/**
 * The Electron composition root: everything the application is made of is
 * created here and injected downwards, which is why this is one of the two
 * files allowed to reach for node built-ins directly.
 *
 * The legacy entry point required server.js for its side effects and required
 * it a second time from inside an event handler; the work now happens in one
 * explicit bootstrap.
 */
import { app, BrowserWindow } from 'electron';
import { unwatchFile, watchFile, type Stats } from 'fs';
import { resolve } from 'path';

import { DEFAULT_CONFIG } from '../../shared/config/defaults';
import { createStore } from '../../shared/state/store';
import { systemClock } from '../../shared/time/clock';
import type { PreprocessedVideo } from '../../shared/types/video';
import { fileLocation } from '../../shared/video/videoLocation';
import { createPlayerService } from '../api/playerService';
import { createConfigService } from '../domain/configService';
import { createSession } from '../domain/session';
import { createMediaToolkit } from '../infra/ffmpeg';
import { nodeFileSystem } from '../infra/fileSystem';
import { createServerLogging } from '../infra/logger';
import { resolveAppPaths } from '../infra/paths';
import { systemServices } from '../infra/system';
import { registerPlayerIpc } from './ipc';
import { createPlayerWindow, type PlayerWindow } from './window';

/** How often node polls config.json for changes. */
const CONFIG_WATCH_INTERVAL_MS = 1000;

/**
 * How long the quit sequence gets before the process is ended regardless.
 *
 * `before-quit` cancels the quit so the state can be saved, which means a save
 * that never finishes - a cache directory on a share that has gone away - left
 * an application the user could not close by any means short of the task
 * manager. The web server has always had this deadline; the Electron host did
 * not.
 */
const QUIT_TIMEOUT_MS = 10000;

/**
 * `watchFile` polls and reports every tick, including the ones where nothing
 * happened, so the modification time is what decides whether to reload.
 */
const watchConfigFile = (path: string, onChange: () => void): (() => void) => {
  const listener = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs === previous.mtimeMs) return;
    onChange();
  };

  watchFile(path, { interval: CONFIG_WATCH_INTERVAL_MS }, listener);
  return () => {
    unwatchFile(path, listener);
  };
};

const isDevMode = process.argv.includes('--dev');

/** `--role=follower` on the command line; empty means a screen that plays alone. */
const roleArgument = (): string => {
  const found = process.argv.find((argument) => argument.startsWith('--role='));
  return found === undefined ? '' : found.slice('--role='.length).trim();
};

/**
 * The threshold is the built-in default rather than the user's setting: the
 * logger has to exist before config.json can be read, and every consumer holds
 * the logger it was handed.
 */
const logging = createServerLogging({
  scope: 'server',
  minLevel: DEFAULT_CONFIG.system.logLevel,
});
const logger = logging.logger;

process.on('uncaughtException', (thrown: unknown) => {
  logger.error('uncaught exception', thrown);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled rejection', reason);
});

interface ActiveWindow {
  readonly window: PlayerWindow;
  readonly disposeIpc: () => void;
}

const bootstrap = async (): Promise<void> => {
  // User data follows the working directory, as it always has; the shipped
  // defaults are read from wherever the compiled bundle lives.
  const workingDirectory = process.cwd();
  const installDirectory = resolve(__dirname, '..', '..', '..');

  // Two resolutions: the config file lives at a fixed place under the root, and
  // only once it has been read do we know where the user wants the cache and
  // temp directories to be.
  const configService = await createConfigService({
    fileSystem: nodeFileSystem,
    paths: resolveAppPaths({ workingDirectory, installDirectory }),
    logger: logger.child('config'),
    watchFile: watchConfigFile,
  });
  const paths = resolveAppPaths({
    workingDirectory,
    installDirectory,
    directories: configService.current().system,
  });

  const session = createSession({
    fileSystem: nodeFileSystem,
    media: createMediaToolkit({ logger: logger.child('ffmpeg') }),
    paths,
    clock: systemClock,
    logging,
    system: systemServices,
    configService,
  });

  const service = createPlayerService(session, {
    // Electron reads the transcode straight off disk, so the renderer is handed
    // the path rather than a URL to stream from.
    locate: (video: PreprocessedVideo) => fileLocation(video.processedPath),
    now: systemClock.now,
    onShutdownRequest: () => {
      app.quit();
    },
  });

  /**
   * Memoised rather than flagged: the window close and `before-quit` both want
   * the state saved, and the second caller has to wait for the first save
   * instead of racing past it into `app.exit`.
   */
  const shutdownTask = createStore<Promise<void> | null>(null);

  const saveAndStop = (): Promise<void> => {
    const running = shutdownTask.get();
    if (running !== null) return running;

    const started = (async (): Promise<void> => {
      try {
        await session.shutdown();
      } catch (thrown) {
        logger.error('failed to save state during shutdown', thrown);
      }
    })();

    shutdownTask.set(started);
    return started;
  };

  const active = createStore<ActiveWindow | null>(null);

  const openWindow = (): void => {
    // Handlers are per window because they forward events into it; the old ones
    // must go first, since a channel may only have one handler registered.
    active.get()?.disposeIpc();

    const window = createPlayerWindow({
      config: configService.current(),
      logger: logger.child('window'),
      isDevMode,
      role: roleArgument(),
    });
    window.onClose(saveAndStop);

    const disposeIpc = registerPlayerIpc({
      service,
      session,
      window,
      logging,
      logger: logger.child('ipc'),
    });

    active.set({ window, disposeIpc });
  };

  const quitting = createStore(false);

  app.on('window-all-closed', () => {
    // Not while a quit is already running. Closing the page destroys the window
    // that owned it, so the shutdown sequence below raises this event itself
    // half way through - and the second `app.quit` it used to trigger tore the
    // process down before the first one had saved anything.
    if (quitting.get()) return;
    app.quit();
  });

  // Carried over from the legacy entry point: on macOS a click on the dock icon
  // is expected to bring the player back rather than do nothing.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });

  app.on('before-quit', (event) => {
    // A second quit while the first is still running would start the sequence
    // again; the deadline below is what guarantees the first one ends. It still
    // has to be prevented: returning here let Electron shut the process down
    // inside that native stack, part-way through the first sequence, so quitting
    // with Escape left the state unsaved and an ffmpeg child unreaped - which is
    // exactly what `session.shutdown` exists to do.
    if (quitting.get()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    quitting.set(true);

    const deadline = setTimeout(() => {
      logger.error(`the shutdown did not finish within ${QUIT_TIMEOUT_MS}ms, exiting anyway`);
      app.exit(1);
    }, QUIT_TIMEOUT_MS);

    void (async () => {
      try {
        // The window first: its unload handler is what mirrors the client's
        // playback queue, and `saveAndStop` is what writes that mirror out. A
        // quit that skipped the window saved a queue one sync tick stale.
        await active.get()?.window.closeAndWait();
        await saveAndStop();
      } catch (thrown) {
        logger.error('the shutdown failed', thrown);
      }
      clearTimeout(deadline);
      app.exit(0);
    })();
  });

  openWindow();
  await session.start();
};

const start = async (): Promise<void> => {
  await app.whenReady();
  await bootstrap();
};

void start().catch((thrown: unknown) => {
  logger.error('failed to start VideoJuke', thrown);
  app.exit(1);
});
