import { createServer, type Server } from 'http';

import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import type { Logger } from '../../shared/types/logging';
import { HTTP_ROUTES, type ServerEvent } from '../../shared/types/protocol';
import { toError } from '../../shared/types/result';
import type { PlayerService } from '../api/playerService';
import type { Session } from '../domain/session';
import type { ServerLogging } from '../infra/logger';
import { createApiAuth } from './apiAuth';
import { createPlayerRouter } from './routes';
import type { StreamSigner } from './streamUrl';
import { createVideoStreamHandler } from './videoStream';
import { createWebSocketHub } from './webSocketHub';

export interface HttpServerOptions {
  readonly service: PlayerService;
  readonly session: Session;
  readonly logging: ServerLogging;
  readonly logger: Logger;
  /** Built client assets, i.e. `dist/client/web`. */
  readonly clientDirectory: string;
  readonly tempDirectory: string;
  /** Cross-origin pages allowed to call the API; see `network.server`. */
  readonly allowedOrigins: readonly string[];
  /** Verifies the signature on a stream URL this server handed out. */
  readonly streamSigner: StreamSigner;
  readonly now: () => number;
  /** The shared secret every API request and WebSocket upgrade must present. */
  readonly authToken: string;
}

export interface HttpServer {
  readonly listen: (host: string, port: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * A synced playback queue carries full metadata for every entry, which the
 * 100kB default is not sized for. Still bounded, because the only bodies this
 * server accepts are queue mirrors and single video records.
 */
const JSON_BODY_LIMIT = '1mb';

/**
 * The web host: an Express app, the HTTP server under it, and the WebSocket hub
 * attached to that server. It owns no state of its own; the session is the
 * authority for everything it publishes.
 */
export const createHttpServer = (options: HttpServerOptions): HttpServer => {
  const { service, session, logging, logger, clientDirectory, tempDirectory } = options;
  const allowedOrigins = options.allowedOrigins;

  const app = express();
  app.use(
    cors({
      // Spelled out rather than reflected. Adding `Authorization` makes every
      // cross-origin request preflight for the first time - the webOS client
      // has only ever made simple ones - and `maxAge` keeps that from doubling
      // the TV's request count for the life of the session.
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
      /**
       * A request with no `Origin` is not a browser acting for a third-party
       * page - it is curl, a native client, or a same-origin navigation - so it
       * needs no header and gets none. Everything else has to be on the list.
       *
       * This is what stops a page on some unrelated site from driving a player
       * that has no authentication of any kind.
       */
      origin: (origin, callback) => {
        if (origin === undefined) {
          callback(null, false);
          return;
        }
        if (allowedOrigins.indexOf(origin) !== -1) {
          callback(null, origin);
          return;
        }
        logger.debug(`refused a cross-origin request from ${origin}`);
        callback(null, false);
      },
    }),
  );
  // strict:false accepts a bare `null` body, which is how the client says
  // "there was no video" on the endpoints whose payload is optional. The
  // default would reject it before any route handler saw it.
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: false }));

  // Per-request lines are debug detail. The legacy server logged every request
  // at info level, which buried the lifecycle events among thousands of them.
  app.use((request, _response, next) => {
    logger.debug(`${request.method} ${request.path}`);
    next();
  });

  // In front of the API and nothing else: the page, /health and the signed
  // stream route each answer for themselves. See `createApiAuth`.
  app.use('/api', createApiAuth({ token: options.authToken, logger: logger.child('auth') }));
  app.use(
    createPlayerRouter({ service, logger: logger.child('api'), videoPaths: session.videoPaths }),
  );
  app.get(
    HTTP_ROUTES.videoStream,
    createVideoStreamHandler({
      tempDirectory,
      logger: logger.child('videos'),
      signer: options.streamSigner,
      now: options.now,
    }),
  );

  // `index` makes this serve index.html at the root as well, so the client page
  // and its assets are one middleware rather than a static mount plus a
  // hand-written root route that could drift from it.
  app.use(express.static(clientDirectory, { index: 'index.html' }));

  /**
   * The last word on any error no route handled, which until now was Express's.
   *
   * `express.json` runs in front of the auth middleware - it has to, because the
   * routes behind it need a parsed body - so a malformed body is rejected by
   * body-parser before anything checks a credential. Express's default handler
   * answered that with an HTML page containing the full `SyntaxError` stack:
   * absolute install path, the operator's user name and the dependency layout,
   * to a caller that never presented a token. It also wrote the same stack
   * straight to stderr, around the application's own logger and its level.
   *
   * Four arguments, and `next` unused: that signature is how Express recognises
   * an error handler at all.
   */
  app.use(
    (error: unknown, request: Request, response: Response, _next: NextFunction): void => {
      const failure = toError(error);
      logger.error(`${request.method} ${request.path} was refused`, failure);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // The status body-parser chose (400 for bad JSON, 413 for too large) if it
      // set one, and never the message: the client needs the shape, not the
      // stack.
      const status = (error as { readonly status?: unknown } | null)?.status;
      response
        .status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
        .json({ error: 'the request could not be processed' });
    },
  );

  const server: Server = createServer(app);

  // Registered permanently: an unhandled 'error' event on a server is a throw,
  // and post-listen failures (a dropped socket, EPIPE) must not take the
  // process down.
  server.on('error', (error) => {
    logger.error('http server error', error);
  });

  const hub = createWebSocketHub({
    server,
    logger: logger.child('websocket'),
    authToken: options.authToken,
    initialEvent: (): ServerEvent => ({
      type: 'initialization',
      state: session.initialization(),
    }),
  });

  const unsubscribes: readonly (() => void)[] = [
    session.onInitializationChange((state) => {
      hub.broadcast({ type: 'initialization', state });
    }),
    session.onLeaderStateChange((state) => {
      hub.broadcast({ type: 'leader-state', state });
    }),
    logging.subscribe((entry) => {
      hub.broadcast({ type: 'log', entry });
    }),
  ];

  const listen = (host: string, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        logger.info(`serving http://${host}:${port}`);
        resolve();
      });
    });

  const close = async (): Promise<void> => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
    await hub.close();

    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
      // A video stream and a WebSocket upgrade both hold their socket open
      // indefinitely, and close() waits for every open socket, so shutdown
      // would otherwise hang until the last viewer closed their tab.
      server.closeAllConnections();
    });

    logger.info('http server closed');
  };

  return { listen, close };
};
