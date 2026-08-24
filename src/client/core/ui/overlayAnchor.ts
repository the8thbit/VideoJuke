import { createStore } from '../../../shared/state/store';
import { setClass } from '../dom/elements';

/**
 * A near-invisible element pinned to the stage while any overlay is on screen.
 *
 * Some compositors drop the video layer out of the overlay's stacking context
 * unless something else is painted there, which made overlays flicker. The
 * legacy manager discovered when to paint it with a MutationObserver watching
 * the class and style attributes of the whole document, so every fade frame of
 * every overlay woke it up. Overlays now say when they need the anchor, which
 * is information they already have.
 */
export interface OverlayAnchor {
  /** Marks the anchor as needed and returns the matching release function. */
  readonly acquire: () => () => void;
  readonly isActive: () => boolean;
  readonly cleanup: () => void;
}

const ANCHOR_ID = 'overlayAnchor';
const ANCHOR_CLASS = 'overlay-anchor';
const ACTIVE_CLASS = 'active';

const noop = (): void => undefined;

export const createOverlayAnchor = (root: Document): OverlayAnchor => {
  const element = root.createElement('div');
  element.id = ANCHOR_ID;
  element.className = ANCHOR_CLASS;
  root.body.appendChild(element);

  const holders = createStore(0);
  let disposed = false;

  holders.subscribe((count) => {
    setClass(element, ACTIVE_CLASS, count > 0);
  });

  return {
    acquire: () => {
      if (disposed) return noop;
      holders.update((previous) => previous + 1);

      // One-shot latch: an overlay that hides twice must not release the hold
      // another overlay is still relying on.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders.update((previous) => (previous > 0 ? previous - 1 : 0));
      };
    },
    isActive: () => holders.get() > 0,
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      holders.set(0);
      if (element.parentNode !== null) element.parentNode.removeChild(element);
    },
  };
};
