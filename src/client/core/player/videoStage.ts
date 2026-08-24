import { createStore } from '../../../shared/state/store';
import { setClass } from '../dom/elements';

/**
 * The pair of `<video>` elements and which one of them is on screen.
 *
 * The legacy player tracked this with a `currentPlayer` number and recomputed
 * "the other one" in four separate places, one of which went back to
 * `document.getElementById` and could therefore disagree with the other three.
 * Every answer about which element is active now comes from here.
 */
export interface VideoStage {
  /** The element currently on screen. */
  readonly active: () => HTMLVideoElement;
  /** The element being prepared off screen. */
  readonly idle: () => HTMLVideoElement;
  /** Promotes the idle element to active and returns it. */
  readonly swap: () => HTMLVideoElement;
  readonly both: () => readonly [HTMLVideoElement, HTMLVideoElement];
  readonly show: (element: HTMLVideoElement) => void;
  readonly hide: (element: HTMLVideoElement) => void;
  /** Full teardown of one element, so the decoder releases the file. */
  readonly release: (element: HTMLVideoElement) => void;
}

type StageIndex = 0 | 1;

const VISIBLE_CLASS = 'visible';

/**
 * A fade writes inline `opacity` and `filter`, which outrank the stylesheet.
 * Leaving them behind is what made a skipped transition strand an element at a
 * half-faded opacity, so every visibility change drops them.
 */
const clearFadeStyles = (element: HTMLVideoElement): void => {
  element.style.opacity = '';
  element.style.filter = '';
};

const otherIndex = (index: StageIndex): StageIndex => (index === 0 ? 1 : 0);

export const createVideoStage = (
  videos: readonly [HTMLVideoElement, HTMLVideoElement],
): VideoStage => {
  const activeIndex = createStore<StageIndex>(0);

  const elementAt = (index: StageIndex): HTMLVideoElement =>
    index === 0 ? videos[0] : videos[1];

  const show = (element: HTMLVideoElement): void => {
    clearFadeStyles(element);
    setClass(element, VISIBLE_CLASS, true);
  };

  const hide = (element: HTMLVideoElement): void => {
    setClass(element, VISIBLE_CLASS, false);
    clearFadeStyles(element);
  };

  const release = (element: HTMLVideoElement): void => {
    hide(element);
    element.pause();
    element.currentTime = 0;
    // `src = ''` resolves against the page URL, so the element keeps reporting a
    // source and fires a spurious error; removing the attribute leaves `src`
    // genuinely empty, which is what "has this element got content?" checks read.
    element.removeAttribute('src');
    // load() against the now-absent source is what actually makes the decoder
    // let go of the file; without it the temp file stays locked on Windows.
    element.load();
  };

  return {
    active: () => elementAt(activeIndex.get()),
    idle: () => elementAt(otherIndex(activeIndex.get())),
    swap: () => elementAt(activeIndex.update(otherIndex)),
    both: () => videos,
    show,
    hide,
    release,
  };
};
