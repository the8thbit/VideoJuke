/**
 * One place that knows which element ids the markup provides.
 *
 * The legacy clients called getElementById at the top of every component and
 * then guarded each use with `if (this.someElement)`. Resolving the whole set
 * once, up front, turns a missing id into a single clear failure at startup
 * instead of silent no-ops scattered through the player.
 */
export interface PlayerElements {
  readonly videos: readonly [HTMLVideoElement, HTMLVideoElement];
  readonly loadingScreen: HTMLElement;
  readonly loadingSubtitle: HTMLElement;
  readonly loadingProgress: HTMLElement;
  readonly infoOverlay: HTMLElement;
  readonly videoTitle: HTMLElement;
  readonly videoDetails: HTMLElement;
  readonly errorOverlay: HTMLElement;
  readonly errorMessage: HTMLElement;
  readonly statusIndicator: HTMLElement;
  readonly statusIcon: HTMLElement;
  readonly controlsOverlay: HTMLElement | null;
  readonly debugOverlay: HTMLElement | null;
  readonly debugFields: DebugFields;
  /** Present only in the browser client, which must wait for a user gesture. */
  readonly startButton: HTMLButtonElement | null;
  /** Present only in the browser client. */
  readonly connectionStatus: HTMLElement | null;
}

export interface DebugFields {
  readonly queue: HTMLElement | null;
  readonly history: HTMLElement | null;
  readonly currentVideo: HTMLElement | null;
  readonly playback: HTMLElement | null;
  readonly effects: HTMLElement | null;
  readonly session: HTMLElement | null;
  readonly connection: HTMLElement | null;
}

export class MissingElementError extends Error {
  constructor(readonly elementId: string) {
    super(`The page is missing a required element: #${elementId}`);
    this.name = 'MissingElementError';
  }
}

export const findElement = <TElement extends HTMLElement>(
  root: Document,
  id: string,
): TElement | null => root.getElementById(id) as TElement | null;

export const requireElement = <TElement extends HTMLElement>(
  root: Document,
  id: string,
): TElement => {
  const element = findElement<TElement>(root, id);
  if (element === null) throw new MissingElementError(id);
  return element;
};

const queryDebugFields = (root: Document): DebugFields => ({
  queue: findElement(root, 'debugQueue'),
  history: findElement(root, 'debugHistory'),
  currentVideo: findElement(root, 'debugCurrentVideo'),
  playback: findElement(root, 'debugPlayback'),
  effects: findElement(root, 'debugEffects'),
  session: findElement(root, 'debugSession'),
  connection: findElement(root, 'debugConnection'),
});

export const queryPlayerElements = (root: Document): PlayerElements => ({
  videos: [
    requireElement<HTMLVideoElement>(root, 'video1'),
    requireElement<HTMLVideoElement>(root, 'video2'),
  ],
  loadingScreen: requireElement(root, 'loadingScreen'),
  loadingSubtitle: requireElement(root, 'loadingSubtitle'),
  loadingProgress: requireElement(root, 'loadingProgress'),
  infoOverlay: requireElement(root, 'infoOverlay'),
  videoTitle: requireElement(root, 'videoTitle'),
  videoDetails: requireElement(root, 'videoDetails'),
  errorOverlay: requireElement(root, 'errorOverlay'),
  errorMessage: requireElement(root, 'errorMessage'),
  statusIndicator: requireElement(root, 'statusIndicator'),
  statusIcon: requireElement(root, 'statusIcon'),
  controlsOverlay: findElement(root, 'controlsOverlay'),
  debugOverlay: findElement(root, 'debugOverlay'),
  debugFields: queryDebugFields(root),
  startButton: findElement<HTMLButtonElement>(root, 'startButton'),
  connectionStatus: findElement(root, 'connectionStatus'),
});

/** Toggles a class, returning whether the element now has it. */
export const setClass = (element: Element, className: string, present: boolean): boolean => {
  if (present) element.classList.add(className);
  else element.classList.remove(className);
  return present;
};

export const setText = (element: Element | null, text: string): void => {
  if (element !== null) element.textContent = text;
};
