import { createConsoleSink, createLogger } from '../../shared/logging/logger';
import { systemClock } from '../../shared/time/clock';
import { attempt } from '../../shared/types/result';
import { createPlayerApp } from '../core/app/playerApp';
import { queryPlayerElements } from '../core/dom/elements';
import { attachKeyboardControls } from '../core/input/keyboard';
import { createHttpTransport } from '../core/transport/httpTransport';
import { createLoadingScreen } from '../core/ui/loadingScreen';
import { createConnectionIndicator } from '../core/ui/connectionIndicator';
import {
  MISSING_TOKEN_MESSAGE,
  REJECTED_TOKEN_MESSAGE,
  resolveAccessToken,
  resolveScreenRole,
} from './accessToken';
import { toScreenRole } from '../core/app/playerApp';
import { isUnauthorizedError } from '../core/transport/httpTransport';

const logger = createLogger({
  scope: 'client.web',
  minLevel: 'info',
  sink: createConsoleSink(console),
  now: systemClock.nowIso,
});

const start = (): void => {
  const resolved = attempt(() => queryPlayerElements(document));
  if (!resolved.ok) {
    logger.error('the page is missing an element the player needs', resolved.error);
    // Nothing on the page can be trusted to exist, so the message replaces it.
    document.body.textContent = resolved.error.message;
    return;
  }

  const elements = resolved.value;
  const origin = window.location.origin;

  const token = resolveAccessToken();
  if (token.value === null) {
    // Nothing else can be attempted without it: every API call would be refused,
    // so say so once on the screen the viewer is already looking at.
    logger.error(MISSING_TOKEN_MESSAGE);
    const screen = createLoadingScreen({ elements, logger: logger.child('loading') });
    screen.show();
    screen.showError(MISSING_TOKEN_MESSAGE);
    return;
  }

  // The badge reports the transport's own view of the connection, which is the
  // half the application never sees: a socket that never opened still leaves a
  // perfectly usable polling client behind it.
  const indicator = createConnectionIndicator(elements.connectionStatus);

  const transport = createHttpTransport({
    baseUrl: origin,
    logger: logger.child('http'),
    // The request deadline is `timeouts.connectionTimeout`, which the transport
    // takes from the configuration it fetches for itself.
    useWebSocket: true,
    authToken: token.value,
    onConnectionChange: indicator.set,
  });

  const app = createPlayerApp({
    api: transport,
    logger: logger.child('app'),
    elements,
    origin,
    // A browser refuses to play sound until the viewer has asked for it, so the
    // first video loads paused behind the start button.
    startMode: 'await-gesture',
    role: toScreenRole(resolveScreenRole()),
    onExit: () => {
      // A tab a script did not open will refuse to close. That is the browser's
      // decision to make, and there is nothing else "quit" can mean here.
      logger.info('closing the window');
      window.close();
    },
  });

  const detachKeyboard = attachKeyboardControls({
    target: document,
    dispatch: app.dispatch,
    logger: logger.child('keyboard'),
  });

  window.addEventListener('beforeunload', () => {
    detachKeyboard();
    // Order matters: stopping the app mirrors the playback queue to the server,
    // which needs the transport still open to send it.
    app.stop();
    transport.close();
  });

  // The reason is already on the loading screen: `start` puts it there before
  // it returns, because it is the only part of the app the viewer can see.
  void app.start().then((started) => {
    if (started.ok) return;

    // A rejected token is not a transient failure and retrying cannot fix it.
    // Forgetting it means the next load asks for a new one instead of failing
    // the same way forever.
    if (isUnauthorizedError(started.error)) {
      token.clear();
      logger.error(REJECTED_TOKEN_MESSAGE);
      return;
    }
    logger.error('the player did not start', started.error);
  });
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
