import { createConsoleSink, createLogger } from '../../shared/logging/logger';
import { systemClock } from '../../shared/time/clock';
import { attempt, err, ok, type Result } from '../../shared/types/result';
import { createPlayerApp, toScreenRole } from '../core/app/playerApp';
import { queryPlayerElements, type PlayerElements } from '../core/dom/elements';
import { attachRemoteControls } from '../core/input/remoteControl';
import { createHttpTransport } from '../core/transport/httpTransport';
import { installPolyfills } from './polyfills';
import { createServerSetup } from './serverSetup';
import { createServerAddressStore, type ServerAddress } from './storage';

// Before any other statement in the bundle runs. Module bodies are evaluated
// ahead of this call, so nothing at module scope may rely on a polyfilled
// method; today nothing does, and every use is inside a function.
installPolyfills();

const logger = createLogger({
  scope: 'client.webos',
  minLevel: 'info',
  sink: createConsoleSink(console),
  now: systemClock.nowIso,
});

/** Hands control back to the launcher, which is what "quit" means on a TV. */
const exitApp = (): void => {
  const platform = window.webOS;
  if (platform !== undefined) {
    logger.info('returning to the webOS launcher');
    platform.platformBack();
    return;
  }
  window.close();
};

/**
 * Runs the player against one server address until it is done with it.
 *
 * Resolves with `ok` when the viewer asked to go back to the setup form, and
 * with `err` when the address never produced a working session. Either way the
 * transport, the app and the remote are torn down before the caller sees it,
 * so the next attempt starts from the same clean page.
 */
const runSession = (
  elements: PlayerElements,
  address: ServerAddress,
): Promise<Result<void, Error>> =>
  new Promise((resolve) => {
    const baseUrl = `http://${address.host}:${address.port}`;
    const transport = createHttpTransport({
      baseUrl,
      logger: logger.child('http'),
      // A TV on wifi at the far end of a house needs a longer deadline than a
      // browser on the same host, which is what `timeouts.connectionTimeout` is
      // for: the transport takes it from the configuration it already fetches.
      //
      // The TV's socket stack accepts an upgrade and then silently delivers
      // nothing. Every screen here polls anyway, so there is nothing to lose.
      useWebSocket: false,
      authToken: address.token,
    });

    let detachRemote: (() => void) | null = null;
    let finished = false;

    const finish = (outcome: Result<void, Error>): void => {
      // A failed start and a settings request can arrive for the same session.
      if (finished) return;
      finished = true;

      if (detachRemote !== null) detachRemote();
      app.stop();
      transport.close();
      resolve(outcome);
    };

    const app = createPlayerApp({
      api: transport,
      logger: logger.child('app'),
      elements,
      origin: baseUrl,
      // A TV app is the foreground application; there is no autoplay policy to
      // satisfy and no pointer to satisfy it with.
      startMode: 'immediate',
      role: toScreenRole(address.role),
      onExit: exitApp,
      onShowSettings: () => {
        finish(ok(undefined));
      },
    });

    detachRemote = attachRemoteControls({
      target: document,
      dispatch: app.dispatch,
      // The guide is the only useful answer to a button this app has no use
      // for, and the same press dismisses it again.
      onUnknownKey: () => {
        app.dispatch('toggle-controls');
      },
      logger: logger.child('remote'),
    });

    void app.start().then((started) => {
      if (!started.ok) finish(err(started.error));
    });
  });

const start = async (): Promise<void> => {
  const platform = window.webOS;
  if (platform === undefined) {
    logger.info('webOS is not present; running as a plain web page');
  } else {
    platform.deviceInfo((info) => {
      logger.debug(`webOS device ${info.modelName ?? 'unknown'} on ${info.version ?? 'unknown'}`);
    });
  }

  const prepared = attempt(() => ({
    elements: queryPlayerElements(document),
    setup: createServerSetup({ root: document, logger: logger.child('setup') }),
  }));
  if (!prepared.ok) {
    logger.error('the page is missing an element the client needs', prepared.error);
    // Nothing on the page can be trusted to exist, so the message replaces it.
    document.body.textContent = prepared.error.message;
    return;
  }

  const { elements, setup } = prepared.value;
  const store = createServerAddressStore(logger.child('storage'));
  let address = await store.load();

  // One address at a time, forever: a session that ends for any reason returns
  // to the form, which is the only screen this app can always show.
  for (;;) {
    if (address === null) address = await setup.show(null);

    const saved = await store.save(address);
    if (!saved) logger.warn('the server address could not be stored for next time');
    setup.hide();

    const outcome = await runSession(elements, address);
    if (!outcome.ok) {
      logger.error(`the session at ${address.host}:${address.port} ended`, outcome.error);
      setup.showError(outcome.error.message);
    }
    address = await setup.show(address);
  }
};

const run = (): void => {
  void start();
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
else run();
