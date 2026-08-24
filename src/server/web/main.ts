import { watch } from 'fs';
import { basename, resolve } from 'path';

import { DEFAULT_CONFIG } from '../../shared/config/defaults';
import { createStore } from '../../shared/state/store';
import { systemClock } from '../../shared/time/clock';
import type { Logger } from '../../shared/types/logging';
import { AUTH_TOKEN_PARAM, HTTP_ROUTES } from '../../shared/types/protocol';
import { toError } from '../../shared/types/result';
import type { PreprocessedVideo, VideoLocation } from '../../shared/types/video';
import { httpLocation } from '../../shared/video/videoLocation';
import { createPlayerService } from '../api/playerService';
import { createConfigService } from '../domain/configService';
import { createSession } from '../domain/session';
import { openInBrowser, toServerUrl } from '../infra/browserLauncher';
import { createMediaToolkit } from '../infra/ffmpeg';
import { nodeFileSystem } from '../infra/fileSystem';
import { createServerLogging } from '../infra/logger';
import { resolveAppPaths } from '../infra/paths';
import { isTokenSubprotocolSafe, systemServices } from '../infra/system';
import { ensureAuthToken } from './authToken';
import { createHttpServer } from './httpServer';
import { createStreamSigner, type StreamSigner } from './streamUrl';

/** Editors save a file in several syscalls; each one raises its own event. */
const CONFIG_WATCH_DEBOUNCE_MS = 250;

/** How long a graceful shutdown gets before the process is killed anyway. */
const FORCE_EXIT_TIMEOUT_MS = 5000;

/**
 * `SIGBREAK` is Windows' own, raised by Ctrl+Break, and it is the only one of
 * these besides `SIGINT` that a Windows console actually delivers to a handler;
 * the rest terminate the process outright there. Registering a signal the host
 * never raises costs nothing, so the list is the same on every platform.
 */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGQUIT',
  'SIGBREAK',
];

const LOG_SCOPE = 'server.web';

/**
 * Watches a single file. This lives in the entry point rather than in a domain
 * module because it is an effect: composition roots are where `node:fs` is
 * allowed, and a host that wants no watcher simply omits this.
 */
const watchFile = (path: string, onChange: () => void): (() => void) => {
  const pending = createStore<NodeJS.Timeout | null>(null);

  try {
    const watcher = watch(path, () => {
      const timer = pending.get();
      if (timer !== null) clearTimeout(timer);
      pending.set(
        setTimeout(() => {
          pending.set(null);
          onChange();
        }, CONFIG_WATCH_DEBOUNCE_MS),
      );
    });

    // An FSWatcher is an EventEmitter, so an unhandled 'error' is a throw that
    // no try/catch around the constructor can reach: the config file being
    // renamed or its volume disappearing would have taken the whole server down
    // long after startup, and with it the unsaved queue.
    watcher.on('error', () => {
      watcher.close();
    });

    return () => {
      const timer = pending.get();
      if (timer !== null) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    // An unwatchable config file is not worth refusing to start over; the app
    // simply keeps the configuration it loaded.
    return () => {};
  }
};

/**
 * Browsers cannot read the transcode off disk, so every video is located as a
 * URL on the stream route. The name is a query parameter rather than a path
 * segment because transcodes are named by opaque ids that a path would have to
 * escape twice.
 */
const toStreamLocation = (
  video: PreprocessedVideo,
  signer: StreamSigner,
  nowMs: number,
): VideoLocation =>
  // The single place stream URLs are built, which is why the signature goes on
  // here: every client, on every transport, gets an authorised URL without
  // knowing that authorisation happened.
  httpLocation(`${HTTP_ROUTES.videoStream}?${signer.sign(basename(video.processedPath), nowMs)}`);

/**
 * `url` carries the access token; `safeUrl` is the same address without it.
 *
 * The two are separate arguments rather than one, because the token has to
 * reach the browser and must not reach the log. Handing this function a single
 * URL is how that mistake would be made.
 */
const scheduleBrowserOpen = (
  logger: Logger,
  url: string,
  safeUrl: string,
  delayMs: number,
): void => {
  setTimeout(() => {
    // A launcher that is missing reports it asynchronously, so the outcome is
    // awaited rather than returned; failing to open a browser is never a reason
    // to stop serving, hence the warning and the fallback line.
    void openInBrowser(url).then((opened) => {
      if (opened.ok) {
        logger.info(`opened a browser at ${safeUrl}`);
        return;
      }
      logger.warn(
        `could not open a browser automatically, visit ${safeUrl} with your access token - ` +
          opened.error.message,
      );
    });
  }, delayMs);
};

/**
 * Last-resort handlers.
 *
 * Node ends the process on an unhandled rejection, and this server is one long
 * chain of `void`-ed background work: a queue fill, a periodic save, a browser
 * launch. Electron's entry point has always installed these; the web one had
 * nothing, so a single unexpected rejection anywhere killed the server without
 * a line in the log to say why.
 */
const installProcessHandlers = (logger: Logger): void => {
  process.on('uncaughtException', (thrown: unknown) => {
    logger.error('uncaught exception', thrown);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', reason);
  });
};

const main = async (): Promise<void> => {
  // dist/server/web at runtime: the repo root is three levels up and the built
  // web client sits beside this bundle under dist/client/web.
  const distDirectory = resolve(__dirname, '..', '..');
  // User data follows the working directory, as it always has; the shipped
  // defaults are read from wherever the compiled bundle lives.
  const workingDirectory = process.cwd();
  const installDirectory = resolve(distDirectory, '..');
  const clientDirectory = resolve(distDirectory, 'client', 'web');

  // The configured log level cannot filter the load that discovers it, so the
  // config is read at the built-in default level. Nothing is listening yet, so
  // no client misses an entry by being told about it a moment later.
  const bootstrap = createServerLogging({
    scope: LOG_SCOPE,
    minLevel: DEFAULT_CONFIG.system.logLevel,
  });

  const configService = await createConfigService({
    fileSystem: nodeFileSystem,
    paths: resolveAppPaths({ workingDirectory, installDirectory }),
    logger: bootstrap.logger,
    watchFile,
  });

  let config = configService.current();
  const paths = resolveAppPaths({
    workingDirectory,
    installDirectory,
    directories: config.system,
  });
  const logging = createServerLogging({ scope: LOG_SCOPE, minLevel: config.system.logLevel });
  const logger = logging.logger;

  installProcessHandlers(logger);
  logger.info('starting the VideoJuke web server');

  // Read, rather than merely validated. The setting was documented and
  // normalised and then ignored, so a user who turned the server off got one
  // anyway; the honest answer to "enabled: false" is not to listen. Checked
  // before the token is minted, so refusing to run cannot leave a generated
  // secret behind in the config of someone who asked for no server at all.
  if (!config.network.server.enabled) {
    logger.error(
      `network.server.enabled is false in ${paths.configFile}, so there is nothing to serve`,
    );
    process.exit(1);
  }

  // Before anything is served. The server has no other authentication, it hands
  // out the path of every video in the library, and it is routinely bound to
  // 0.0.0.0 so a TV can reach it.
  const token = await ensureAuthToken({
    fileSystem: nodeFileSystem,
    paths,
    logger,
    configured: config.network.server.authToken,
    newSecret: systemServices.newSecret,
  });
  if (!token.ok) {
    logger.error('refusing to start without an access token', token.error);
    process.exit(1);
  }
  // So the in-memory configuration agrees with the file we just wrote. Safe
  // here and only here: the config watcher is installed by `session.start`,
  // which has not run yet, so this cannot reload itself in a loop. The local
  // binding is refreshed too, or the rest of this function would keep reading
  // the pre-reload object.
  if (config.network.server.authToken.trim() === '') {
    await configService.reload();
    config = configService.current();
  }

  // A hand-edited token can contain characters a WebSocket subprotocol may not.
  // The transport survives it - the socket throws and it falls back to polling -
  // but silently, so it is worth one line here rather than a mystery later.
  if (!isTokenSubprotocolSafe(token.value)) {
    logger.warn(
      'the configured access token contains characters a WebSocket cannot carry, ' +
        'so browser clients will poll instead of receiving live updates. ' +
        'Use letters and digits.',
    );
  }

  const streamSigner = createStreamSigner({
    secret: token.value,
    lifetimeMs: config.timeouts.streamUrlLifetime,
  });

  const session = createSession({
    configService,
    fileSystem: nodeFileSystem,
    media: createMediaToolkit({ logger: logger.child('ffmpeg') }),
    paths,
    clock: systemClock,
    logging,
    system: systemServices,
  });

  const shuttingDown = createStore(false);

  // Declared before the server it closes because the three are a cycle: the
  // service needs a way to ask for a shutdown, the server needs the service,
  // and the shutdown needs the server. Nothing calls it until all three exist.
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown.get()) {
      logger.debug(`ignoring ${reason}: a shutdown is already in progress`);
      return;
    }
    shuttingDown.set(true);
    logger.info(`shutting down: ${reason}`);

    const forceExit = setTimeout(() => {
      logger.error('the shutdown did not finish in time, exiting anyway');
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_MS);

    try {
      // Sockets first: once no request can arrive, the queue and history the
      // session writes out cannot change underneath the save.
      await webServer.close();
      await session.shutdown();
    } catch (thrown) {
      logger.error('the shutdown failed', thrown);
    }

    clearTimeout(forceExit);
    process.exit(0);
  };

  const service = createPlayerService(session, {
    locate: (video) => toStreamLocation(video, streamSigner, systemClock.now()),
    now: systemClock.now,
    onShutdownRequest: () => {
      void shutdown('a client requested shutdown');
    },
  });

  const webServer = createHttpServer({
    service,
    session,
    logging,
    logger,
    clientDirectory,
    tempDirectory: paths.tempDirectory,
    allowedOrigins: config.network.server.allowedOrigins,
    streamSigner,
    now: systemClock.now,
    authToken: token.value,
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  const { host, port, autoOpenBrowser } = config.network.server;

  await webServer.listen(host, port);

  const serverUrl = toServerUrl(host, port);
  // The token goes in the URL for this one hand-off only. The page takes it out
  // of the address bar immediately and keeps it in local storage, so it is not
  // left sitting in history or sent on as a referrer.
  const enrolUrl = `${serverUrl}?${AUTH_TOKEN_PARAM}=${encodeURIComponent(token.value)}`;

  if (autoOpenBrowser) {
    scheduleBrowserOpen(logger, enrolUrl, serverUrl, config.timeouts.browserOpenDelay);
  } else {
    logger.info(`auto-open is off, visit ${serverUrl} with your access token to start watching`);
  }

  // Deliberately after listen: indexing and transcoding take minutes, and a
  // client that connects meanwhile watches the progress over the WebSocket
  // instead of being refused a connection.
  await session.start();
};

main().catch((thrown: unknown) => {
  // The logger is part of what may have failed to come up, so this one message
  // goes straight to the console.
  console.error(`VideoJuke failed to start: ${toError(thrown).message}`);
  process.exit(1);
});
