import type { Logger } from '../../../shared/types/logging';
import { formatPercent } from '../../../shared/util/format';
import { clampFraction, lerp, ratio } from '../../../shared/util/numbers';
import { setClass, setText, type PlayerElements } from '../dom/elements';

export interface LoadingScreenDeps {
  readonly elements: PlayerElements;
  readonly logger: Logger;
}

export interface LoadingScreen {
  readonly show: () => void;
  readonly hide: () => void;
  readonly setMessage: (message: string) => void;
  /** Takes a 0..1 fraction, the same units the server's progress uses. */
  readonly setProgress: (fraction: number) => void;
  readonly showQueueProgress: (current: number, target: number) => void;
  readonly showError: (message: string) => void;
  readonly setStartEnabled: (enabled: boolean) => void;
  /** Registers a click handler; returns a function that removes it. */
  readonly onStart: (handler: () => void) => () => void;
}

const HIDDEN_CLASS = 'hidden';

/**
 * The loading screen is only up between Play and the first frame now - the
 * server's steps have their own bars on the start screen - so the client's
 * playback queue owns most of it, leaving the last 5% for the first video.
 */
const QUEUE_PROGRESS_FLOOR = 0;
const QUEUE_PROGRESS_CEILING = 0.95;

const noop = (): void => undefined;

export const createLoadingScreen = (deps: LoadingScreenDeps): LoadingScreen => {
  const { elements, logger } = deps;

  const setMessage = (message: string): void => {
    setText(elements.loadingSubtitle, message);
  };

  // The bar is the one place a fraction becomes a percentage. The legacy code
  // converted in its callers too, so a 0..1 progress arrived as "1%".
  const setProgress = (fraction: number): void => {
    elements.loadingProgress.style.width = formatPercent(fraction);
  };

  const setStartEnabled = (enabled: boolean): void => {
    const button = elements.startButton;
    if (button === null) return;
    button.disabled = !enabled;
  };

  return {
    show: () => {
      setClass(elements.loadingScreen, HIDDEN_CLASS, false);
      logger.debug('Loading screen shown');
    },

    /**
     * Only the class is touched. The legacy version also forced
     * `display: none` on a 500ms timer "in case CSS doesn't work", which made
     * the screen impossible to show again after a lost connection.
     */
    hide: () => {
      setClass(elements.loadingScreen, HIDDEN_CLASS, true);
      logger.debug('Loading screen hidden');
    },

    setMessage,
    setProgress,

    showQueueProgress: (current, target) => {
      const filled = clampFraction(ratio(current, target));
      setProgress(lerp(QUEUE_PROGRESS_FLOOR, QUEUE_PROGRESS_CEILING, filled));
      setMessage(`Building playback queue: ${current}/${target} videos`);
    },

    showError: (message) => {
      setMessage(`Error: ${message}`);
      setProgress(0);
      // The disabled style lives in the stylesheet; the legacy version wrote an
      // inline opacity here that nothing ever cleared.
      setStartEnabled(false);
      logger.warn(`Loading screen error: ${message}`);
    },

    setStartEnabled,

    onStart: (handler) => {
      const button = elements.startButton;
      // Only the browser client needs a gesture before it may play audio.
      if (button === null) return noop;

      const listener = (): void => handler();
      button.addEventListener('click', listener);
      return () => button.removeEventListener('click', listener);
    },
  };
};
