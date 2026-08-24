import type { ClientConfig } from '../../../shared/types/config';
import type { Logger } from '../../../shared/types/logging';
import type { PreprocessedVideo } from '../../../shared/types/video';
import { formatVideoSummary } from '../../../shared/util/format';
import { setClass, setText, type PlayerElements } from '../dom/elements';
import type { OverlayAnchor } from './overlayAnchor';

export interface OverlaysDeps {
  readonly elements: PlayerElements;
  readonly config: ClientConfig;
  readonly anchor: OverlayAnchor;
  readonly logger: Logger;
}

export interface Overlays {
  readonly showVideoInfo: (
    video: PreprocessedVideo,
    options?: { readonly titleOnly?: boolean },
  ) => void;
  readonly showError: (message: string) => void;
  readonly showStatus: (icon: string) => void;
  /** Toggles the keyboard help panel and returns whether it is now visible. */
  readonly toggleControls: () => boolean;
  readonly cleanup: () => void;
}

const VISIBLE_CLASS = 'visible';

interface TimedOverlay {
  readonly show: (durationMs: number) => void;
  readonly hide: () => void;
}

/**
 * One overlay that fades itself out again.
 *
 * Each overlay owns its own timer. The legacy version queued a bare setTimeout
 * per call against a shared helper, so showing a second message while the first
 * was up left the first timeout running and it hid the new message early.
 */
const createTimedOverlay = (element: HTMLElement, anchor: OverlayAnchor): TimedOverlay => {
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let release: (() => void) | null = null;

  const clearHideTimer = (): void => {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const hide = (): void => {
    clearHideTimer();
    setClass(element, VISIBLE_CLASS, false);
    if (release !== null) {
      release();
      release = null;
    }
  };

  const show = (durationMs: number): void => {
    // Restarting the timer is the point: the message on screen now is the one
    // whose full duration the viewer is owed.
    clearHideTimer();
    if (release === null) release = anchor.acquire();
    setClass(element, VISIBLE_CLASS, true);
    if (durationMs > 0) hideTimer = setTimeout(hide, durationMs);
  };

  return { show, hide };
};

export const createOverlays = (deps: OverlaysDeps): Overlays => {
  const { elements, config, anchor, logger } = deps;

  const info = createTimedOverlay(elements.infoOverlay, anchor);
  const error = createTimedOverlay(elements.errorOverlay, anchor);
  const status = createTimedOverlay(elements.statusIndicator, anchor);

  // The controls panel stays up until it is toggled off, so it holds its
  // anchor acquisition rather than a timer.
  let controlsRelease: (() => void) | null = null;

  const hideControls = (): void => {
    const panel = elements.controlsOverlay;
    if (panel !== null) setClass(panel, VISIBLE_CLASS, false);
    if (controlsRelease !== null) {
      controlsRelease();
      controlsRelease = null;
    }
  };

  return {
    showVideoInfo: (video, options) => {
      const titleOnly = options?.titleOnly === true;
      setText(elements.videoTitle, video.filename);
      setText(elements.videoDetails, titleOnly ? '' : formatVideoSummary(video.metadata));
      info.show(titleOnly ? config.ui.tempInfoDuration : config.ui.infoDuration);
      logger.debug(`Info overlay: ${video.filename}${titleOnly ? ' (title only)' : ''}`);
    },

    showError: (message) => {
      if (!config.ui.showErrorToast) {
        logger.warn(`Error toast suppressed: ${message}`);
        return;
      }
      setText(elements.errorMessage, message);
      error.show(config.ui.errorDuration);
      logger.debug(`Error overlay: ${message}`);
    },

    showStatus: (icon) => {
      setText(elements.statusIcon, icon);
      status.show(config.timeouts.statusDisplayDuration);
    },

    toggleControls: () => {
      const panel = elements.controlsOverlay;
      if (panel === null) return false;

      if (controlsRelease !== null) {
        hideControls();
        logger.debug('Controls panel hidden');
        return false;
      }

      controlsRelease = anchor.acquire();
      setClass(panel, VISIBLE_CLASS, true);
      logger.debug('Controls panel shown');
      return true;
    },

    cleanup: () => {
      info.hide();
      error.hide();
      status.hide();
      hideControls();
    },
  };
};
