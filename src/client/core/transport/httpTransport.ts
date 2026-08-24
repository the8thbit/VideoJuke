import { DEFAULT_CONFIG } from '../../../shared/config/defaults';
import { createStore } from '../../../shared/state/store';
import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import {
  AUTH_SCHEME,
  HTTP_ROUTES,
  WEBSOCKET_SUBPROTOCOL,
  type LeaderSnapshot,
  type PlayerApi,
  type ServerEvent,
  type Unsubscribe,
} from '../../../shared/types/protocol';
import { attempt, attemptAsync } from '../../../shared/types/result';
import type { DetailedStats, ServiceStatus } from '../../../shared/types/status';
import type { PlayableVideo } from '../../../shared/types/video';
import { removeAt } from '../../../shared/util/arrays';
import { isPlainObject, readProperty } from '../../../shared/util/objects';
import type { ConnectionState } from '../ui/connectionIndicator';

export interface HttpTransportOptions {
  /** Origin the server is reachable at, without a trailing slash. */
  readonly baseUrl: string;
  readonly logger: Logger;
  /** False on webOS, whose WebSocket stack cannot be relied on. */
  readonly useWebSocket: boolean;
  /** The shared secret; the server refuses every request without it. */
  readonly authToken: string;
  readonly onConnectionChange?: (state: ConnectionState) => void;
}

export interface HttpTransport extends PlayerApi {
  /** Closes the socket and drops every subscriber. */
  readonly close: () => void;
}

type HttpMethod = 'GET' | 'POST';

/**
 * One exchange, reduced to what this transport actually reads.
 *
 * `Response` used to be the currency here, which quietly made `fetch` a
 * requirement. It also made the deadline cover only the headers: the timer was
 * cleared as soon as `fetch` resolved, and `response.json()` - which is where
 * the body is actually read - ran with no deadline at all, so a server that
 * answered and then stalled mid-body hung the caller forever.
 */
interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly timeoutMs: number;
}

/**
 * Whether this engine can do the `fetch` path at all.
 *
 * webOS is the reason. The TV client is compiled to ES5 and installs polyfills
 * for the ES2015 *library*, but `AbortController` arrived in Chromium 66 and the
 * TVs this app targets predate it. Reaching for it unguarded meant the very
 * first request threw `AbortController is not defined`, and the only transport
 * the TV has never completed a single call.
 */
const canFetch = (): boolean =>
  typeof fetch === 'function' && typeof AbortController === 'function';

const fetchExchange = async (request: HttpRequest): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    // Inside the deadline on purpose: aborting also aborts a body that has
    // started but will not finish.
    const body = await response.text();
    return { status: response.status, body };
  } catch (thrown) {
    // An abort surfaces as a generic DOMException, so the deadline is named
    // here instead of being left for the caller to infer from the message.
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${request.timeoutMs}ms`);
    }
    throw thrown as Error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The fallback for engines without `fetch` or `AbortController`. `XMLHttpRequest`
 * has carried its own `timeout` since long before either, which is exactly the
 * deadline this transport needs.
 */
const xhrExchange = (request: HttpRequest): Promise<HttpResponse> =>
  new Promise<HttpResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url, true);
    xhr.timeout = request.timeoutMs;

    for (const name of Object.keys(request.headers)) {
      const value = request.headers[name];
      if (value !== undefined) xhr.setRequestHeader(name, value);
    }

    xhr.onload = () => {
      resolve({ status: xhr.status, body: xhr.responseText });
    };
    xhr.ontimeout = () => {
      reject(new Error(`timed out after ${request.timeoutMs}ms`));
    };
    xhr.onerror = () => {
      // XHR deliberately withholds the reason for a network failure.
      reject(new Error('the request could not be sent'));
    };
    xhr.onabort = () => {
      reject(new Error('the request was aborted'));
    };

    xhr.send(request.body);
  });

const exchange = (request: HttpRequest): Promise<HttpResponse> =>
  canFetch() ? fetchExchange(request) : xhrExchange(request);

type ServerEventListener = (event: ServerEvent) => void;

/**
 * The name a rejected credential fails under, so an entry point can tell "your
 * token is wrong" apart from "the server is down" and ask for a new one instead
 * of retrying forever.
 */
const UNAUTHORIZED_NAME = 'UnauthorizedError';

export const isUnauthorizedError = (error: Error): boolean => error.name === UNAUTHORIZED_NAME;

const acceptJson = (token: string): Readonly<Record<string, string>> => ({
  Accept: 'application/json',
  Authorization: `${AUTH_SCHEME} ${token}`,
});

const sendJson = (token: string): Readonly<Record<string, string>> => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `${AUTH_SCHEME} ${token}`,
});

/**
 * The deadline every request runs on until the configuration has been read.
 *
 * This transport is what fetches the configuration, so `connectionTimeout` is
 * not knowable when it is constructed. Of the two ways out - asking the caller
 * for a function that answers the deadline later, or updating the deadline once
 * the configuration arrives - the second is simpler here, because the caller
 * has no way to learn the value either: it would have to fetch the config a
 * second time to answer. The transport already reads the config on `getConfig`,
 * so it adopts the deadline from that one response and the entry points stay
 * out of it. Only this bootstrap window, and the socket handshake that starts
 * with it, run on the shipped default.
 */
const BOOTSTRAP_TIMEOUT_MS = DEFAULT_CONFIG.timeouts.connectionTimeout;

/**
 * `ensurePlayable` cannot share the flat request deadline: the server runs a
 * full ffprobe and transcode inline before answering, plus whatever pause CPU
 * limiting inserts. Aborting at `connectionTimeout` left the server finishing
 * the work and discarding the answer while the viewer was told "previous"
 * failed, so this route gets room for an entire transcode instead.
 */
const ENSURE_PLAYABLE_TIMEOUT_MS = 300000;

/**
 * Swaps the scheme rather than replacing the first "http" anywhere in the
 * string, which is what the legacy client did: a base URL whose host happened
 * to contain "http" was rewritten in the middle and the socket never opened.
 */
const toWebSocketUrl = (baseUrl: string): string => {
  if (baseUrl.indexOf('https://') === 0) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.indexOf('http://') === 0) return `ws://${baseUrl.slice('http://'.length)}`;
  // Already a ws/wss URL, or something the socket constructor can judge better.
  return baseUrl;
};

/**
 * A shallow shape check rather than a full decode: these frames are built by
 * our own server from typed values, so the realistic failure is a frame from a
 * newer server carrying a variant this client has never heard of.
 */
const parseServerEvent = (raw: unknown): ServerEvent | null => {
  if (typeof raw !== 'string') return null;

  const parsed = attempt(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) return null;

  const payload = parsed.value;
  const type = readProperty(payload, 'type');
  if (type === 'initialization' && isPlainObject(readProperty(payload, 'state'))) {
    return payload as ServerEvent;
  }
  if (type === 'log' && isPlainObject(readProperty(payload, 'entry'))) {
    return payload as ServerEvent;
  }
  // The third variant, and the one this function used to drop on the floor: the
  // server broadcasts it on every publication and the app handles it, but the
  // frame never got past here, so the socket's whole reason for existing on a
  // follower - hearing about a video change before the next poll - did not work
  // over HTTP and produced an "unrecognised frame" line a second instead.
  if (type === 'leader-state' && isPlainObject(readProperty(payload, 'state'))) {
    return payload as ServerEvent;
  }
  return null;
};

/**
 * The browser half of `PlayerApi`: requests over HTTP, server events over one
 * WebSocket.
 *
 * The socket is an optimisation, never a requirement. Every screen this
 * transport drives also polls `getStatus`, so a client that cannot open a
 * socket is degraded (it learns about progress a poll later) rather than
 * broken, and it reports itself as connected on that basis. The legacy client
 * reached the same conclusion in five separate error handlers, each with its
 * own copy of the fake-connected assignment; here it is one function.
 */
export const createHttpTransport = (options: HttpTransportOptions): HttpTransport => {
  const { baseUrl, logger, useWebSocket, authToken, onConnectionChange } = options;

  // Raised to the configured deadline by `getConfig`; see BOOTSTRAP_TIMEOUT_MS.
  const requestTimeoutMs = createStore(BOOTSTRAP_TIMEOUT_MS);
  const listeners = createStore<readonly ServerEventListener[]>([]);
  const socket = createStore<WebSocket | null>(null);
  const openDeadline = createStore<ReturnType<typeof setTimeout> | null>(null);
  // Null until something has been reported, so the first report always fires.
  const connection = createStore<ConnectionState | null>(null);
  const closed = createStore(false);

  const reportConnection = (next: ConnectionState): void => {
    if (connection.get() === next) return;
    connection.set(next);
    logger.info(`connection ${next}`);
    if (onConnectionChange !== undefined) onConnectionChange(next);
  };

  /**
   * `timeoutMs` overrides the shared deadline for routes that are known to do
   * real work before they answer; everything else runs on the configured one.
   */
  const send = async (
    method: HttpMethod,
    route: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<HttpResponse> => {
    const deadlineMs = timeoutMs ?? requestTimeoutMs.get();
    const url = `${baseUrl}${route}`;

    logger.debug(`${method} ${route}`);
    const attempted = await attemptAsync(() =>
      exchange({
        method,
        url,
        headers: body === undefined ? acceptJson(authToken) : sendJson(authToken),
        body: body === undefined ? null : JSON.stringify(body),
        timeoutMs: deadlineMs,
      }),
    );

    if (!attempted.ok) {
      throw new Error(`${method} ${route} failed: ${attempted.error.message}`);
    }

    const response = attempted.value;
    if (response.status === 401) {
      const refused = new Error('the server rejected this access token');
      refused.name = UNAUTHORIZED_NAME;
      throw refused;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${method} ${route} failed with HTTP ${response.status}`);
    }

    logger.debug(`${method} ${route} answered ${response.status}`);
    return response;
  };

  const readJson = <TValue>(response: HttpResponse): TValue =>
    JSON.parse(response.body) as TValue;

  /**
   * 204 is this transport's spelling of `null`: it is how the server says there
   * is nothing to play, so an empty body is a value rather than a failure.
   */
  const readOptionalJson = <TValue>(response: HttpResponse): TValue | null =>
    response.status === 204 || response.body === '' ? null : (JSON.parse(response.body) as TValue);

  const command = async (route: string, body: unknown): Promise<void> => {
    await send('POST', route, body);
  };

  const deliver = (event: ServerEvent): void => {
    // The array is replaced rather than mutated on subscribe, so a listener
    // that unsubscribes mid-delivery cannot disturb this pass.
    listeners.get().forEach((listener) => {
      const attempted = attempt(() => listener(event));
      if (!attempted.ok) logger.error('a server event listener failed', attempted.error);
    });
  };

  const clearOpenDeadline = (): void => {
    const timer = openDeadline.get();
    if (timer === null) return;
    openDeadline.set(null);
    clearTimeout(timer);
  };

  /** The single place that decides the transport will live without a socket. */
  const fallBackToPolling = (reason: string): void => {
    clearOpenDeadline();

    const existing = socket.get();
    if (existing !== null) {
      socket.set(null);
      existing.close();
    }

    // A closed transport keeps its last reported state; nobody is listening.
    if (closed.get()) return;

    logger.debug(`websocket unavailable (${reason}); server events stop here`);
    reportConnection('connected');
  };

  const openSocket = (): void => {
    const url = toWebSocketUrl(baseUrl);
    // The credential rides in the subprotocol list, which is the only header a
    // browser lets a page set on an upgrade; the URL would leak it into logs.
    const created = attempt(() => new WebSocket(url, [WEBSOCKET_SUBPROTOCOL, authToken]));
    if (!created.ok) {
      fallBackToPolling(`cannot open ${url}: ${created.error.message}`);
      return;
    }

    const opened = created.value;
    socket.set(opened);
    reportConnection('connecting');

    // A socket has no deadline of its own, and a TV that silently swallows the
    // upgrade would otherwise leave the screen reading "Connecting..." forever.
    openDeadline.set(
      setTimeout(() => {
        openDeadline.set(null);
        if (socket.get() === opened && opened.readyState !== WebSocket.OPEN) {
          fallBackToPolling('handshake timed out');
        }
      }, requestTimeoutMs.get()),
    );

    opened.onopen = () => {
      clearOpenDeadline();
      reportConnection('connected');
    };

    opened.onmessage = (message) => {
      const event = parseServerEvent(message.data);
      if (event === null) {
        logger.debug('ignoring an unrecognised websocket frame');
        return;
      }
      deliver(event);
    };

    // There is deliberately no reconnect schedule. The legacy client had one,
    // but nothing ever called it: every handler fell through to HTTP-only mode
    // instead, which is the behaviour kept here.
    opened.onerror = () => {
      fallBackToPolling('socket error');
    };

    opened.onclose = () => {
      fallBackToPolling('socket closed');
    };
  };

  const subscribe = (listener: ServerEventListener): Unsubscribe => {
    listeners.update((current) => current.concat([listener]));
    return () => {
      // Removes one occurrence, so subscribing the same function twice and
      // cancelling once leaves the other subscription intact.
      listeners.update((current) => removeAt(current, current.indexOf(listener)).rest);
    };
  };

  const close = (): void => {
    if (closed.get()) return;
    closed.set(true);
    clearOpenDeadline();

    const existing = socket.get();
    if (existing !== null) {
      socket.set(null);
      // Detached before closing: close raises onclose, and a transport that is
      // shutting down has no business reporting a new connection state.
      existing.onopen = null;
      existing.onmessage = null;
      existing.onerror = null;
      existing.onclose = null;
      existing.close();
    }

    listeners.set([]);
    logger.info('http transport closed');
  };

  const transport: HttpTransport = {
    getConfig: async () => {
      const config = readJson<ClientConfig>(await send('GET', HTTP_ROUTES.config));
      // The deadline the rest of the session runs on is carried by this very
      // response, so it is adopted here rather than fetched a second time.
      requestTimeoutMs.set(config.timeouts.connectionTimeout);
      logger.debug(`request deadline is now ${config.timeouts.connectionTimeout}ms`);
      return config;
    },
    getStatus: async () => readJson<ServiceStatus>(await send('GET', HTTP_ROUTES.status)),
    getDetailedStats: async () =>
      readJson<DetailedStats>(await send('GET', HTTP_ROUTES.detailedStats)),

    takeNextVideo: async () =>
      readOptionalJson<PlayableVideo>(await send('GET', HTTP_ROUTES.nextVideo)),
    takePreviousVideo: async () =>
      readOptionalJson<PlayableVideo>(await send('GET', HTTP_ROUTES.previousVideo)),
    ensurePlayable: async (video) =>
      readOptionalJson<PlayableVideo>(
        await send('POST', HTTP_ROUTES.ensurePlayable, video, ENSURE_PLAYABLE_TIMEOUT_MS),
      ),

    recordVideoEnded: (video) => command(HTTP_ROUTES.videoEnded, video),
    recordVideoError: (message) => command(HTTP_ROUTES.videoError, { message }),
    // Wrapped, because express rejects a bare `null` body in strict mode and
    // these two routes accept "no video" as a legitimate argument.
    recordManualSkip: (video) => command(HTTP_ROUTES.manualSkip, { video }),
    recordReturnToPrevious: (video) => command(HTTP_ROUTES.returnToPrevious, { video }),

    syncPlaybackQueue: (videos) => command(HTTP_ROUTES.syncPlaybackQueue, { videos }),

    // The publication as it is declared, with the record under `video`. It used
    // to be flattened into the body as well, which `routes.ts` tolerated because
    // it prefers the wrapper - but it left the two transports sending different
    // shapes down the same protocol, and the IPC side had been written against
    // the flat one.
    publishLeaderState: (state) => command(HTTP_ROUTES.publishLeaderState, state),
    getLeaderState: async () =>
      readJson<LeaderSnapshot>(await send('GET', HTTP_ROUTES.getLeaderState)),
    locatePlayable: async (video) =>
      readOptionalJson<PlayableVideo>(await send('POST', HTTP_ROUTES.locatePlayable, video)),

    toggleArchiveFlag: async (video) => {
      const response = await send('POST', HTTP_ROUTES.toggleArchiveFlag, video);
      return readJson<{ readonly flagged: boolean }>(response).flagged;
    },

    requestShutdown: () => {
      // There is no shutdown route: a browser cannot stop a server it does not
      // own, so the nearest equivalent is closing the page. A tab that a script
      // did not open will refuse, which is the browser's decision to make.
      logger.info('shutdown requested; closing the window');
      window.close();
      return Promise.resolve();
    },

    subscribe,
    close,
  };

  logger.info(`http transport ready at ${baseUrl}`);
  if (useWebSocket) openSocket();
  else fallBackToPolling('disabled for this platform');

  return transport;
};
