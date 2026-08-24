import type { IncomingMessage, Server } from 'http';

import { WebSocket, WebSocketServer } from 'ws';

import type { Logger } from '../../shared/types/logging';
import { WEBSOCKET_SUBPROTOCOL, type ServerEvent } from '../../shared/types/protocol';
import { signaturesMatch } from '../infra/system';

export interface WebSocketHubOptions {
  readonly server: Server;
  readonly logger: Logger;
  /** Sent to a client the moment it connects, so it never starts out blind. */
  readonly initialEvent: () => ServerEvent;
  /** The shared secret, presented as the second WebSocket subprotocol. */
  readonly authToken: string;
}

export interface WebSocketHub {
  readonly broadcast: (event: ServerEvent) => void;
  readonly close: () => Promise<void>;
}

/** 1001 "going away" is the close code for a server that is shutting down. */
const GOING_AWAY = 1001;

/** How long a client gets to answer the closing handshake before it is cut. */
const CLOSE_GRACE_MS = 1000;

/**
 * How often each client is pinged, and how long it has to answer.
 *
 * A TV that leaves the network, or a laptop that sleeps, never sends a close
 * frame. Its socket stays `OPEN` as far as this process is concerned, so it is
 * never removed from the set and every broadcast - every log line - is written
 * to it for as long as the server runs. The ping is what turns a peer that has
 * silently gone away into a `close` event.
 */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * The server-to-client half of `PlayerApi`, over one WebSocket per client.
 *
 * Every frame is a {@link ServerEvent} serialised as JSON. The legacy hub sent
 * an ad-hoc `{ type, data }` envelope whose `data` meant something different
 * per type, so the client had to know each variant's shape by name; the
 * discriminated union carries that knowledge in the type system instead.
 */
/**
 * Reads the token a client offered as its second subprotocol.
 *
 * A browser's `WebSocket` constructor cannot set headers, so the one field it
 * *can* influence is the subprotocol list - `new WebSocket(url, [name, token])`
 * puts both into `Sec-WebSocket-Protocol`. That keeps the secret in a header
 * rather than in the URL, where it would land in logs and history the way the
 * stream signature deliberately does not.
 */
const offeredToken = (header: string | undefined): string | null => {
  if (typeof header !== 'string') return null;
  const offered = header.split(',').map((entry) => entry.trim());
  if (offered[0] !== WEBSOCKET_SUBPROTOCOL) return null;
  const token = offered[1];
  return token === undefined || token === '' ? null : token;
};

export const createWebSocketHub = ({
  server,
  logger,
  initialEvent,
  authToken,
}: WebSocketHubOptions): WebSocketHub => {
  const sockets = new Set<WebSocket>();
  const hub = new WebSocketServer({
    server,
    // Only the name is echoed back. Returning the token would put it in a
    // response header for no reason.
    handleProtocols: () => WEBSOCKET_SUBPROTOCOL,
    verifyClient: ({ req }: { readonly req: IncomingMessage }) => {
      const presented = offeredToken(req.headers['sec-websocket-protocol']);
      if (presented !== null && signaturesMatch(presented, authToken)) return true;
      logger.warn('refused an unauthenticated websocket upgrade');
      return false;
    },
  });

  /**
   * Deliberately silent, and deliberately swallows the send error.
   *
   * Log entries are themselves broadcast as events, so a logger call on this
   * path would produce an entry, which would be broadcast, which would fail
   * again: one dead socket would spin forever. The empty callback also keeps ws
   * from raising `error` synchronously mid-broadcast; a socket that is really
   * gone still reaches the `close` handler and leaves the set there.
   */
  const send = (socket: WebSocket, payload: string): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(payload, () => {});
  };

  /** Sockets that have not answered the ping sent on the previous tick. */
  const awaitingPong = new Set<WebSocket>();

  hub.on('connection', (socket) => {
    // Sent before the socket joins the set so that the first frame a client
    // sees is always the current state, never a log line that preceded it.
    send(socket, JSON.stringify(initialEvent()));
    sockets.add(socket);

    socket.on('pong', () => {
      awaitingPong.delete(socket);
    });

    socket.on('close', () => {
      sockets.delete(socket);
      awaitingPong.delete(socket);
      logger.debug(`client disconnected, ${sockets.size} remaining`);
    });

    socket.on('error', (error) => {
      sockets.delete(socket);
      awaitingPong.delete(socket);
      logger.warn(`client socket failed: ${error.message}`);
    });

    logger.debug(`client connected, ${sockets.size} total`);
  });

  const heartbeat = setInterval(() => {
    for (const socket of Array.from(sockets)) {
      if (awaitingPong.has(socket)) {
        // Missed the whole of the last interval: the peer is gone. `terminate`
        // raises `close`, which is what removes it from the set.
        logger.debug('terminating a client that stopped answering pings');
        awaitingPong.delete(socket);
        socket.terminate();
        continue;
      }
      if (socket.readyState !== WebSocket.OPEN) continue;
      awaitingPong.add(socket);
      // The empty callback keeps ws from raising `error` synchronously here, as
      // it would on a socket that has just died.
      socket.ping(undefined, undefined, () => {});
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Nothing else in the process should be held open by this timer.
  heartbeat.unref?.();

  hub.on('error', (error) => {
    logger.error('websocket server error', error);
  });

  const broadcast = (event: ServerEvent): void => {
    if (sockets.size === 0) return;
    const payload = JSON.stringify(event);
    // Copied first: a failed send removes its socket from the live set.
    for (const socket of Array.from(sockets)) {
      send(socket, payload);
    }
  };

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      const closing = Array.from(sockets);
      sockets.clear();
      awaitingPong.clear();
      for (const socket of closing) {
        socket.close(GOING_AWAY, 'server shutting down');
      }

      // ws reports the hub closed only once the last client has gone, and a
      // client that never answers the closing handshake would hold it there for
      // the full 30 second protocol timeout, so the deadline is enforced here.
      const grace = setTimeout(() => {
        for (const socket of closing) {
          socket.terminate();
        }
      }, CLOSE_GRACE_MS);

      hub.close(() => {
        clearTimeout(grace);
        logger.info('websocket hub closed');
        resolve();
      });
    });

  return { broadcast, close };
};
