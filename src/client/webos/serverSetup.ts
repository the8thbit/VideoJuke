import { createStore } from '../../shared/state/store';
import type { Logger } from '../../shared/types/logging';
import { err, ok, type Result } from '../../shared/types/result';
import { clamp, parseNumber } from '../../shared/util/numbers';
import { requireElement, setClass, setText } from '../core/dom/elements';
import type { ServerAddress } from './storage';

export interface ServerSetupDeps {
  readonly root: Document;
  readonly logger: Logger;
}

export interface ServerSetup {
  /** Resolves once the viewer has confirmed an address that parses. */
  readonly show: (initial: ServerAddress | null) => Promise<ServerAddress>;
  readonly showError: (message: string) => void;
  readonly hide: () => void;
}

const HIDDEN_CLASS = 'hidden';
const VISIBLE_CLASS = 'visible';
const FOCUSED_CLASS = 'focused';

/** The remote reports its buttons through `keyCode` and nothing else. */
const KEY_OK = 13;
const KEY_UP = 38;
const KEY_DOWN = 40;

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Matches the placeholder in the markup, and the server's own default port. */
const DEFAULT_PORT = 3123;

/**
 * A hostname or an IPv4 address: letters, digits, dots and hyphens, beginning
 * and ending on something that is not punctuation. The legacy pattern allowed a
 * bare "." or "-", which produced a URL the TV could only fail to open.
 */
const HOST_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * The address form the TV shows before it knows where to connect.
 *
 * Only the form. The legacy config screen also owned the connection attempt,
 * the storage write, the error banner it created in JavaScript with an inline
 * style block, and a ten-second timer that hid that banner while the viewer was
 * still reading it. Here it collects an address and hands it back; the entry
 * point decides what to do with it, and the markup and stylesheet own the
 * banner.
 */
export const createServerSetup = (deps: ServerSetupDeps): ServerSetup => {
  const { root, logger } = deps;

  // Missing markup is a build problem, not a runtime condition to recover
  // from, so this throws the way `queryPlayerElements` does and the entry point
  // reports it once.
  const screen = requireElement(root, 'configScreen');
  const form = requireElement<HTMLFormElement>(root, 'configForm');
  const hostInput = requireElement<HTMLInputElement>(root, 'serverHost');
  const portInput = requireElement<HTMLInputElement>(root, 'serverPort');
  const tokenInput = requireElement<HTMLInputElement>(root, 'serverToken');
  const roleInput = requireElement<HTMLInputElement>(root, 'serverRole');
  const connectButton = requireElement<HTMLButtonElement>(root, 'connectButton');
  const errorElement = requireElement(root, 'configError');

  const focusable: readonly HTMLElement[] = [
    hostInput,
    portInput,
    tokenInput,
    roleInput,
    connectButton,
  ];
  const focusIndex = createStore(0);

  // Handles for listeners in flight; nothing outside this module observes them.
  let detachListeners: (() => void) | null = null;

  const applyFocus = (index: number): void => {
    focusable.forEach((element, position) => {
      setClass(element, FOCUSED_CLASS, position === index);
    });
    const target = focusable[index];
    if (target !== undefined) target.focus();
  };

  const moveFocus = (delta: number): void => {
    const next = clamp(focusIndex.get() + delta, 0, focusable.length - 1);
    if (next === focusIndex.get()) return;
    focusIndex.set(next);
    applyFocus(next);
  };

  const clearError = (): void => {
    setClass(errorElement, VISIBLE_CLASS, false);
  };

  const showError = (message: string): void => {
    setText(errorElement, message);
    setClass(errorElement, VISIBLE_CLASS, true);
    logger.warn(`server setup: ${message}`);
  };

  const detach = (): void => {
    if (detachListeners === null) return;
    detachListeners();
    detachListeners = null;
  };

  const readAddress = (): Result<ServerAddress, string> => {
    const host = hostInput.value.trim();
    if (host === '') return err('Enter the address of the computer running VideoJuke');
    if (!HOST_PATTERN.test(host)) return err('That is not a valid hostname or IP address');

    // Checked before the port so the viewer is told about the field they have
    // most likely skipped, rather than about a port they left blank on purpose.
    const token = tokenInput.value.trim();
    if (token === '') return err('Enter the access token the server printed when it started');

    // Blank is a screen that plays on its own, which is what most are.
    const role = roleInput.value.trim().toLowerCase();
    if (role !== '' && role !== 'leader' && role !== 'follower') {
      return err('The screen role must be leader, follower, or left blank');
    }

    // An empty port means the default, which is what the placeholder shows.
    const portText = portInput.value.trim();
    if (portText === '') return ok({ host, port: DEFAULT_PORT, token, role });

    const port = parseNumber(portText);
    if (port === null || port !== Math.round(port) || port < MIN_PORT || port > MAX_PORT) {
      return err(`The port must be a whole number between ${MIN_PORT} and ${MAX_PORT}`);
    }
    return ok({ host, port, token, role });
  };

  const show = (initial: ServerAddress | null): Promise<ServerAddress> =>
    new Promise((resolve) => {
      // A form shown twice without being answered would otherwise leave the
      // first set of listeners behind, and both would act on one key press.
      detach();

      hostInput.value = initial === null ? '' : initial.host;
      portInput.value = initial === null ? '' : String(initial.port);
      tokenInput.value = initial === null ? '' : initial.token;
      roleInput.value = initial === null ? '' : initial.role;
      setClass(screen, HIDDEN_CLASS, false);
      focusIndex.set(0);
      applyFocus(0);

      const confirm = (): void => {
        clearError();
        const address = readAddress();
        if (!address.ok) {
          showError(address.error);
          return;
        }
        detach();
        logger.info(`server address set to ${address.value.host}:${address.value.port}`);
        resolve(address.value);
      };

      // A pointer, where there is one: the remote never reaches this, because
      // the OK handler below swallows the key press that would submit.
      const onSubmit = (event: Event): void => {
        event.preventDefault();
        confirm();
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        switch (event.keyCode) {
          case KEY_UP:
            event.preventDefault();
            moveFocus(-1);
            return;

          case KEY_DOWN:
            event.preventDefault();
            moveFocus(1);
            return;

          case KEY_OK:
            event.preventDefault();
            if (focusIndex.get() === focusable.length - 1) confirm();
            else moveFocus(1);
            return;

          default:
            // Left and right move the caret inside a text field, and Back is
            // the platform's to answer: this form has no opinion about how the
            // app exits.
            return;
        }
      };

      root.addEventListener('keydown', onKeyDown);
      form.addEventListener('submit', onSubmit);
      detachListeners = () => {
        root.removeEventListener('keydown', onKeyDown);
        form.removeEventListener('submit', onSubmit);
      };
      logger.debug('server setup shown');
    });

  return {
    show,
    showError,
    hide: () => {
      detach();
      clearError();
      setClass(screen, HIDDEN_CLASS, true);
      logger.debug('server setup hidden');
    },
  };
};
