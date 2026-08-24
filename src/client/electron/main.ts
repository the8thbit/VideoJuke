import { createConsoleSink, createLogger } from '../../shared/logging/logger';
import { systemClock } from '../../shared/time/clock';
import { attempt } from '../../shared/types/result';
import { createPlayerApp, toScreenRole } from '../core/app/playerApp';
import { queryPlayerElements } from '../core/dom/elements';
import { attachKeyboardControls } from '../core/input/keyboard';
import { waitForIpcBridge } from '../core/transport/ipcTransport';
import { createLoadingScreen } from '../core/ui/loadingScreen';

/**
 * How long the renderer waits for `preload.ts` to install the context bridge.
 * The legacy client polled every 100ms with no deadline, so a preload that
 * failed to load left the page retrying for the life of the process behind a
 * spinner that never said anything was wrong.
 */
const BRIDGE_TIMEOUT_MS = 5000;
const BRIDGE_POLL_MS = 50;

const BRIDGE_MISSING_MESSAGE =
  'VideoJuke could not reach its own main process. Restart the application, and check the ' +
  'main process log if this happens again.';

const logger = createLogger({
  scope: 'client.electron',
  minLevel: 'info',
  sink: createConsoleSink(console),
  now: systemClock.nowIso,
});

const start = async (): Promise<void> => {
  const resolved = attempt(() => queryPlayerElements(document));
  if (!resolved.ok) {
    logger.error('the page is missing an element the player needs', resolved.error);
    // Nothing on the page can be trusted to exist, so the message replaces it.
    document.body.textContent = resolved.error.message;
    return;
  }

  const elements = resolved.value;
  const loadingScreen = createLoadingScreen({ elements, logger: logger.child('loading') });

  const api = await waitForIpcBridge({
    timeoutMs: BRIDGE_TIMEOUT_MS,
    pollMs: BRIDGE_POLL_MS,
    logger: logger.child('ipc'),
  });
  if (api === null) {
    logger.error(BRIDGE_MISSING_MESSAGE);
    loadingScreen.showError(BRIDGE_MISSING_MESSAGE);
    return;
  }

  const app = createPlayerApp({
    api,
    logger: logger.child('app'),
    elements,
    // Electron loads transcoded files straight off disk, so there is no origin
    // to resolve relative video URLs against.
    origin: null,
    // The renderer is not subject to a browser's autoplay policy.
    startMode: 'immediate',
    // Put here by the main process from `--role=`; see `createPlayerWindow`.
    role: toScreenRole(new URLSearchParams(window.location.search).get('role')),
    onExit: () => {
      void api.requestShutdown();
    },
  });

  const detachKeyboard = attachKeyboardControls({
    target: document,
    dispatch: app.dispatch,
    logger: logger.child('keyboard'),
  });

  // `stop` mirrors the playback queue to the server one last time, which is
  // what a restart resumes from. The legacy main process got that by reaching
  // into the renderer and evaluating `getQueueStateForPersistence()`.
  //
  // Best effort by construction: nothing in an unloading page can await an IPC
  // reply, so `stop` dispatches the mirror and returns without knowing whether
  // the server applied it. The main process gives this handler a bounded window
  // to run in (see `unloadPage` in server/electron/window.ts) before it takes
  // the page away, so a mirror that is slow to send may not arrive at all.
  window.addEventListener('beforeunload', () => {
    detachKeyboard();
    app.stop();
  });

  const started = await app.start();
  if (!started.ok) logger.error('the player did not start', started.error);
};

const run = (): void => {
  void start();
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
else run();
