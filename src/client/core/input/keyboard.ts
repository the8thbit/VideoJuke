import type { Logger } from '../../../shared/types/logging';
import { isPanelCommand, type CommandDispatcher, type PlayerCommand } from './commands';

/**
 * Keys the player answers, indexed by the lower-cased `event.key`.
 *
 * Keeping the bindings as data rather than as a switch means the table can be
 * read by anything that wants to describe the controls, and it is the reason a
 * key is looked up exactly once per event instead of being compared eighteen
 * times.
 */
export const KEY_COMMANDS: Readonly<Record<string, PlayerCommand>> = {
  ' ': 'play-pause',
  n: 'next',
  p: 'previous',
  r: 'restart',
  l: 'toggle-loop',
  m: 'toggle-mute',
  f: 'toggle-crossfade',
  b: 'toggle-blur',
  a: 'toggle-archive',
  arrowup: 'speed-up',
  arrowdown: 'speed-down',
  '0': 'reset-speed',
  arrowright: 'skip-forward',
  arrowleft: 'skip-backward',
  i: 'show-info',
  t: 'show-title',
  q: 'toggle-debug',
  o: 'toggle-options',
  '?': 'toggle-controls',
  '/': 'toggle-controls',
  escape: 'exit',
};

/**
 * Whether a key press belongs to a form field rather than to the player:
 * typing "n" into the options panel must not skip a video.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }
  return element.isContentEditable === true;
};

/**
 * Binds the keyboard to a dispatcher and returns the matching detach function.
 *
 * The legacy version registered its context menu and drag handlers with inline
 * arrow functions it kept no reference to, so `cleanup` removed the key handler
 * and left the other three attached to the document for the life of the page.
 */
export const attachKeyboardControls = (options: {
  readonly target: Document;
  readonly dispatch: CommandDispatcher;
  readonly logger: Logger;
  /**
   * True while the options panel is open. Only the commands that close it are
   * passed on, and every other key is left to the panel and the browser.
   */
  readonly isSuspended?: () => boolean;
}): (() => void) => {
  const { target, dispatch, logger, isSuspended } = options;

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something nearer the key - the options panel - has already answered it.
    if (event.defaultPrevented) return;
    if (isEditableTarget(event.target)) return;

    // A modifier means the key belongs to the browser or the OS, not to us.
    // Without this, Ctrl+R reloaded nothing and restarted the video instead,
    // Ctrl+P opened no print dialog and stepped backwards, and Cmd+Q neither
    // quit nor toggled the debug panel - every one of them swallowed by the
    // `preventDefault` below.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const command = KEY_COMMANDS[event.key.toLowerCase()];
    if (command === undefined) return;
    if (isSuspended !== undefined && isSuspended() && !isPanelCommand(command)) return;

    // Only a bound key is swallowed, so the browser's own shortcuts still work.
    event.preventDefault();
    logger.debug(`key ${event.key} requested ${command}`);
    dispatch(command);
  };

  // A jukebox on a screen is not a document to be dragged into or right-clicked.
  const suppress = (event: Event): void => {
    event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('contextmenu', suppress);
  target.addEventListener('dragover', suppress);
  target.addEventListener('drop', suppress);
  logger.debug('keyboard controls attached');

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('contextmenu', suppress);
    target.removeEventListener('dragover', suppress);
    target.removeEventListener('drop', suppress);
    logger.debug('keyboard controls detached');
  };
};
