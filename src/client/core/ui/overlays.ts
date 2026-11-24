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
  /**
   * Marks a favorite added or taken away: "Favorited" or "Unfavorited" in the
   * top right corner, and a half-transparent star in each of the other three,
   * gold for added and blue for removed, so the two cannot be mistaken for each
   * other without covering the video.
   */
  readonly showFavorite: (added: boolean) => void;
  /** Toggles the keyboard help panel and returns whether it is now visible. */
  readonly toggleControls: () => boolean;
  readonly cleanup: () => void;
}

const VISIBLE_CLASS = 'visible';

/** How long the favorite marks stay up: long enough to see, short enough not to linger. */
const FAVORITE_DISPLAY_MS = 1000;

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

  // Built here rather than in each client's page, so all three get it. The
  // status indicator's parent is the layer every overlay already lives in.
  const favoriteElement = (() => {
    const owner = elements.statusIndicator.ownerDocument;
    const box = owner.createElement('div');
    box.className = 'favorite-marks';
    box.setAttribute('aria-live', 'polite');
    const label = owner.createElement('div');
    label.className = 'favorite-label';
    box.appendChild(label);
    const corners = ['top-left', 'bottom-left', 'bottom-right'];
    for (let index = 0; index < corners.length; index += 1) {
      const star = owner.createElement('div');
      star.className = `favorite-star ${corners[index] as string}`;
      star.textContent = '★';
      box.appendChild(star);
    }
    const parent = elements.statusIndicator.parentNode ?? owner.body;
    parent.appendChild(box);
    return { box, label };
  })();
  const favorite = createTimedOverlay(favoriteElement.box, anchor);

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

    showFavorite: (added) => {
      setText(favoriteElement.label, added ? 'Favorited' : 'Unfavorited');
      setClass(favoriteElement.box, 'added', added);
      setClass(favoriteElement.box, 'removed', !added);
      favorite.show(FAVORITE_DISPLAY_MS);
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
      favorite.hide();
      hideControls();
    },
  };
};
